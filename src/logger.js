/**
 * logger.js – Structured JSON logger.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2 };

function log(level, msg, extra = {}) {
  if ((LEVELS[level] ?? 2) > (LEVELS[config.logLevel] ?? 2)) return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, message: msg, ...extra });
  try { mkdirSync(dirname(config.logPath), { recursive: true }); appendFileSync(config.logPath, entry + '\n'); } catch (_) {}
  process.stderr.write(entry + '\n');
}

export const logger = {
  info:  (msg, x) => log('info',  msg, x),
  warn:  (msg, x) => log('warn',  msg, x),
  error: (msg, x) => log('error', msg, x),
};
