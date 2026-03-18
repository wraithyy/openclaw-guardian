/**
 * state.js – Shared in-process state for proxy; persists to JSON file for healer.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';
import { logger } from './logger.js';

const STATE_PATH = config.sharedStatePath;

// In-memory state (proxy authoritative)
export const state = {
  remainingRequests: Infinity,
  remainingTokens:   Infinity,
  resetTimestamp:    0,      // epoch ms – when rate limit resets
  cooldown:          false,  // true = blocked by 429
  queueLength:       0,
  updatedAt:         Date.now(),
};

/** Called by proxy after reading rate-limit response headers */
export function updateRateLimitHeaders(headers) {
  const rem   = parseInt(headers['anthropic-ratelimit-requests-remaining'] ?? '', 10);
  const tok   = parseInt(headers['anthropic-ratelimit-tokens-remaining']   ?? '', 10);
  const reset = headers['anthropic-ratelimit-reset'];  // ISO-8601

  if (!isNaN(rem)) state.remainingRequests = rem;
  if (!isNaN(tok))  state.remainingTokens  = tok;
  if (reset) {
    const ts = new Date(reset).getTime();
    if (!isNaN(ts)) state.resetTimestamp = ts;
  }
  state.updatedAt = Date.now();
  persistState();
}

/** Called when proxy receives HTTP 429 */
export function enterCooldown() {
  state.cooldown = true;
  state.remainingRequests = 0;
  state.updatedAt = Date.now();
  logger.warn('Rate-limit cooldown entered', { resetTimestamp: state.resetTimestamp });
  persistState();
  // Schedule automatic exit
  const delay = Math.max(state.resetTimestamp - Date.now(), 1000);
  setTimeout(exitCooldown, delay);
}

export function exitCooldown() {
  state.cooldown = false;
  logger.info('Cooldown lifted');
  persistState();
}

function persistState() {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ ...state, _savedAt: Date.now() }, null, 2));
  } catch (e) {
    logger.warn('Failed to persist state', { error: e.message });
  }
}

/** Healer reads this to know if cooldown is active (no import of proxy state needed) */
export function readPersistedState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}
