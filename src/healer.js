/**
 * healer.js – Session file monitor and repair daemon.
 *
 * Scans ~/.openclaw/agents/ (recursive) for session .jsonl files.
 * Detects:
 *   - unparseable JSON lines
 *   - tool_use without matching tool_result
 *   - files over 2MB
 *   - stale .jsonl.lock files
 */
import {
  readdirSync, statSync, readFileSync, writeFileSync,
  unlinkSync, renameSync, existsSync,
} from 'fs';
import { join } from 'path';
import { config }             from './config.js';
import { logger }             from './logger.js';
import { readPersistedState } from './state.js';

const MAX_SIZE   = config.healer.maxFileSizeBytes;
const STALE_LOCK = config.healer.staleLockMinutes * 60 * 1000;
const ARCHIVE    = config.healer.archiveCorrupted;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runOnce() {
  const ps = readPersistedState();
  const inCooldown = ps?.cooldown === true;

  if (inCooldown) {
    logger.warn('Healer: proxy in cooldown – skipping repairs');
  }

  for (const baseDir of config.healer.sessionDirs) {
    if (!existsSync(baseDir)) continue;
    const files = findFiles(baseDir);

    for (const file of files) {
      if (file.endsWith('.jsonl.lock')) {
        handleLock(file);
        continue;
      }
      if (!file.endsWith('.jsonl')) continue;
      if (inCooldown) {
        logger.info('Cooldown – skip', { file });
        continue;
      }
      healFile(file);
    }
  }
}

export function startDaemon() {
  logger.info('Healer daemon started', { intervalMs: config.healer.pollIntervalMs });
  runOnce();
  setInterval(runOnce, config.healer.pollIntervalMs);
}

// ─── File discovery ───────────────────────────────────────────────────────────

function findFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) findFiles(full, out);
    else if (e.endsWith('.jsonl') || e.endsWith('.jsonl.lock')) out.push(full);
  }
  return out;
}

// ─── Stale lock ───────────────────────────────────────────────────────────────

function handleLock(lockPath) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > STALE_LOCK) {
      unlinkSync(lockPath);
      logger.warn('Removed stale lock', { lockPath, ageMs: age });
    }
  } catch (e) {
    logger.error('Lock error', { lockPath, error: e.message });
  }
}

// ─── Repair ───────────────────────────────────────────────────────────────────

function healFile(filePath) {
  let st;
  try { st = statSync(filePath); } catch { return; }

  if (st.size > MAX_SIZE) {
    logger.warn('File too large – removing', { filePath, sizeBytes: st.size });
    drop(filePath);
    return;
  }

  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return; }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const { valid, changed } = repairLines(lines, filePath);
  if (!changed) return;

  if (valid.length === 0) {
    logger.warn('Unrepairable – removing', { filePath });
    drop(filePath);
    return;
  }

  try {
    writeFileSync(filePath, valid.join('\n') + '\n');
    logger.info('Repaired', { filePath, before: lines.length, after: valid.length });
  } catch (e) {
    logger.error('Write failed', { filePath, error: e.message });
  }
}

function repairLines(lines, filePath) {
  // Pass 1: drop invalid JSON
  const valid = [];
  let changed = false;
  for (const line of lines) {
    try { JSON.parse(line); valid.push(line); }
    catch {
      logger.warn('Bad JSON line dropped', { filePath, preview: line.slice(0, 80) });
      changed = true;
    }
  }

  // Pass 2: orphaned tool_use check
  const uses = new Set();
  const results = new Set();
  for (const line of valid) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(e.content) ? e.content : [];
    for (const b of content) {
      if (b?.type === 'tool_use')    uses.add(b.id);
      if (b?.type === 'tool_result') results.add(b.tool_use_id);
    }
    if (e.type === 'tool_use')    uses.add(e.id);
    if (e.type === 'tool_result') results.add(e.tool_use_id);
  }

  const orphaned = [...uses].filter((id) => !results.has(id));
  if (orphaned.length === 0) return { valid, changed };

  logger.warn('Orphaned tool_use – removing', { filePath, orphaned });
  const cleaned = valid.filter((line) => {
    try {
      const e = JSON.parse(line);
      const content = Array.isArray(e.content) ? e.content : [];
      const bad = content.some((b) => b?.type === 'tool_use' && orphaned.includes(b.id))
               || (e.type === 'tool_use' && orphaned.includes(e.id));
      return !bad;
    } catch { return false; }
  });
  return { valid: cleaned, changed: true };
}

function drop(filePath) {
  try {
    if (ARCHIVE) {
      renameSync(filePath, filePath + '.bak');
      logger.info('Archived', { file: filePath + '.bak' });
    } else {
      unlinkSync(filePath);
      logger.info('Deleted', { filePath });
    }
  } catch (e) {
    logger.error('Delete failed', { filePath, error: e.message });
  }
}
