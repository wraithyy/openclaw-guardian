/**
 * metrics.js – Prometheus text format + optional Grafana Cloud push (Mimir + Loki).
 *
 * Scrape endpoint: GET /metrics (served by proxy)
 *
 * Grafana Cloud push – add to guardian.config.json:
 * {
 *   "grafana": {
 *     "enabled": true,
 *     "mimirUrl":  "https://prometheus-prod-XX.grafana.net/api/prom/push",
 *     "lokiUrl":   "https://logs-prod-XX.grafana.net/loki/api/v1/push",
 *     "user":      "123456",
 *     "token":     "glc_...",
 *     "pushIntervalMs": 15000
 *   }
 * }
 */
import { request as httpsRequest } from 'https';
import { config }  from './config.js';
import { state }   from './state.js';
import { logger }  from './logger.js';

// ── In-process metric store ────────────────────────────────────────────────

const _gauges   = new Map();
const _counters = new Map();

function key(name, labels = {}) {
  const lstr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  return lstr ? `${name}{${lstr}}` : name;
}

export const metrics = {
  setGauge(name, value, labels = {})  { _gauges.set(key(name, labels),   { name, value, labels }); },
  incCounter(name, by = 1, labels = {}) {
    const k = key(name, labels);
    const e = _counters.get(k) ?? { name, value: 0, labels };
    e.value += by;
    _counters.set(k, e);
  },
  counterValue(name, labels = {}) { return _counters.get(key(name, labels))?.value ?? 0; },
};

// ── Prometheus text rendering ──────────────────────────────────────────────

export function renderPrometheus() {
  const lines = ['# openclaw_guardian metrics'];
  for (const { name, value, labels } of _gauges.values()) {
    lines.push(`# TYPE ${name} gauge`, `${key(name, labels)} ${value}`);
  }
  for (const { name, value, labels } of _counters.values()) {
    lines.push(`# TYPE ${name} counter`, `${key(name, labels)} ${value}`);
  }
  return lines.join('\n') + '\n';
}

// ── Grafana Cloud exporter ─────────────────────────────────────────────────

export class GrafanaExporter {
  constructor() {
    this._cfg   = config.grafana;
    this._timer = null;
  }

  start() {
    if (!this._cfg?.enabled) return;
    const iv = this._cfg.pushIntervalMs ?? 15000;
    logger.info('metrics', `Grafana exporter started (every ${iv}ms)`);
    this._timer = setInterval(() => this._push(), iv);
    this._timer.unref?.();
  }

  stop() { if (this._timer) clearInterval(this._timer); }

  async _push() {
    try { await Promise.allSettled([this._mimir(), this._loki()]); }
    catch (e) { logger.warn('metrics', 'Grafana push error', { err: e.message }); }
  }

  _mimir() {
    if (!this._cfg?.mimirUrl) return;
    const s   = state.get();
    const now = Date.now();
    const body = [
      `guardian_remaining_requests ${s.remainingRequests ?? -1} ${now}`,
      `guardian_remaining_tokens   ${s.remainingTokens   ?? -1} ${now}`,
      `guardian_cooldown           ${s.cooldown ? 1 : 0}  ${now}`,
      `guardian_queue_length       ${s.queueLength ?? 0}  ${now}`,
      `guardian_total_requests     ${s.totalRequests ?? 0} ${now}`,
      `guardian_total_throttles    ${s.totalThrottles ?? 0} ${now}`,
      `guardian_total_429s         ${s.total429s ?? 0} ${now}`,
    ].join('\n') + '\n';
    return this._post(this._cfg.mimirUrl, body, 'text/plain');
  }

  _loki() {
    if (!this._cfg?.lokiUrl) return;
    const s = state.get();
    const ns = (BigInt(Date.now()) * 1_000_000n).toString();
    const payload = JSON.stringify({
      streams: [{
        stream: { job: 'openclaw-guardian', host: process.env.HOSTNAME ?? 'pi' },
        values: [[ns, JSON.stringify({ ...s, level: s.cooldown ? 'warn' : 'info', component: 'state' })]],
      }],
    });
    return this._post(this._cfg.lokiUrl, payload, 'application/json');
  }

  _post(urlStr, body, contentType) {
    return new Promise((resolve, reject) => {
      const url  = new URL(urlStr);
      const auth = Buffer.from(`${this._cfg.user}:${this._cfg.token}`).toString('base64');
      const req  = httpsRequest({
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  {
          'Content-Type':   contentType,
          'Content-Length': Buffer.byteLength(body),
          'Authorization':  `Basic ${auth}`,
        },
      }, (res) => {
        res.resume();
        res.statusCode >= 400
          ? reject(new Error(`HTTP ${res.statusCode} from ${url.hostname}`))
          : resolve();
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      req.write(body);
      req.end();
    });
  }
}
