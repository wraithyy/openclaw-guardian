/**
 * metrics.js – Prometheus text-format renderer + healer counters.
 *
 * v2: Provider-agnostic. Renders per-model usage from usage tracker,
 * healer stats, and daily cost/request gauges. No Anthropic-specific metrics.
 */
import { getState }     from './state.js';
import { getUsageStats } from './usage.js';

/** Updated by healer.js after each scan pass. */
export const healerMetrics = {
  sessionsScanned:      0,
  sessionsRepaired:     0,
  sessionsDeleted:      0,
  staleLocksRemoved:    0,
  scanRuns:             0,
  compactionsSuggested: 0,
};

// ─── Renderer ─────────────────────────────────────────────────────────────────

export function renderPrometheus() {
  const s     = getState();
  const h     = healerMetrics;
  const usage = getUsageStats();
  const lines = [];

  // Track which metric names have had their HELP/TYPE header emitted.
  const declared = new Set();

  function header(type, name, help) {
    if (declared.has(name)) return;
    declared.add(name);
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  function gauge(name, help, value, labels = '') {
    if (value === null || value === undefined) return;
    header('gauge', name, help);
    const labelStr = labels ? `{${labels}}` : '';
    lines.push(`${name}${labelStr} ${value}`);
  }

  function counter(name, help, value, labels = '') {
    header('counter', name, help);
    const labelStr = labels ? `{${labels}}` : '';
    lines.push(`${name}_total${labelStr} ${value}`);
  }

  // ─── Session / healer gauges ───────────────────────────────────────────────
  gauge('guardian_active_sessions',    'Currently active sessions (activity in last 60s)', s.activeSessions ?? 0);
  gauge('guardian_healer_files_scanned','Session files scanned in last healer pass',        h.sessionsScanned);
  gauge('guardian_healer_at_risk',     'Always 0 in v2 (no proxy cooldown)',                0);

  // ─── Healer counters ───────────────────────────────────────────────────────
  counter('guardian_healer_repairs',              'Session files successfully repaired by healer',             h.sessionsRepaired);
  counter('guardian_healer_deletions',            'Session files deleted as unrepairable by healer',           h.sessionsDeleted);
  counter('guardian_healer_stale_locks',          'Stale lock files removed by healer',                       h.staleLocksRemoved);
  counter('guardian_healer_scans',                'Total healer scan passes completed',                        h.scanRuns);
  counter('guardian_healer_compactions_suggested','Times healer flagged an oversized file for compaction',     h.compactionsSuggested);

  // ─── Per-model metrics ─────────────────────────────────────────────────────
  for (const [model, m] of Object.entries(usage.models)) {
    const lbl = `model="${sanitizeLabel(model)}"`;
    counter('guardian_model_requests',          'Requests per model',           m.requests,         lbl);
    counter('guardian_model_input_tokens',      'Input tokens per model',       m.inputTokens,      lbl);
    counter('guardian_model_output_tokens',     'Output tokens per model',      m.outputTokens,     lbl);
    counter('guardian_model_cache_read_tokens', 'Cache read tokens per model',  m.cacheReadTokens,  lbl);
    gauge(  'guardian_model_cost',              'Cumulative cost in USD per model', m.cost,          lbl);
  }

  // ─── Daily gauges ──────────────────────────────────────────────────────────
  for (const [date, day] of Object.entries(usage.daily)) {
    const lbl = `date="${sanitizeLabel(date)}"`;
    gauge('guardian_daily_cost',     'Total cost in USD for the day',      day.cost,     lbl);
    gauge('guardian_daily_requests', 'Total request count for the day',    day.requests, lbl);
  }

  return lines.join('\n') + '\n';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeLabel(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
