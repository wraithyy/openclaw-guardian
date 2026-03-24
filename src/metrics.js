/**
 * metrics.js – Prometheus text-format renderer + healer counters.
 *
 * Includes per-session metrics from session tracking.
 */
import { getState } from './state.js';
import { getTrackedSessions, trackedSessionCount } from './sessions.js';

/** Updated by healer.js after each scan pass. */
export const healerMetrics = {
  sessionsScanned:   0,
  sessionsRepaired:  0,
  sessionsDeleted:   0,
  staleLocksRemoved: 0,
  scanRuns:          0,
  compactionsSuggested: 0,
};

export function renderPrometheus() {
  const s = getState();
  const h = healerMetrics;
  const lines = [];

  function gauge(name, help, value, labels = '') {
    if (value === null || value === undefined) return;
    if (labels && !lines.some(l => l.startsWith(`# HELP ${name}`))) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
    } else if (!labels) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
    }
    const labelStr = labels ? `{${labels}}` : '';
    lines.push(`${name}${labelStr} ${value}`);
  }

  function counter(name, help, value, labels = '') {
    if (!lines.some(l => l.startsWith(`# HELP ${name}`))) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
    }
    const labelStr = labels ? `{${labels}}` : '';
    lines.push(`${name}_total${labelStr} ${value}`);
  }

  // ─── Global metrics ─────────────────────────────────────────────────────────
  gauge('guardian_remaining_requests', 'Requests left in current rate-limit window',        s.remainingRequests ?? -1);
  gauge('guardian_remaining_tokens',   'Tokens left in current rate-limit window',          s.remainingTokens   ?? -1);
  gauge('guardian_cooldown',           '1 = proxy in cooldown, 0 = normal',                 s.cooldown ? 1 : 0);
  gauge('guardian_unified_5h_utilization', 'Anthropic unified 5h token utilization (0-1)', s.unified5hUtil);
  gauge('guardian_unified_7d_utilization', 'Anthropic unified 7d token utilization (0-1)', s.unified7dUtil);
  gauge('guardian_unified_throttled',      '1 = unified status throttled/blocked, 0 = allowed',
    s.unifiedStatus == null ? null : (s.unifiedStatus === 'allowed' ? 0 : 1));
  gauge('guardian_queue_length',       'Pending requests in proxy queue',                   s.queueLength);
  gauge('guardian_sessions_scanned',   'Session files scanned in last healer pass',         h.sessionsScanned);
  gauge('guardian_at_risk',            '1 = healer paused due to cooldown, 0 = normal',     s.cooldown ? 1 : 0);
  gauge('guardian_tracked_sessions',   'Number of currently tracked sessions',              trackedSessionCount());

  counter('guardian_requests',           'Total requests forwarded to Anthropic',           s.totalRequests);
  counter('guardian_throttles',          'Times throttle delay was applied',                s.totalThrottles);
  counter('guardian_429s',               'Times 429 received from Anthropic',               s.total429s);
  counter('guardian_sessions_repaired',  'Session files successfully repaired by healer',   h.sessionsRepaired);
  counter('guardian_sessions_deleted',   'Session files deleted as unrepairable by healer', h.sessionsDeleted);
  counter('guardian_stale_locks_removed','Stale lock files removed by healer',              h.staleLocksRemoved);
  counter('guardian_scan_runs',          'Total healer scan runs completed',                h.scanRuns);
  counter('guardian_compactions_suggested', 'Times healer suggested compaction instead of deleting', h.compactionsSuggested);

  // ─── Per-session metrics ────────────────────────────────────────────────────
  const tracked = getTrackedSessions();
  if (tracked.size > 0) {
    lines.push('');
    lines.push('# HELP guardian_session_requests Per-session request count');
    lines.push('# TYPE guardian_session_requests counter');
    lines.push('# HELP guardian_session_input_tokens Per-session input tokens consumed');
    lines.push('# TYPE guardian_session_input_tokens counter');
    lines.push('# HELP guardian_session_output_tokens Per-session output tokens consumed');
    lines.push('# TYPE guardian_session_output_tokens counter');
    lines.push('# HELP guardian_session_cache_read_tokens Per-session cache read tokens');
    lines.push('# TYPE guardian_session_cache_read_tokens counter');
    lines.push('# HELP guardian_session_errors Per-session error count');
    lines.push('# TYPE guardian_session_errors counter');

    for (const [sid, ss] of tracked) {
      const lbl = `session_id="${sanitizeLabel(sid)}",is_cron="${ss.isCron}"`;
      lines.push(`guardian_session_requests_total{${lbl}} ${ss.requestCount}`);
      lines.push(`guardian_session_input_tokens_total{${lbl}} ${ss.inputTokens}`);
      lines.push(`guardian_session_output_tokens_total{${lbl}} ${ss.outputTokens}`);
      lines.push(`guardian_session_cache_read_tokens_total{${lbl}} ${ss.cacheReadTokens}`);
      lines.push(`guardian_session_errors_total{${lbl}} ${ss.errorCount}`);
    }
  }

  return lines.join('\n') + '\n';
}

function sanitizeLabel(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
