/**
 * proxy.js – Rate-limit aware HTTP proxy between OpenClaw and Anthropic API.
 *
 * Endpoints:
 *   ALL /*        → forwarded to Anthropic (with throttle + queue)
 *   GET /metrics  → Prometheus text format
 *   GET /_health  → JSON health check
 */

import { createServer }          from 'http';
import { request as httpsReq }   from 'https';
import { config }                from './config.js';
import { SharedState }           from './state.js';
import { AsyncQueue }            from './queue.js';
import { getLogger }             from './logger.js';
import { metrics, renderPrometheus, GrafanaExporter } from './metrics.js';

const log   = getLogger(config.logPath, config.logLevel);
const state = new SharedState(config.sharedStatePath);
const queue = new AsyncQueue(config.proxy.maxConcurrency);
const pcfg  = config.proxy;
const tcfg  = pcfg.throttle;

// ── Grafana exporter (optional) ────────────────────────────────────────────
const grafana = new GrafanaExporter(config.grafana, state, log);

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseReset(headerVal) {
  if (!headerVal) return null;
  const d = new Date(headerVal);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForCooldown() {
  while (state.isInCooldown()) {
    const s     = state.get();
    const until = s.cooldownUntil ? new Date(s.cooldownUntil).getTime() : Date.now() + 5000;
    const wait  = Math.max(100, until - Date.now());
    log.warn('proxy', 'In cooldown, waiting', { waitMs: wait });
    await sleep(wait);
  }
}

async function applyThrottle() {
  const s = state.get();
  const rem = s.remainingRequests;
  if (rem === null) return; // no info yet

  if (rem === 0) {
    // Block until reset
    const until = s.resetTimestamp ? new Date(s.resetTimestamp).getTime() : Date.now() + 5000;
    const wait  = Math.max(100, until - Date.now());
    log.warn('proxy', 'remainingRequests=0, blocking', { waitMs: wait });
    metrics.incCounter('guardian_total_throttles');
    state.update({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(wait);
  } else if (rem < tcfg.pauseThreshold) {
    const until = s.resetTimestamp ? new Date(s.resetTimestamp).getTime() : Date.now() + 3000;
    const wait  = Math.max(100, until - Date.now());
    log.warn('proxy', 'remainingRequests low, pausing until reset', { rem, waitMs: wait });
    metrics.incCounter('guardian_total_throttles');
    state.update({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(wait);
  } else if (rem < tcfg.warnThreshold) {
    const delay = randomDelay(tcfg.delayMin, tcfg.delayMax);
    log.info('proxy', 'remainingRequests low, adding delay', { rem, delayMs: delay });
    metrics.incCounter('guardian_total_throttles');
    state.update({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(delay);
  }
}

function updateStateFromHeaders(headers) {
  const rem      = parseInt(headers['anthropic-ratelimit-requests-remaining'] ?? '', 10);
  const tokens   = parseInt(headers['anthropic-ratelimit-tokens-remaining']   ?? '', 10);
  const reset    = parseReset(headers['anthropic-ratelimit-reset']);

  const patch = {};
  if (!isNaN(rem))    patch.remainingRequests = rem;
  if (!isNaN(tokens)) patch.remainingTokens   = tokens;
  if (reset)          patch.resetTimestamp    = reset;

  if (Object.keys(patch).length) {
    state.update(patch);
    metrics.setGauge('guardian_remaining_requests', patch.remainingRequests ?? state.get().remainingRequests ?? -1);
    metrics.setGauge('guardian_remaining_tokens',   patch.remainingTokens   ?? state.get().remainingTokens   ?? -1);
  }
}

// ── Core proxy request ─────────────────────────────────────────────────────

async function forwardRequest(clientReq, clientRes, attempt = 0) {
  await waitForCooldown();
  await applyThrottle();

  const upstream = new URL(pcfg.upstreamBase);
  const body     = await readBody(clientReq);

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: upstream.hostname,
      port:     443,
      path:     clientReq.url,
      method:   clientReq.method,
      headers:  {
        ...clientReq.headers,
        host: upstream.hostname,
      },
    };

    const s = state.get();
    state.update({ totalRequests: (s.totalRequests ?? 0) + 1 });
    metrics.incCounter('guardian_total_requests');

    const proxyReq = httpsReq(opts, (proxyRes) => {
      updateStateFromHeaders(proxyRes.headers);

      if (proxyRes.statusCode === 429) {
        log.warn('proxy', 'Received 429 from Anthropic', {
          attempt,
          resetTimestamp: state.get().resetTimestamp,
        });

        const s = state.get();
        const resetAt = s.resetTimestamp ?? new Date(Date.now() + 60_000).toISOString();
        state.update({
          cooldown:      true,
          cooldownUntil: resetAt,
          total429s:     (s.total429s ?? 0) + 1,
        });
        metrics.incCounter('guardian_total_429s');
        metrics.setGauge('guardian_cooldown', 1);

        // drain response body
        proxyRes.resume();

        if (attempt < pcfg.maxRetries) {
          const backoff = pcfg.backoffBase * Math.pow(2, attempt);
          log.info('proxy', `Retrying after ${backoff}ms (attempt ${attempt + 1})`);
          setTimeout(() => {
            forwardRequest(clientReq, clientRes, attempt + 1)
              .then(resolve).catch(reject);
          }, backoff);
        } else {
          clientRes.writeHead(429, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({ error: 'rate_limited', cooldownUntil: state.get().cooldownUntil }));
          resolve();
        }
        return;
      }

      // Normal response – stream back to client
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
      proxyRes.on('end', () => {
        if (state.get().cooldown) {
          state.update({ cooldown: false, cooldownUntil: null });
          metrics.setGauge('guardian_cooldown', 0);
        }
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      log.error('proxy', 'Upstream connection error', { err: err.message });
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'upstream_error', message: err.message }));
      }
      resolve();
    });

    proxyReq.setTimeout(120_000, () => {
      proxyReq.destroy(new Error('upstream timeout'));
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ── HTTP server ────────────────────────────────────────────────────────────

export function startProxy() {
  const server = createServer((req, res) => {
    // Prometheus metrics scrape
    if (req.method === 'GET' && req.url === '/metrics') {
      // Sync state into metrics before rendering
      const s = state.get();
      metrics.setGauge('guardian_remaining_requests', s.remainingRequests ?? -1);
      metrics.setGauge('guardian_remaining_tokens',   s.remainingTokens   ?? -1);
      metrics.setGauge('guardian_cooldown',            s.cooldown ? 1 : 0);
      metrics.setGauge('guardian_queue_length',        queue.length);
      metrics.setGauge('guardian_total_requests',      s.totalRequests ?? 0);
      metrics.setGauge('guardian_total_throttles',     s.totalThrottles ?? 0);
      metrics.setGauge('guardian_total_429s',          s.total429s ?? 0);

      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderPrometheus());
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/_health') {
      const s = state.get();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok:                 true,
        cooldown:           s.cooldown,
        cooldownUntil:      s.cooldownUntil,
        remainingRequests:  s.remainingRequests,
        remainingTokens:    s.remainingTokens,
        queueLength:        queue.length,
        totalRequests:      s.totalRequests,
        total429s:          s.total429s,
      }, null, 2));
      return;
    }

    // Everything else → queue → proxy
    queue.push(() => forwardRequest(req, res)).catch((err) => {
      log.error('proxy', 'Unhandled queue error', { err: err.message });
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal proxy error');
      }
    });

    // Expose queue length in state
    state.update({ queueLength: queue.length });
    metrics.setGauge('guardian_queue_length', queue.length);
  });

  server.listen(pcfg.port, '127.0.0.1', () => {
    log.info('proxy', `Proxy listening on http://127.0.0.1:${pcfg.port}`);
    log.info('proxy', `Metrics at http://127.0.0.1:${pcfg.port}/metrics`);
    log.info('proxy', `Health  at http://127.0.0.1:${pcfg.port}/_health`);
    log.info('proxy', `Upstream: ${pcfg.upstreamBase}`);
  });

  grafana.start();
  return server;
}
