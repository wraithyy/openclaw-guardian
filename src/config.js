/**
 * config.js – Loads ~/.openclaw/guardian.config.json and merges with defaults.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_PATH = join(homedir(), '.openclaw', 'guardian.config.json');

const DEFAULTS = {
  // Proxy
  proxy: {
    port: 4747,
    upstreamBase: 'https://api.anthropic.com',
    maxConcurrency: 1,
    throttle: {
      warnThreshold: 5,   // delay when remainingRequests < this
      pauseThreshold: 2,  // pause queue until reset
      delayMin: 500,      // ms
      delayMax: 1500,     // ms
    },
    maxRetries: 1,
    backoffBase: 1000,    // ms for exponential backoff
  },
  // Healer
  healer: {
    sessionDirs: [join(homedir(), '.openclaw', 'agents')],
    pollIntervalMs: 5000,
    maxFileSizeBytes: 2 * 1024 * 1024, // 2 MB
    staleLockMinutes: 10,
    archiveCorrupted: false,  // false = delete, true = rename to .bak
  },
  // Shared state file (proxy writes, healer reads)
  sharedStatePath: join(homedir(), '.openclaw', 'guardian.state.json'),
  // Log
  logPath: join(homedir(), '.openclaw', 'guardian.log'),
  logLevel: 'info',  // info | warn | error
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    // Write defaults on first run
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    return DEFAULTS;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return deepMerge(DEFAULTS, raw);
  } catch (e) {
    console.error(`[guardian] Failed to parse config: ${e.message}. Using defaults.`);
    return DEFAULTS;
  }
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object') {
      out[k] = deepMerge(target[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const config = loadConfig();
