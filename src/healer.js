/**
 * healer.js – Session file monitor and repair daemon.
 *
 * Scans ~/.openclaw/agents/ (recursive) for session .jsonl files.
 * Detects:
 *   - unparseable JSON lines
 *   - tool_use without matching tool_result (injects synthetic error result)
 *   - files over 2MB (suggests compaction instead of deleting)
 *   - stale .jsonl.lock files
 *
 * Respects active sessions — skips files with recent proxy activity.
 */
import {
  readdirSync, statSync, readFileSync, writeFileSync,
  unlinkSync, renameSync, existsSync,
} from 'fs';
import { join, basename } from 'path';
import { config }             from './config.js';
import { logger }             from './logger.js';
import { readPersistedState, updateState, getState } from './state.js';
import { healerMetrics }      from './metrics.js';
import { hasRecentActivity }  from './sessions.js';

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

  let scanned = 0;
  for (const baseDir of config.healer.sessionDirs) {
    if (!existsSync(baseDir)) continue;
    const files = findFiles(baseDir);

    for (const file of files) {
      if (file.endsWith('.jsonl.lock')) {
        handleLock(file);
        continue;
      }
      if (!file.endsWith('.jsonl')) continue;
      scanned++;
      if (inCooldown) {
        logger.info('Cooldown – skip', { file });
        continue;
      }

      // Active session guard: skip files with recent proxy activity
      if (hasRecentActivity(60_000)) {
        const mtime = safeStatMtime(file);
        if (mtime && (Date.now() - mtime) < 60_000) {
          logger.info('Active session – skip', { file });
          continue;
        }
      }

      healFile(file);
    }
  }

  healerMetrics.sessionsScanned = scanned;
  healerMetrics.scanRuns++;
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
      healerMetrics.staleLocksRemoved++;
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

  // Size-based: suggest compaction instead of deleting
  if (st.size > MAX_SIZE) {
    logger.warn('File too large – flagging for compaction', { filePath, sizeBytes: st.size });
    healerMetrics.compactionsSuggested = (healerMetrics.compactionsSuggested ?? 0) + 1;
    updateState({ compactionSuggested: true, compactionFile: filePath, compactionSizeBytes: st.size });
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
    healerMetrics.sessionsRepaired++;
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

  // Pass 2: orphaned tool_use check — inject synthetic error result instead of dropping
  const uses = new Map();    // id -> tool_use block
  const results = new Set();
  for (const line of valid) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(e.content) ? e.content : [];
    for (const b of content) {
      if (b?.type === 'tool_use')    uses.set(b.id, b);
      if (b?.type === 'tool_result') results.add(b.tool_use_id);
    }
    if (e.type === 'tool_use')    uses.set(e.id, e);
    if (e.type === 'tool_result') results.add(e.tool_use_id);
  }

  const orphanedIds = [...uses.keys()].filter((id) => !results.has(id));
  if (orphanedIds.length === 0) return { valid, changed };

  // Non-destructive: inject synthetic tool_result immediately after the line
  // containing each orphaned tool_use (Anthropic requires tool_result in the
  // user turn directly following the assistant turn with tool_use)
  logger.warn('Orphaned tool_use – injecting synthetic error results', { filePath, orphanedIds });

  const orphanedSet = new Set(orphanedIds);
  const repaired = [];
  for (const line of valid) {
    repaired.push(line);
    // Check if this line contains any orphaned tool_use blocks
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(e.content) ? e.content : [];
    const lineOrphans = content
      .filter((b) => b?.type === 'tool_use' && orphanedSet.has(b.id))
      .map((b) => b.id);
    // Also check top-level tool_use
    if (e.type === 'tool_use' && orphanedSet.has(e.id)) {
      lineOrphans.push(e.id);
    }
    if (lineOrphans.length > 0) {
      // Insert synthetic tool_result user turn right after this assistant turn
      const resultBlocks = lineOrphans.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        is_error: true,
        content: `[guardian-healer] Session interrupted. Tool "${uses.get(id)?.name ?? 'unknown'}" did not complete.`,
      }));
      repaired.push(JSON.stringify({ role: 'user', content: resultBlocks }));
    }
  }

  return { valid: repaired, changed: true };
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
    healerMetrics.sessionsDeleted++;
  } catch (e) {
    logger.error('Delete failed', { filePath, error: e.message });
  }
}

function safeStatMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}
