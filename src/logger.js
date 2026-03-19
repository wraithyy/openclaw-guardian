/**
 * logger.js – Structured JSON logger.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2 };

let _sink = null;
export function setLogSink(fn) { _sink = fn; }

function log(level, msg, extra = {}) {
  if ((LEVELS[level] ?? 2) > (LEVELS[config.logLevel] ?? 2)) return;
  const entry = { ts: new Date().toISOString(), level, message: msg, ...extra };
  const line  = JSON.stringify(entry);
  try { mkdirSync(dirname(config.logPath), { recursive: true }); appendFileSync(config.logPath, line + '\n'); } catch (_) {}
  process.stderr.write(line + '\n');
  if (_sink) try { _sink(entry); } catch (_) {}
}

export const logger = {
  info:  (msg, x) => log('info',  msg, x),
  warn:  (msg, x) => log('warn',  msg, x),
  error: (msg, x) => log('error', msg, x),
};
