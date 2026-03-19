/**
 * state.js – Shared in-process state + persistence for healer.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const PATH = config.sharedStatePath;

export const state = {
  remainingRequests: null,
  remainingTokens:   null,
  resetTimestamp:    null,
  cooldown:          false,
  cooldownUntil:     null,
  queueLength:       0,
  totalRequests:     0,
  totalThrottles:    0,
  total429s:         0,
  updatedAt:         Date.now(),
};

let cooldownTimer = null;

export function updateRateLimitHeaders(headers) {
  const rem   = parseInt(headers['anthropic-ratelimit-requests-remaining'] ?? '', 10);
  const tok   = parseInt(headers['anthropic-ratelimit-tokens-remaining']   ?? '', 10);
  const reset = headers['anthropic-ratelimit-reset'];
  if (!isNaN(rem)) state.remainingRequests = rem;
  if (!isNaN(tok))  state.remainingTokens  = tok;
  if (reset) { const ts = new Date(reset).getTime(); if (!isNaN(ts)) state.resetTimestamp = ts; }
  state.updatedAt = Date.now();
  persist();
}

export function enterCooldown() {
  state.cooldown = true;
  state.remainingRequests = 0;
  state.updatedAt = Date.now();
  persist();
  if (cooldownTimer) clearTimeout(cooldownTimer);
  const resetTs = state.resetTimestamp ? state.resetTimestamp : Date.now() + 30_000;
  const delay = Math.max(resetTs - Date.now(), 1000);
  cooldownTimer = setTimeout(exitCooldown, delay);
}

export function exitCooldown() {
  state.cooldown = false;
  state.updatedAt = Date.now();
  persist();
}

function persist() {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify({ ...state, _at: Date.now() }, null, 2));
  } catch (_) {}
}

export function getState() {
  return state;
}

export function updateState(patch) {
  Object.assign(state, patch);
  persist();
}

export function readPersistedState() {
  if (!existsSync(PATH)) return null;
  try { return JSON.parse(readFileSync(PATH, 'utf8')); } catch { return null; }
}
