/**
 * metrics.js – Prometheus text-format renderer + healer counters.
 */
import { getState } from './state.js';

/** Updated by healer.js after each scan pass. */
export const healerMetrics = {
  sessionsScanned:   0,
  sessionsRepaired:  0,
  sessionsDeleted:   0,
  staleLocksRemoved: 0,
  scanRuns:          0,
};

export function renderPrometheus() {
  const s = getState();
  const h = healerMetrics;
  const lines = [];

  function gauge(name, help, value) {
    if (value === null || value === undefined) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  function counter(name, help, value) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name}_total ${value}`);
  }

  gauge('guardian_remaining_requests', 'Requests left in current rate-limit window',        s.remainingRequests ?? -1);
  gauge('guardian_remaining_tokens',   'Tokens left in current rate-limit window',          s.remainingTokens   ?? -1);
  gauge('guardian_cooldown',           '1 = proxy in cooldown, 0 = normal',                 s.cooldown ? 1 : 0);
  // Unified rate-limit metrics
  gauge('guardian_unified_5h_utilization', 'Anthropic unified 5h token utilization (0-1)', s.unified5hUtil);
  gauge('guardian_unified_7d_utilization', 'Anthropic unified 7d token utilization (0-1)', s.unified7dUtil);
  gauge('guardian_unified_throttled',      '1 = unified status throttled/blocked, 0 = allowed',
    s.unifiedStatus == null ? null : (s.unifiedStatus === 'allowed' ? 0 : 1));
  gauge('guardian_queue_length',       'Pending requests in proxy queue',                   s.queueLength);
  gauge('guardian_sessions_scanned',   'Session files scanned in last healer pass',         h.sessionsScanned);
  gauge('guardian_at_risk',            '1 = healer paused due to cooldown, 0 = normal',     s.cooldown ? 1 : 0);

  counter('guardian_requests',           'Total requests forwarded to Anthropic',           s.totalRequests);
  counter('guardian_throttles',          'Times throttle delay was applied',                s.totalThrottles);
  counter('guardian_429s',               'Times 429 received from Anthropic',               s.total429s);
  counter('guardian_sessions_repaired',  'Session files successfully repaired by healer',   h.sessionsRepaired);
  counter('guardian_sessions_deleted',   'Session files deleted as unrepairable by healer', h.sessionsDeleted);
  counter('guardian_stale_locks_removed','Stale lock files removed by healer',              h.staleLocksRemoved);
  counter('guardian_scan_runs',          'Total healer scan runs completed',                h.scanRuns);

  return lines.join('\n') + '\n';
}
