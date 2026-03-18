/**
 * healer.js – Session file monitor and repair daemon.
 *
 * Scans ~/.openclaw/agents/**/sessions/*.jsonl for:
 *   - truncated / unparseable JSON lines
 *   - tool_use without matching tool_result
 *   - files >2MB
 *   - stale .jsonl.lock files
 */
import {
  readdirSync, statSync, readFileSync, writeFileSync,
  unlinkSync, renameSync, existsSync,
} from 'fs';
import { join } from 'path';
import { config }           from './config.js';
import { logger }           from './logger.js';
import { readPersistedState } from './state.js';

const MAX_SIZE   = config.healer.maxFileSizeBytes;
const STALE_LOCK = config.healer.staleLockMinutes * 60 * 1000;
const ARCHIVE    = config.healer.archiveCorrupted;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function runOnce() {
  const proxyState = readPersistedState();
  const inCooldown = proxyState?.cooldown === true;

  if (inCooldown) {
    logger.warn('Healer: proxy in cooldown – skipping repairs, sessions at risk');
  }

  for (const baseDir of config.healer.sessionDirs) {
    if (!existsSync(baseDir)) continue;
    const files = findSessionFiles(baseDir);

    for (const file of files) {
      if (file.endsWith('.jsonl.lock')) {
        handleLock(file);
        continue;
      }
      if (!file.endsWith('.jsonl')) continue;

      if (inCooldown) {
        logger.info('Healer: cooldown active – skipping repair', { file });
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

// ─────────────────────────────────────────────────────────────────────────────
// File discovery
// ─────────────────────────────────────────────────────────────────────────────

function findSessionFiles(dir, results = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }

  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory()) {
      findSessionFiles(full, results);
    } else if (entry.endsWith('.jsonl') || entry.endsWith('.jsonl.lock')) {
      results.push(full);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale lock handling
// ─────────────────────────────────────────────────────────────────────────────

function handleLock(lockPath) {
  try {
    const st  = statSync(lockPath);
    const age = Date.now() - st.mtimeMs;
    if (age > STALE_LOCK) {
      unlinkSync(lockPath);
      logger.warn('Removed stale lock file', { lockPath, ageMs: age });
    }
  } catch (e) {
    logger.error('Failed to handle lock file', { lockPath, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session file repair
// ─────────────────────────────────────────────────────────────────────────────

function healFile(filePath) {
  let st;
  try { st = statSync(filePath); } catch { return; }

  // Oversized – delete immediately
  if (st.size > MAX_SIZE) {
    logger.warn('Session file too large – removing', { filePath, sizeBytes: st.size });
    removeOrArchive(filePath);
    return;
  }

  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return; }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const { valid, changed } = repairLines(lines, filePath);

  if (!changed) return; // healthy

  if (valid.length === 0) {
    logger.warn('Session unrepairable – no valid lines', { filePath });
    removeOrArchive(filePath);
    return;
  }

  try {
    writeFileSync(filePath, valid.join('\n') + '\n');
    logger.info('Session repaired', {
      filePath,
      originalLines: lines.length,
      keptLines: valid.length,
    });
  } catch (e) {
    logger.error('Failed to write repaired session', { filePath, error: e.message });
  }
}

/**
 * Parse JSONL lines, drop invalid ones, detect orphaned tool_use.
 * Returns { valid: string[], changed: boolean }
 */
function repairLines(lines, filePath) {
  const valid = [];
  let changed = false;

  // Pass 1: drop unparseable lines
  for (const line of lines) {
    try {
      JSON.parse(line);
      valid.push(line);
    } catch {
      logger.warn('Dropping unparseable line', { filePath, preview: line.slice(0, 80) });
      changed = true;
    }
  }

  // Pass 2: collect tool_use / tool_result ids
  const toolUseIds    = new Set();
  const toolResultIds = new Set();

  for (const line of valid) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const content = Array.isArray(entry.content) ? entry.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use')    toolUseIds.add(block.id);
      if (block?.type === 'tool_result') toolResultIds.add(block.tool_use_id);
    }
    // Top-level type (less common format)
    if (entry.type === 'tool_use')    toolUseIds.add(entry.id);
    if (entry.type === 'tool_result') toolResultIds.add(entry.tool_use_id);
  }

  const orphaned = [...toolUseIds].filter((id) => !toolResultIds.has(id));

  if (orphaned.length === 0) return { valid, changed };

  logger.warn('Orphaned tool_use found – removing entries', { filePath, orphaned });

  const cleaned = valid.filter((line) => {
    try {
      const entry   = JSON.parse(line);
      const content = Array.isArray(entry.content) ? entry.content : [];
      const bad = content.some((b) => b?.type === 'tool_use' && orphaned.includes(b.id))
               || (entry.type === 'tool_use' && orphaned.includes(entry.id));
      return !bad;
    } catch {
      return false;
    }
  });

  return { valid: cleaned, changed: true };
}

function removeOrArchive(filePath) {
  try {
    if (ARCHIVE) {
      const dest = filePath + '.bak';
      renameSync(filePath, dest);
      logger.info('Session archived', { from: filePath, to: dest });
    } else {
      unlinkSync(filePath);
      logger.info('Session deleted', { filePath });
    }
  } catch (e) {
    logger.error('Failed to remove/archive session', { filePath, error: e.message });
  }
}
