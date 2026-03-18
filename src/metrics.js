/**
 * metrics.js – Prometheus text-format metrics + optional Grafana Cloud push.
 *
 * Exposes:
 *   GET /metrics  → Prometheus scrape endpoint (on proxy port)
 *
 * Optional Grafana Cloud push (Mimir + Loki):
 *   Set in guardian.config.json:
 *   {
 *     "grafana": {
 *       "enabled": true,
 *       "mimirUrl":  "https://prometheus-prod-XX.grafana.net/api/prom/push",
 *       "lokiUrl":   "https://logs-prod-XX.grafana.net/loki/api/v1/push",
 *       "user":      "123456",
 *       "token":     "glc_...",
 *       "pushIntervalMs": 15000
 *     }
 *   }
 */

import { request as httpsRequest } from 'https';

// ── simple in-process counter/gauge store ──────────────────────────────────

const gauges   = {};
const counters = {};

export const metrics = {
  setGauge(name, value, labels = {}) {
    gauges[labelKey(name, labels)] = { name, value, labels };
  },
  incCounter(name, amount = 1, labels = {}) {
    const k = labelKey(name, labels);
    if (!counters[k]) counters[k] = { name, value: 0, labels };
    counters[k].value += amount;
  },
  // Expose current counter value (for push)
  counterValue(name, labels = {}) {
    return counters[labelKey(name, labels)]?.value ?? 0;
  },
};

function labelKey(name, labels) {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  return parts ? `${name}{${parts}}` : name;
}

// ── Prometheus text format ─────────────────────────────────────────────────

export function renderPrometheus() {
  const lines = ['# openclaw_guardian metrics'];

  for (const { name, value, labels } of Object.values(gauges)) {
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${labelKey(name, labels)} ${value}`);
  }
  for (const { name, value, labels } of Object.values(counters)) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${labelKey(name, labels)} ${value}`);
  }
  return lines.join('\n') + '\n';
}

// ── Grafana Cloud remote write (Mimir – Prometheus remote_write protocol) ──

export class GrafanaExporter {
  constructor(cfg, state, logger) {
    this.cfg    = cfg;
    this.state  = state;
    this.logger = logger;
    this._timer = null;
  }

  start() {
    if (!this.cfg?.enabled) return;
    this.logger.info('metrics', 'Grafana exporter started', {
      pushIntervalMs: this.cfg.pushIntervalMs ?? 15000,
    });
    this._timer = setInterval(() => this._push(), this.cfg.pushIntervalMs ?? 15000);
    this._timer.unref?.(); // don't block exit on Pi
  }

  stop() { if (this._timer) clearInterval(this._timer); }

  async _push() {
    try {
      await Promise.allSettled([
        this._pushMimir(),
        this._pushLoki(),
      ]);
    } catch (e) {
      this.logger.warn('metrics', 'Grafana push error', { err: e.message });
    }
  }

  // ── Mimir (metrics) ─────────────────────────────────────────────────────
  // Uses Prometheus text format over HTTPS POST to remote_write compatible endpoint

  _pushMimir() {
    if (!this.cfg.mimirUrl) return;
    const s = this.state.get();
    const now = Date.now();

    // Build simple text/plain body (Mimir accepts Prometheus remote_write as well
    // as the simpler "Prometheus exposition format" on some endpoints, but the
    // safest zero-dep approach is to POST to the Grafana Cloud Prometheus HTTP API
    // which accepts application/x-www-form-urlencoded or text body for a single
    // series push via the /api/v1/import/prometheus or plain remote_write.
    // We use the plain-text scrape push format supported by Grafana Agent pushes:
    // POST body is Prometheus text format, Content-Type: text/plain).

    const lines = [
      `guardian_remaining_requests ${s.remainingRequests ?? -1} ${now}`,
      `guardian_remaining_tokens ${s.remainingTokens ?? -1} ${now}`,
      `guardian_cooldown ${s.cooldown ? 1 : 0} ${now}`,
      `guardian_queue_length ${s.queueLength ?? 0} ${now}`,
      `guardian_total_requests ${s.totalRequests ?? 0} ${now}`,
      `guardian_total_throttles ${s.totalThrottles ?? 0} ${now}`,
      `guardian_total_429s ${s.total429s ?? 0} ${now}`,
    ].join('\n') + '\n';

    return this._post(this.cfg.mimirUrl, lines, 'text/plain');
  }

  // ── Loki (logs) ─────────────────────────────────────────────────────────
  // Sends last-state snapshot as a structured log stream to Loki push API

  _pushLoki() {
    if (!this.cfg.lokiUrl) return;
    const s = this.state.get();
    const nsTimestamp = (BigInt(Date.now()) * 1_000_000n).toString();

    const payload = JSON.stringify({
      streams: [{
        stream: { job: 'openclaw-guardian', host: process.env.HOSTNAME ?? 'pi' },
        values: [[
          nsTimestamp,
          JSON.stringify({
            ...s,
            level: s.cooldown ? 'warn' : 'info',
            component: 'proxy',
          }),
        ]],
      }],
    });

    return this._post(this.cfg.lokiUrl, payload, 'application/json');
  }

  // ── HTTP helper (no deps) ────────────────────────────────────────────────

  _post(urlStr, body, contentType) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const auth = `${this.cfg.user}:${this.cfg.token}`;
      const opts = {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname + url.search,
        method:   'POST',
        headers: {
          'Content-Type':   contentType,
          'Content-Length': Buffer.byteLength(body),
          'Authorization':  'Basic ' + Buffer.from(auth).toString('base64'),
        },
      };
      const req = httpsRequest(opts, (res) => {
        res.resume(); // drain
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url.hostname}`));
        } else {
          resolve();
        }
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }
}
