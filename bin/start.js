#!/usr/bin/env node
/**
 * bin/start.js – Guardian v2 entry point.
 *
 * Starts the HTTP server (metrics + health + usage endpoints),
 * the healer daemon, the usage tracker, and the optional Grafana exporter.
 * No proxy — provider-agnostic by design.
 */
import { createServer }  from 'http';
import { startDaemon }   from '../src/healer.js';
import { startUsageTracker, getUsageStats } from '../src/usage.js';
import { startExporter, bufferLog } from '../src/exporter.js';
import { setLogSink }    from '../src/logger.js';
import { config }        from '../src/config.js';
import { logger }        from '../src/logger.js';
import { renderPrometheus } from '../src/metrics.js';
import { readPersistedState, updateState } from '../src/state.js';

setLogSink(bufferLog);

// Restore persisted state so metrics are immediately available after restart
// without waiting for the first healer pass or usage scan.
const persisted = readPersistedState();
if (persisted) {
  const { _at, ...rest } = persisted;
  updateState(rest);
  logger.info('Restored persisted state');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_guardian/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(renderPrometheus());
  }

  if (req.method === 'GET' && req.url === '/_guardian/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: 2, uptime: process.uptime() }));
  }

  if (req.method === 'GET' && req.url === '/_guardian/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getUsageStats()));
  }

  res.writeHead(404);
  res.end('not found');
});

const { port, bindHost } = config.http;
server.listen(port, bindHost, () => {
  logger.info('Guardian v2 started', { port });
  logger.info(`Metrics: http://127.0.0.1:${port}/_guardian/metrics`);
  logger.info(`Health:  http://127.0.0.1:${port}/_guardian/health`);
  logger.info(`Usage:   http://127.0.0.1:${port}/_guardian/usage`);
});

// ─── Daemons ──────────────────────────────────────────────────────────────────

startDaemon();
startUsageTracker();
startExporter();
