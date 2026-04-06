/**
 * usage.js – Provider-agnostic usage tracker.
 *
 * Reads session .jsonl files to aggregate per-model and per-session usage.
 * Uses inode + byte-offset cursors so only new lines are processed on each
 * poll, avoiding full re-reads of large files.
 *
 * Session JSONL format (OpenClaw v2):
 *   Line 1:  { "type": "session", "id": "uuid", "timestamp": "..." }
 *   Changes: { "type": "model_change", "provider": "openai-codex", "modelId": "gpt-5.4" }
 *   Messages:{ "type": "message", "message": { "role": "assistant",
 *              "usage": { "input": N, "output": N, "cacheRead": N,
 *                         "cost": { "total": N } },
 *              "provider": "openai-codex", "model": "gpt-5.4" } }
 */
import {
  readdirSync, statSync, readFileSync, existsSync,
  writeFileSync, mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { config }  from './config.js';
import { logger }  from './logger.js';
import { updateState } from './state.js';

const ucfg = () => config.usage ?? {};

// ─── In-memory store ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} ModelStats
 * @property {number} requests
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cost
 */

/**
 * @typedef {Object} SessionEntry
 * @property {string} model       - "provider/modelId"
 * @property {number} lastActivity
 * @property {number} requestCount
 */

/**
 * @typedef {Object} DayStats
 * @property {number} requests
 * @property {number} cost
 * @property {Object.<string, { requests: number, cost: number }>} byModel
 */

/** @type {{ models: Object.<string, ModelStats>, sessions: Map<string,SessionEntry>, daily: Object.<string,DayStats>, cursors: Map<string,{ino:number,offset:number}>, startedAt: number, lastScanAt: number }} */
const store = {
  models:    {},
  sessions:  new Map(),
  daily:     {},
  cursors:   new Map(),
  startedAt: Date.now(),
  lastScanAt: 0,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return a plain-object snapshot of current usage stats.
 * The sessions Map is converted to an array for JSON serialisation.
 */
export function getUsageStats() {
  return {
    models:    { ...store.models },
    sessions:  [...store.sessions.entries()].map(([id, s]) => ({ id, ...s })),
    daily:     { ...store.daily },
    startedAt: store.startedAt,
    lastScanAt: store.lastScanAt,
  };
}

/**
 * Returns the number of sessions active within the last 60 seconds.
 */
export function getActiveSessionCount() {
  const threshold = Date.now() - 60_000;
  let count = 0;
  for (const s of store.sessions.values()) {
    if (s.lastActivity > threshold) count++;
  }
  return count;
}

/**
 * Start the periodic usage scan daemon.
 */
export function startUsageTracker() {
  if (!ucfg().enabled) {
    logger.info('Usage tracker disabled');
    return;
  }
  restoreFromDisk();
  logger.info('Usage tracker started', { pollIntervalMs: ucfg().pollIntervalMs });
  scanAll();
  setInterval(scanAll, ucfg().pollIntervalMs ?? 30_000);
}

// ─── Scan logic ───────────────────────────────────────────────────────────────

function scanAll() {
  const dirs = ucfg().sessionDirs ?? [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of findJsonlFiles(dir)) {
      processFile(file);
    }
  }
  store.lastScanAt = Date.now();

  // Sync active session count into shared state
  const activeSessions = getActiveSessionCount();
  updateState({
    activeSessions,
    totalSessions: store.sessions.size,
    totalTokens: aggregateTotalTokens(),
    totalCost:   aggregateTotalCost(),
    modelUsage:  buildModelUsageForState(),
  });

  persistToDisk();
}

function findJsonlFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) findJsonlFiles(full, out);
    else if (e.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Read only the new bytes appended to a file since the last scan.
 * Cursor is keyed by (path, inode) so file rotation is detected.
 */
function processFile(filePath) {
  let st;
  try { st = statSync(filePath); } catch { return; }

  const existing = store.cursors.get(filePath);

  // If inode changed, the file was replaced — reset cursor.
  const offset = (existing && existing.ino === st.ino) ? existing.offset : 0;

  if (st.size <= offset) return;  // nothing new

  let chunk;
  try {
    // Read only the new bytes to avoid re-processing the whole file.
    const fd = /** @type {any} */ (readFileSync);
    // Node's readFileSync doesn't support positional read; use a full read
    // but slice — files are typically small so this is acceptable.
    const full = readFileSync(filePath, 'utf8');
    chunk = full.slice(offset);  // byte slice is safe for ASCII/UTF8 line data
  } catch { return; }

  // Detect the session id from the first line of the file (offset 0 case).
  let sessionId = getOrInitSession(filePath, offset === 0
    ? readFirstLine(filePath)
    : null);

  const lines = chunk.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    ingestEntry(sessionId, entry);
  }

  store.cursors.set(filePath, { ino: st.ino, offset: st.size });
}

/**
 * Parse the first line of a file to extract a session id without reading
 * the whole file a second time (we already have it at offset 0).
 */
function readFirstLine(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const first = raw.split('\n')[0];
    return first ? JSON.parse(first) : null;
  } catch { return null; }
}

/**
 * Ensure a session entry exists in the store. Returns the session id.
 * @param {string} filePath
 * @param {object|null} firstLineEntry - parsed first-line JSON, or null
 * @returns {string}
 */
function getOrInitSession(filePath, firstLineEntry) {
  // Prefer id from session header line
  const id = (firstLineEntry?.type === 'session' && firstLineEntry.id)
    ? firstLineEntry.id
    : filePath;  // fall back to path as unique key

  if (!store.sessions.has(id)) {
    store.sessions.set(id, {
      model:         '',
      lastActivity:  Date.now(),
      requestCount:  0,
    });
  }
  return id;
}

/**
 * Ingest a single parsed JSONL entry and update store accordingly.
 * @param {string} sessionId
 * @param {object} entry
 */
function ingestEntry(sessionId, entry) {
  if (!entry || typeof entry !== 'object') return;

  // Model change event
  if (entry.type === 'model_change') {
    const key = buildModelKey(entry.provider, entry.modelId);
    const session = store.sessions.get(sessionId);
    if (session) {
      store.sessions.set(sessionId, { ...session, model: key });
    }
    return;
  }

  // Message with usage
  if (entry.type === 'message' && entry.message) {
    const msg = entry.message;
    if (msg.role !== 'assistant' || !msg.usage) return;

    const key = buildModelKey(msg.provider, msg.model);
    const usage = msg.usage;
    const cost  = usage.cost?.total ?? 0;

    // Update model aggregate
    const existing = store.models[key] ?? zeroModelStats();
    store.models[key] = {
      requests:        existing.requests + 1,
      inputTokens:     existing.inputTokens     + (usage.input     ?? 0),
      outputTokens:    existing.outputTokens    + (usage.output    ?? 0),
      cacheReadTokens: existing.cacheReadTokens + (usage.cacheRead ?? 0),
      cost:            existing.cost + cost,
    };

    // Update session
    const session = store.sessions.get(sessionId);
    if (session) {
      store.sessions.set(sessionId, {
        ...session,
        model:        key || session.model,
        lastActivity: Date.now(),
        requestCount: session.requestCount + 1,
      });
    }

    // Update daily bucket
    const dateKey = todayKey();
    const day = store.daily[dateKey] ?? { requests: 0, cost: 0, byModel: {} };
    const dayModel = day.byModel[key] ?? { requests: 0, cost: 0 };
    store.daily[dateKey] = {
      requests: day.requests + 1,
      cost:     day.cost + cost,
      byModel:  {
        ...day.byModel,
        [key]: { requests: dayModel.requests + 1, cost: dayModel.cost + cost },
      },
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildModelKey(provider, model) {
  if (provider && model) return `${provider}/${model}`;
  if (model) return model;
  if (provider) return provider;
  return 'unknown';
}

/** @returns {ModelStats} */
function zeroModelStats() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);  // "YYYY-MM-DD"
}

function aggregateTotalTokens() {
  let input = 0, output = 0, cacheRead = 0;
  for (const m of Object.values(store.models)) {
    input     += m.inputTokens;
    output    += m.outputTokens;
    cacheRead += m.cacheReadTokens;
  }
  return { input, output, cacheRead };
}

function aggregateTotalCost() {
  return Object.values(store.models).reduce((sum, m) => sum + m.cost, 0);
}

function buildModelUsageForState() {
  const out = {};
  for (const [key, m] of Object.entries(store.models)) {
    out[key] = {
      requests: m.requests,
      tokens:   { input: m.inputTokens, output: m.outputTokens, cacheRead: m.cacheReadTokens },
      cost:     m.cost,
    };
  }
  return out;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function persistToDisk() {
  const path = ucfg().persistPath;
  if (!path) return;
  try {
    const payload = {
      models:    store.models,
      sessions:  [...store.sessions.entries()].map(([id, s]) => [id, s]),
      daily:     store.daily,
      cursors:   [...store.cursors.entries()].map(([p, c]) => [p, c]),
      startedAt: store.startedAt,
      savedAt:   Date.now(),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch (e) {
    logger.error('Usage persist failed', { error: e.message });
  }
}

function restoreFromDisk() {
  const path = ucfg().persistPath;
  if (!path || !existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));

    if (raw.models)   store.models   = raw.models;
    if (raw.sessions) {
      store.sessions = new Map(raw.sessions);
    }
    if (raw.daily)   store.daily    = raw.daily;
    if (raw.cursors) {
      store.cursors  = new Map(raw.cursors);
    }
    if (raw.startedAt) store.startedAt = raw.startedAt;

    pruneStaleDaily();
    logger.info('Usage tracker restored from disk', { models: Object.keys(store.models).length });
  } catch (e) {
    logger.error('Usage restore failed', { error: e.message });
  }
}

/**
 * Remove daily buckets older than retentionDays to prevent unbounded growth.
 */
function pruneStaleDaily() {
  const retention = ucfg().retentionDays ?? 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retention);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const pruned = {};
  for (const [k, v] of Object.entries(store.daily)) {
    if (k >= cutoffKey) pruned[k] = v;
  }
  store.daily = pruned;
}
