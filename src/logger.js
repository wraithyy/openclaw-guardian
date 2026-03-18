/**
 * logger.js – Structured JSON logger writing to file + stderr.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2 };

function log(level, message, extra = {}) {
  const currentLevel = LEVELS[config.logLevel] ?? 2;
  if (LEVELS[level] > currentLevel) return;

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  });

  try {
    mkdirSync(dirname(config.logPath), { recursive: true });
    appendFileSync(config.logPath, entry + '\n');
  } catch (_) { /* ignore */ }

  process.stderr.write(entry + '\n');
}

export const logger = {
  info:  (msg, extra) => log('info',  msg, extra),
  warn:  (msg, extra) => log('warn',  msg, extra),
  error: (msg, extra) => log('error', msg, extra),
};
