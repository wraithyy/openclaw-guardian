/**
 * exporter.js – Optional push to Grafana Cloud (Mimir + Loki).
 *
 * Mimir: Prometheus remote_write over HTTP (protobuf + snappy, zero external deps).
 * Loki:  Structured log push (JSON).
 *
 * Both use Basic Auth: user = numeric Grafana Cloud user ID, token = API key.
 */
import { request } from 'https';
import { config }        from './config.js';
import { getState }      from './state.js';
import { healerMetrics } from './metrics.js';
import { logger }        from './logger.js';

const gcfg = config.grafana ?? {};

// ─── Loki log buffer (populated via logger sink) ──────────────────────────────

const lokiBuffer = [];

export function bufferLog(entry) {
  // Timestamp in nanoseconds as string (Loki requirement).
  // Date.now() is ms; append '000000' to convert to ns without BigInt overflow.
  lokiBuffer.push([Date.now().toString() + '000000', JSON.stringify(entry)]);
  if (lokiBuffer.length > 500) lokiBuffer.shift(); // prevent unbounded growth
}

// ─── Varint (safe for values up to Number.MAX_SAFE_INTEGER) ──────────────────

function varint(n) {
  const out = [];
  while (true) {
    const b = n % 128;
    n = Math.floor(n / 128);
    if (n === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

// ─── Protobuf field encoders ──────────────────────────────────────────────────

/** wire type 2 — length-delimited */
function ldField(fieldNum, data) {
  return Buffer.concat([varint((fieldNum << 3) | 2), varint(data.length), data]);
}

/** wire type 1 — 64-bit (double, little-endian) */
function f64Field(fieldNum, value) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([varint((fieldNum << 3) | 1), buf]);
}

/** wire type 0 — varint */
function varintField(fieldNum, value) {
  return Buffer.concat([varint((fieldNum << 3) | 0), varint(value)]);
}

// ─── Prometheus remote_write message builders ─────────────────────────────────

function encodeLabel(name, value) {
  return Buffer.concat([
    ldField(1, Buffer.from(name,  'utf8')),
    ldField(2, Buffer.from(value, 'utf8')),
  ]);
}

function encodeTimeSeries(name, value, tsMs) {
  // Labels MUST be sorted lexicographically (__name__ < job).
  return Buffer.concat([
    ldField(1, encodeLabel('__name__', name)),
    ldField(1, encodeLabel('job', 'openclaw-guardian')),
    ldField(2, Buffer.concat([
      f64Field(1, value),
      varintField(2, tsMs),
    ])),
  ]);
}

function buildWriteRequest(metrics) {
  const tsMs = Date.now();
  return Buffer.concat(
    metrics.map(({ name, value }) => ldField(1, encodeTimeSeries(name, value, tsMs)))
  );
}

// ─── Snappy raw format (literal-only, valid for small payloads < ~64 KB) ─────
//
// Format: varint(uncompressed_length) + literal_blocks
// Each literal block of 1–60 bytes: tag = (len-1) << 2, then the bytes.

function snappyEncode(data) {
  const chunks = [varint(data.length)];
  for (let i = 0; i < data.length; i += 60) {
    const slice = data.slice(i, i + 60);
    chunks.push(Buffer.from([(slice.length - 1) << 2]));
    chunks.push(slice);
  }
  return Buffer.concat(chunks);
}

// ─── HTTP POST helper ─────────────────────────────────────────────────────────

function httpPost(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port:     Number(url.port) || 443,
      path:     url.pathname + url.search,
      method:   'POST',
      headers,
    };
    const req = request(opts, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('exporter timeout')));
    req.write(body);
    req.end();
  });
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`${gcfg.user}:${gcfg.token}`).toString('base64');
}

// ─── Mimir push ───────────────────────────────────────────────────────────────

function collectMetrics() {
  const s = getState();
  const h = healerMetrics;
  return [
    { name: 'guardian_remaining_requests',  value: s.remainingRequests ?? -1 },
    { name: 'guardian_remaining_tokens',    value: s.remainingTokens   ?? -1 },
    { name: 'guardian_cooldown',            value: s.cooldown ? 1 : 0 },
    { name: 'guardian_queue_length',        value: s.queueLength },
    { name: 'guardian_requests_total',      value: s.totalRequests },
    { name: 'guardian_throttles_total',     value: s.totalThrottles },
    { name: 'guardian_429s_total',          value: s.total429s },
    { name: 'guardian_sessions_scanned',    value: h.sessionsScanned },
    { name: 'guardian_sessions_repaired_total',   value: h.sessionsRepaired },
    { name: 'guardian_sessions_deleted_total',    value: h.sessionsDeleted },
    { name: 'guardian_stale_locks_removed_total', value: h.staleLocksRemoved },
    { name: 'guardian_scan_runs_total',     value: h.scanRuns },
    { name: 'guardian_at_risk',             value: s.cooldown ? 1 : 0 },
  ];
}

async function pushMimir() {
  const proto  = buildWriteRequest(collectMetrics());
  const body   = snappyEncode(proto);
  const status = await httpPost(gcfg.mimirUrl, {
    'Content-Type':                        'application/x-protobuf',
    'Content-Encoding':                    'snappy',
    'X-Prometheus-Remote-Write-Version':   '0.1.0',
    'Authorization':                       basicAuth(),
    'Content-Length':                      String(body.length),
  }, body);
  if (status >= 400) logger.warn('Mimir push failed', { status });
}

// ─── Loki push ────────────────────────────────────────────────────────────────

async function pushLoki() {
  if (lokiBuffer.length === 0) return;
  const batch = lokiBuffer.splice(0, lokiBuffer.length);
  const body  = JSON.stringify({
    streams: [{
      stream: { job: 'openclaw-guardian' },
      values: batch,
    }],
  });
  const status = await httpPost(gcfg.lokiUrl, {
    'Content-Type':   'application/json',
    'Authorization':  basicAuth(),
    'Content-Length': String(Buffer.byteLength(body)),
  }, body);
  if (status >= 400) logger.warn('Loki push failed', { status });
}

// ─── Start ────────────────────────────────────────────────────────────────────

export function startExporter() {
  if (!gcfg?.enabled) return;
  logger.info('Grafana exporter started', {
    pushIntervalMs: gcfg.pushIntervalMs,
    mimir: !!gcfg.mimirUrl,
    loki:  !!gcfg.lokiUrl,
  });
  const interval = gcfg.pushIntervalMs ?? 15_000;
  setInterval(async () => {
    if (gcfg.mimirUrl) {
      try { await pushMimir(); }
      catch (e) { logger.error('Mimir push error', { error: e.message }); }
    }
    if (gcfg.lokiUrl) {
      try { await pushLoki(); }
      catch (e) { logger.error('Loki push error', { error: e.message }); }
    }
  }, interval);
}
