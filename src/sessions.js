/**
 * sessions.js – Per-session tracking for OpenClaw requests.
 *
 * Maintains an in-memory Map of session stats, extracted from
 * Anthropic API request/response bodies flowing through the proxy.
 */
import { config } from './config.js';
import { logger } from './logger.js';

const scfg = () => config.sessionTracking ?? {};

/** @type {Map<string, SessionStats>} */
const sessions = new Map();

/**
 * @typedef {Object} SessionStats
 * @property {number} requestCount
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} errorCount
 * @property {number} consecutiveErrors
 * @property {number} lastActivityAt
 * @property {boolean} isCron
 */

function newStats(isCron = false) {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    lastActivityAt: Date.now(),
    isCron,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract session ID from a parsed request body.
 * Anthropic Messages API: metadata.user_id
 */
export function extractSessionId(body) {
  if (!body) return null;
  return body?.metadata?.user_id ?? null;
}

/**
 * Detect if request is a cron job via header.
 */
export function isCronRequest(headers) {
  const headerName = scfg().cronHeaderName ?? 'x-openclaw-job-id';
  return !!headers[headerName.toLowerCase()];
}

/**
 * Track an outgoing request for a session.
 */
export function trackRequest(sessionId, isCron = false) {
  if (!scfg().enabled || !sessionId) return;
  evictStale();
  let s = sessions.get(sessionId);
  if (!s) {
    s = newStats(isCron);
    sessions.set(sessionId, s);
  }
  s.requestCount++;
  s.lastActivityAt = Date.now();
  if (isCron) s.isCron = true;
}

/**
 * Track response usage for a session.
 */
export function trackResponse(sessionId, usage, isError = false) {
  if (!scfg().enabled || !sessionId) return;
  const s = sessions.get(sessionId);
  if (!s) return;

  if (usage) {
    s.inputTokens += usage.input_tokens ?? 0;
    s.outputTokens += usage.output_tokens ?? 0;
    s.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    s.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  }

  if (isError) {
    s.errorCount++;
    s.consecutiveErrors++;
  } else {
    s.consecutiveErrors = 0;
  }
  s.lastActivityAt = Date.now();
}

/**
 * Check if a session has had recent activity (within thresholdMs).
 * Used by healer to avoid touching active session files.
 */
export function isSessionActive(sessionId, thresholdMs = 60_000) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  return (Date.now() - s.lastActivityAt) < thresholdMs;
}

/**
 * Check if any tracked session has had activity within thresholdMs.
 * Used by healer as a broader "is anything active" check.
 */
export function hasRecentActivity(thresholdMs = 60_000) {
  for (const s of sessions.values()) {
    if ((Date.now() - s.lastActivityAt) < thresholdMs) return true;
  }
  return false;
}

/**
 * Get all tracked sessions for metrics.
 * Returns a shallow copy of the map entries.
 */
export function getTrackedSessions() {
  return new Map(sessions);
}

/**
 * Get count of tracked sessions.
 */
export function trackedSessionCount() {
  return sessions.size;
}

// ─── Eviction ─────────────────────────────────────────────────────────────────

function evictStale() {
  const max = scfg().maxTrackedSessions ?? 50;
  const ttl = (scfg().sessionTtlMinutes ?? 60) * 60_000;
  const now = Date.now();

  // Remove expired sessions
  for (const [id, s] of sessions) {
    if (now - s.lastActivityAt > ttl) {
      sessions.delete(id);
    }
  }

  // If still over max, remove oldest
  if (sessions.size > max) {
    const sorted = [...sessions.entries()].sort(
      (a, b) => a[1].lastActivityAt - b[1].lastActivityAt
    );
    const toRemove = sorted.slice(0, sessions.size - max);
    for (const [id] of toRemove) {
      sessions.delete(id);
    }
  }
}
