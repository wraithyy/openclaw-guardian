/**
 * proxy.js – Rate-limit aware HTTP proxy (OpenClaw -> Anthropic API).
 */
import { createServer }        from 'http';
import { request as httpsReq } from 'https';
import { URL }                 from 'url';
import { config }              from './config.js';
import { logger }              from './logger.js';
import { state, updateState, updateRateLimitHeaders, enterCooldown, exitCooldown } from './state.js';
import { enqueue }             from './queue.js';
import { renderPrometheus }    from './metrics.js';

const pcfg     = config.proxy;
const UPSTREAM = new URL(pcfg.upstreamBase);

export function startProxy() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/_guardian/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(renderPrometheus());
    }
    if (req.method === 'GET' && req.url === '/_guardian/health') {
      res.writeHead(state.cooldown ? 503 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: !state.cooldown,
        cooldown: state.cooldown,
        remainingRequests: state.remainingRequests,
      }));
    }
    enqueue(() => handleRequest(req, res)).catch((err) => {
      logger.error('Queue error', { error: err.message });
      if (!res.headersSent) { res.writeHead(502); res.end('proxy error'); }
    });
  });

  server.listen(pcfg.port, pcfg.bindHost ?? '127.0.0.1', () => {
    logger.info('Proxy started', { port: pcfg.port, upstream: UPSTREAM.href });
    logger.info('Metrics: http://127.0.0.1:' + pcfg.port + '/_guardian/metrics');
    logger.info('Health:  http://127.0.0.1:' + pcfg.port + '/_guardian/health');
  });
  return server;
}

async function handleRequest(req, res, attempt = 0) {
  if (attempt === 0) updateState({ totalRequests: state.totalRequests + 1 });
  const body = await collectBody(req);
  return doForward(req, res, body, attempt);
}

function doForward(origReq, res, body, attempt) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: UPSTREAM.hostname,
      port:     443,
      path:     origReq.url,
      method:   origReq.method,
      headers:  buildHeaders(origReq.headers, body.length),
    };

    const pReq = httpsReq(opts, (pRes) => {
      const rlHeaders = Object.fromEntries(Object.entries(pRes.headers).filter(([k]) => k.includes('ratelimit')));
      if (Object.keys(rlHeaders).length > 0) logger.info('Rate-limit headers', rlHeaders);
      else logger.debug('No ratelimit headers in response', { status: pRes.statusCode });
      updateRateLimitHeaders(pRes.headers);

      if (pRes.statusCode === 429) {
        logger.warn('429 from Anthropic', { attempt, url: origReq.url });
        updateState({ total429s: state.total429s + 1 });
        enterCooldown();
        pRes.resume();
        if (attempt < pcfg.maxRetries) {
          const delay = pcfg.backoffBase * Math.pow(2, attempt);
          logger.info('Retrying', { delayMs: delay });
          setTimeout(() => doForward(origReq, res, body, attempt + 1).then(resolve).catch(reject), delay);
        } else {
          if (!res.headersSent) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'rate_limited', resetTimestamp: state.resetTimestamp }));
          }
          resolve();
        }
        return;
      }

      if (state.cooldown) exitCooldown();
      if (!res.headersSent) res.writeHead(pRes.statusCode, sanitize(pRes.headers));
      pRes.pipe(res);
      pRes.on('end', resolve);
      pRes.on('error', reject);
    });

    pReq.on('error', (err) => {
      logger.error('Upstream error', { error: err.message });
      if (!res.headersSent) { res.writeHead(502); res.end('upstream error'); }
      resolve();
    });
    pReq.setTimeout(120_000, () => pReq.destroy(new Error('timeout')));
    if (body.length) pReq.write(body);
    pReq.end();
  });
}

function collectBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end',  () => resolve(Buffer.concat(c)));
    req.on('error',() => resolve(Buffer.alloc(0)));
  });
}

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailers','transfer-encoding','upgrade','host']);

function buildHeaders(h, len) {
  const out = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase())) out[k] = v;
  out['host'] = UPSTREAM.hostname;
  if (len) out['content-length'] = String(len);
  return out;
}

function sanitize(h) {
  const { 'transfer-encoding': _, ...r } = h;
  return r;
}
