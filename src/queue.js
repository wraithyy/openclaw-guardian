/**
 * queue.js – FIFO async queue with concurrency limit + rate-limit throttle.
 *
 * Supports priority: 'high' (cron) requests go to front of queue.
 */
import { config } from './config.js';
import { state, getState, updateState } from './state.js';
import { logger } from './logger.js';

const MAX = config.proxy.maxConcurrency;
const { warnThreshold, pauseThreshold, delayMin, delayMax } = config.proxy.throttle;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = 0;
const q = [];

/**
 * @param {Function} task
 * @param {'normal'|'high'} priority - 'high' for cron jobs, pushed to front
 */
export function enqueue(task, priority = 'normal') {
  return new Promise((resolve, reject) => {
    const item = { task, resolve, reject };
    if (priority === 'high') {
      q.unshift(item);
      logger.info('Priority request queued at front', { queueLength: q.length });
    } else {
      q.push(item);
    }
    updateState({ queueLength: q.length });
    _drain();
  });
}

export function queueLength() { return q.length; }

function _drain() {
  if (running >= MAX || q.length === 0) return;
  const s = getState();
  if (s.cooldown) {
    const until = s.cooldownUntil ? new Date(s.cooldownUntil).getTime() : Date.now() + 2000;
    const wait  = Math.max(until - Date.now(), 500);
    logger.warn('Queue paused – cooldown', { waitMs: wait, queueLength: q.length });
    setTimeout(_drain, wait);
    return;
  }
  const { task, resolve, reject } = q.shift();
  updateState({ queueLength: q.length });
  running++;
  _throttle()
    .then(() => task())
    .then(resolve)
    .catch(reject)
    .finally(() => { running--; _drain(); });
}

async function _throttle() {
  const s   = getState();
  const rem = s.remainingRequests;
  if (rem === null) return; // no info yet

  const until = s.resetTimestamp ? new Date(s.resetTimestamp).getTime() : Date.now() + 2000;

  if (rem <= 0 || s.cooldown) {
    const w = Math.max(until - Date.now(), 1000);
    logger.warn('Hard block – no requests remaining', { waitMs: w });
    updateState({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(w);
  } else if (rem < pauseThreshold) {
    const w = Math.max(until - Date.now(), 500);
    logger.warn('Pause until reset', { rem, waitMs: w });
    updateState({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(w);
  } else if (rem < warnThreshold) {
    const d = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);
    logger.info('Throttle delay', { rem, delayMs: d });
    updateState({ totalThrottles: (s.totalThrottles ?? 0) + 1 });
    await sleep(d);
  }
}
