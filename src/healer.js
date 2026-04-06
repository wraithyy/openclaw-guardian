/**
 * healer.js – Session file monitor and repair daemon.
 *
 * Scans configured session dirs (recursive) for .jsonl files and:
 *   - Drops unparseable JSON lines
 *   - Injects synthetic error results for orphaned tool calls
 *   - Flags oversized files for compaction (never deletes them)
 *   - Removes stale .jsonl.lock files
 *
 * Provider-agnostic (v2): supports both OpenClaw toolCall/role:tool format
 * and Anthropic tool_use/tool_result format. Active session detection is
 * based purely on file mtime (no proxy required).
 */
import {
  readdirSync, statSync, readFileSync, writeFileSync,
  unlinkSync, renameSync, existsSync,
} from 'fs';
import { join } from 'path';
import { config }        from './config.js';
import { logger }        from './logger.js';
import { updateState }   from './state.js';
import { healerMetrics } from './metrics.js';

const MAX_SIZE   = config.healer.maxFileSizeBytes;
const STALE_LOCK = config.healer.staleLockMinutes * 60 * 1000;
const ARCHIVE    = config.healer.archiveCorrupted;

// Files modified within this window are considered active and are skipped.
const ACTIVE_WINDOW_MS = 60_000;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runOnce() {
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

      // Skip files modified very recently — likely an active session write.
      const mtime = safeStatMtime(file);
      if (mtime && (Date.now() - mtime) < ACTIVE_WINDOW_MS) {
        logger.info('Active session – skip', { file });
        continue;
      }

      healFile(file);
    }
  }

  healerMetrics.sessionsScanned = scanned;
  healerMetrics.scanRuns++;
  updateState({
    healerLastRun:      new Date().toISOString(),
    healerFilesScanned: scanned,
    healerRepairs:      healerMetrics.sessionsRepaired,
  });
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

  // Oversized: flag for compaction, do not delete.
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

/**
 * Two-pass repair:
 *   Pass 1 – drop lines with invalid JSON.
 *   Pass 2 – find orphaned tool calls and inject synthetic error results.
 *
 * Supports two formats:
 *   OpenClaw: content[].type === "toolCall" / role:"tool" + tool_call_id
 *   Anthropic: content[].type === "tool_use" / content[].type === "tool_result"
 *
 * @param {string[]} lines
 * @param {string} filePath
 * @returns {{ valid: string[], changed: boolean }}
 */
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

  // Pass 2: orphaned tool call detection
  //
  // toolCalls  : id -> { format: 'openclaw' | 'anthropic', name }
  // results    : Set of ids that have a matching result
  const toolCalls = new Map();
  const results   = new Set();

  for (const line of valid) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    // Unwrap OpenClaw session envelope: { type:"message", message:{...} }
    const msg = (entry.type === 'message' && entry.message) ? entry.message : entry;

    const content = Array.isArray(msg.content) ? msg.content : [];

    for (const block of content) {
      // OpenClaw format
      if (block?.type === 'toolCall' && block.id) {
        toolCalls.set(block.id, { format: 'openclaw', name: block.name });
      }
      // Anthropic format
      if (block?.type === 'tool_use' && block.id) {
        toolCalls.set(block.id, { format: 'anthropic', name: block.name });
      }
      // Anthropic tool_result (inside user message content array)
      if (block?.type === 'tool_result' && block.tool_use_id) {
        results.add(block.tool_use_id);
      }
    }

    // OpenClaw tool result: role:"tool" + tool_call_id at message level
    if (msg.role === 'tool' && msg.tool_call_id) {
      results.add(msg.tool_call_id);
    }
  }

  const orphanIds = [...toolCalls.keys()].filter((id) => !results.has(id));
  if (orphanIds.length === 0) return { valid, changed };

  logger.warn('Orphaned tool calls – injecting synthetic error results', { filePath, orphanIds });

  const orphanSet = new Set(orphanIds);
  const repaired  = [];

  for (const line of valid) {
    repaired.push(line);

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const msg = (entry.type === 'message' && entry.message) ? entry.message : entry;
    const content = Array.isArray(msg.content) ? msg.content : [];

    // Collect all orphaned tool calls referenced in this line.
    const lineOrphans = content
      .filter((b) => (b?.type === 'toolCall' || b?.type === 'tool_use') && orphanSet.has(b.id))
      .map((b) => ({ id: b.id, ...toolCalls.get(b.id) }));

    if (lineOrphans.length === 0) continue;

    // Inject one synthetic result per orphaned call, matching the source format.
    for (const { id, format, name } of lineOrphans) {
      const errorText = `[guardian-healer] Session interrupted. Tool "${name ?? 'unknown'}" did not complete.`;

      if (format === 'openclaw') {
        // OpenClaw expects a separate message with role:"tool"
        const syntheticMsg = {
          type: 'message',
          message: {
            role:         'tool',
            tool_call_id: id,
            content:      errorText,
          },
        };
        repaired.push(JSON.stringify(syntheticMsg));
      } else {
        // Anthropic expects role:"user" with tool_result content block
        const syntheticMsg = {
          type: 'message',
          message: {
            role: 'user',
            content: [{
              type:        'tool_result',
              tool_use_id: id,
              is_error:    true,
              content:     errorText,
            }],
          },
        };
        repaired.push(JSON.stringify(syntheticMsg));
      }
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
