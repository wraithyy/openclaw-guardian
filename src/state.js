/**
 * state.js – Shared in-process state + persistence.
 *
 * v2: Anthropic-specific rate-limit tracking removed. Tracks healer stats
 * and usage totals populated by the usage tracker.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const PATH = config.sharedStatePath;

export const state = {
  // Healer stats (updated after each scan pass)
  healerLastRun:      null,   // ISO timestamp of last completed scan
  healerFilesScanned: 0,
  healerRepairs:      0,

  // Usage totals (populated by usage tracker)
  totalSessions:  0,
  activeSessions: 0,
  totalTokens:    { input: 0, output: 0, cacheRead: 0 },
  totalCost:      0,

  // Per-model aggregates: { "openai-codex/gpt-5.4": { requests, tokens, cost } }
  modelUsage: {},

  updatedAt: Date.now(),
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function getState() {
  return state;
}

/**
 * Shallow-merge a patch object into state and persist to disk.
 * Caller is responsible for deep merges when needed.
 */
export function updateState(patch) {
  Object.assign(state, patch);
  state.updatedAt = Date.now();
  persist();
}

export function readPersistedState() {
  if (!existsSync(PATH)) return null;
  try { return JSON.parse(readFileSync(PATH, 'utf8')); } catch { return null; }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function persist() {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify({ ...state, _at: Date.now() }, null, 2));
  } catch (_) {}
}
