/**
 * proxy.js – Rate-limit aware HTTP proxy (OpenClaw -> Anthropic API).
 *
 * Session-aware: extracts session ID from request body, tracks per-session
 * token usage from response, and detects cron requests for priority queueing.
 */
import { createServer }        from 'http';
import { request as httpsReq } from 'https';
import { URL }                 from 'url';
import { config }              from './config.js';
import { logger }              from './logger.js';
import { state, updateState, updateRateLimitHeaders, enterCooldown, exitCooldown } from './state.js';
import { enqueue }             from './queue.js';
import { renderPrometheus }    from './metrics.js';
import { extractSessionId, isCronRequest, trackRequest, trackResponse } from './sessions.js';

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

    const isCron = isCronRequest(req.headers);
    const priority = isCron ? 'high' : 'normal';

    enqueue(() => handleRequest(req, res, isCron), priority).catch((err) => {
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

async function handleRequest(req, res, isCron, attempt = 0) {
  if (attempt === 0) updateState({ totalRequests: state.totalRequests + 1 });
  const body = await collectBody(req);

  // Parse body once for session extraction + streaming detection
  let sessionId = null;
  let parsedBody = null;
  if (req.url?.startsWith('/v1/messages') && body.length > 0) {
    try {
      parsedBody = JSON.parse(body.toString('utf8'));
      sessionId = extractSessionId(parsedBody);
      if (sessionId && attempt === 0) {
        trackRequest(sessionId, isCron);
      }
    } catch {
      // Not valid JSON or not a messages request — skip tracking
    }
  }

  return doForward(req, res, body, parsedBody, attempt, sessionId);
}

function doForward(origReq, res, body, parsedBody, attempt, sessionId) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: UPSTREAM.hostname,
      port:     443,
      path:     origReq.url,
      method:   origReq.method,
      headers:  buildHeaders(origReq.headers, body.length),
    };

    const isStreaming = origReq.headers['accept']?.includes('text/event-stream') ||
      parsedBody?.stream === true;

    const pReq = httpsReq(opts, (pRes) => {
      const rlHeaders = Object.fromEntries(Object.entries(pRes.headers).filter(([k]) => k.includes('ratelimit')));
      if (Object.keys(rlHeaders).length > 0) logger.info('Rate-limit headers', rlHeaders);
      else logger.debug('No ratelimit headers in response', { status: pRes.statusCode });
      updateRateLimitHeaders(pRes.headers);

      if (pRes.statusCode === 429) {
        logger.warn('429 from Anthropic', { attempt, url: origReq.url, sessionId });
        updateState({ total429s: state.total429s + 1 });
        enterCooldown();
        trackResponse(sessionId, null, true);
        pRes.resume();
        if (attempt < pcfg.maxRetries) {
          const delay = pcfg.backoffBase * Math.pow(2, attempt);
          logger.info('Retrying', { delayMs: delay });
          setTimeout(() => doForward(origReq, res, body, parsedBody, attempt + 1, sessionId).then(resolve).catch(reject), delay);
        } else {
          if (!res.headersSent) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'rate_limited', resetTimestamp: state.resetTimestamp }));
          }
          resolve();
        }
        return;
      }

      const isErrorStatus = pRes.statusCode >= 400;
      if (state.cooldown) exitCooldown();

      if (isStreaming && sessionId) {
        // For streaming: pipe through, scanning chunks for usage in final events
        if (!res.headersSent) res.writeHead(pRes.statusCode, sanitize(pRes.headers));
        let tailBuffer = '';
        pRes.on('data', (chunk) => {
          res.write(chunk);
          // Keep last ~2KB to find the final message_delta with usage
          tailBuffer += chunk.toString('utf8');
          if (tailBuffer.length > 4096) {
            tailBuffer = tailBuffer.slice(-2048);
          }
        });
        pRes.on('end', () => {
          if (isErrorStatus) {
            trackResponse(sessionId, null, true);
          } else {
            extractStreamingUsage(tailBuffer, sessionId);
          }
          res.end();
          resolve();
        });
        pRes.on('error', (err) => {
          res.end();
          reject(err);
        });
      } else if (!isStreaming && sessionId) {
        // For non-streaming: collect response body to extract usage
        if (!res.headersSent) res.writeHead(pRes.statusCode, sanitize(pRes.headers));
        const chunks = [];
        pRes.on('data', (chunk) => {
          res.write(chunk);
          chunks.push(chunk);
        });
        pRes.on('end', () => {
          if (isErrorStatus) {
            trackResponse(sessionId, null, true);
          } else {
            try {
              const respBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (respBody.usage) {
                trackResponse(sessionId, respBody.usage, false);
              }
            } catch {
              // Not JSON or no usage — fine
            }
          }
          res.end();
          resolve();
        });
        pRes.on('error', (err) => {
          res.end();
          reject(err);
        });
      } else {
        // No session tracking — simple pipe-through (original behavior)
        if (!res.headersSent) res.writeHead(pRes.statusCode, sanitize(pRes.headers));
        pRes.pipe(res);
        pRes.on('end', resolve);
        pRes.on('error', reject);
      }
    });

    pReq.on('error', (err) => {
      logger.error('Upstream error', { error: err.message });
      trackResponse(sessionId, null, true);
      if (!res.headersSent) { res.writeHead(502); res.end('upstream error'); }
      resolve();
    });
    pReq.setTimeout(120_000, () => pReq.destroy(new Error('timeout')));
    if (body.length) pReq.write(body);
    pReq.end();
  });
}

/**
 * Extract usage from the tail of a streaming SSE response.
 * The message_delta event contains usage in its data payload.
 */
function extractStreamingUsage(tail, sessionId) {
  try {
    // Look for the message_delta event which has usage
    const deltaMatch = tail.match(/event:\s*message_delta\r?\ndata:\s*(\{[^\n]+\})/);
    if (deltaMatch) {
      const delta = JSON.parse(deltaMatch[1]);
      if (delta.usage) {
        trackResponse(sessionId, delta.usage, false);
        return;
      }
    }
    // Fallback: look for any "usage" object in the tail
    const usageMatch = tail.match(/"usage"\s*:\s*(\{[^}]+\})/);
    if (usageMatch) {
      const usage = JSON.parse(usageMatch[1]);
      trackResponse(sessionId, usage, false);
    }
  } catch {
    // Best-effort — don't break the proxy over usage tracking
  }
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
