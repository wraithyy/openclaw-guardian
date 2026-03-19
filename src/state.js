/**
 * state.js – Shared in-process state + persistence for healer.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const PATH = config.sharedStatePath;

export const state = {
  remainingRequests:  null,
  remainingTokens:    null,
  resetTimestamp:     null,
  cooldown:           false,
  cooldownUntil:      null,
  queueLength:        0,
  totalRequests:      0,
  totalThrottles:     0,
  total429s:          0,
  // Unified rate-limit (new Anthropic system)
  unifiedStatus:      null,   // 'allowed' | 'throttled' | 'blocked'
  unified5hUtil:      null,   // 0.0 – 1.0
  unified7dUtil:      null,   // 0.0 – 1.0
  unifiedReset:       null,   // unix timestamp ms
  updatedAt:          Date.now(),
};

let cooldownTimer = null;

export function updateRateLimitHeaders(headers) {
  // Legacy per-resource headers (old system)
  const rem   = parseInt(headers['anthropic-ratelimit-requests-remaining'] ?? '', 10);
  const tok   = parseInt(headers['anthropic-ratelimit-tokens-remaining']   ?? '', 10);
  const reset = headers['anthropic-ratelimit-reset'];
  if (!isNaN(rem)) state.remainingRequests = rem;
  if (!isNaN(tok))  state.remainingTokens  = tok;
  if (reset) { const ts = new Date(reset).getTime(); if (!isNaN(ts)) state.resetTimestamp = ts; }

  // New unified rate-limit system
  const uStatus  = headers['anthropic-ratelimit-unified-status'];
  const u5hUtil  = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']  ?? '');
  const u7dUtil  = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']  ?? '');
  const uReset   = headers['anthropic-ratelimit-unified-reset'];
  if (uStatus)       state.unifiedStatus  = uStatus;
  if (!isNaN(u5hUtil)) state.unified5hUtil = u5hUtil;
  if (!isNaN(u7dUtil)) state.unified7dUtil = u7dUtil;
  if (uReset) { const ts = parseInt(uReset, 10) * 1000; if (!isNaN(ts)) state.unifiedReset = ts; }

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
