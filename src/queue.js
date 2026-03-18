/**
 * queue.js – FIFO async queue with concurrency limit + rate-limit throttle.
 */
import { config } from './config.js';
import { state }  from './state.js';
import { logger } from './logger.js';

const MAX = config.proxy.maxConcurrency;
const { warnThreshold, pauseThreshold, delayMin, delayMax } = config.proxy.throttle;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = 0;
const q = [];

export function enqueue(task) {
  return new Promise((resolve, reject) => {
    q.push({ task, resolve, reject });
    state.update({ queueLength: q.length });
    _drain();
  });
}

export function queueLength() { return q.length; }

function _drain() {
  if (running >= MAX || q.length === 0) return;
  const s = state.get();
  if (s.cooldown) {
    const until = s.cooldownUntil ? new Date(s.cooldownUntil).getTime() : Date.now() + 2000;
    const wait  = Math.max(until - Date.now(), 500);
    logger.warn('Queue paused – cooldown', { waitMs: wait, queueLength: q.length });
    setTimeout(_drain, wait);
    return;
  }
  const { task, resolve, reject } = q.shift();
  state.update({ queueLength: q.length });
  running++;
  _throttle()
    .then(() => task())
    .then(resolve)
    .catch(reject)
    .finally(() => { running--; _drain(); });
}

async function _throttle() {
  const s   = state.get();
  const rem = s.remainingRequests;
  if (rem === null) return; // no info yet

  const until = s.resetTimestamp ? new Date(s.resetTimestamp).getTime() : Date.now() + 2000;

  if (rem <= 0 || s.cooldown) {
    const w = Math.max(until - Date.now(), 1000);
    logger.warn('Hard block – no requests remaining', { waitMs: w });
    state.update({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(w);
  } else if (rem < pauseThreshold) {
    const w = Math.max(until - Date.now(), 500);
    logger.warn('Pause until reset', { rem, waitMs: w });
    state.update({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(w);
  } else if (rem < warnThreshold) {
    const d = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);
    logger.info('Throttle delay', { rem, delayMs: d });
    state.update({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(d);
  }
}
