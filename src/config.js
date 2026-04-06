/**
 * config.js – Loads ~/.openclaw/guardian.config.json and merges with defaults.
 *
 * v2: provider-agnostic. No proxy config. Adds http server + usage tracker config.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_PATH = join(homedir(), '.openclaw', 'guardian.config.json');

const DEFAULTS = {
  // HTTP server (metrics + health endpoints)
  http: {
    port: 4747,
    bindHost: '127.0.0.1',
  },
  // Session file healer
  healer: {
    sessionDirs: [join(homedir(), '.openclaw', 'agents')],
    pollIntervalMs: 5000,
    maxFileSizeBytes: 2 * 1024 * 1024, // 2 MB
    staleLockMinutes: 10,
    archiveCorrupted: false,  // false = delete, true = rename to .bak
  },
  // Usage tracker (reads session JSONL files to aggregate model/session stats)
  usage: {
    enabled: true,
    sessionDirs: [join(homedir(), '.openclaw', 'agents')],
    pollIntervalMs: 30_000,  // scan every 30s
    retentionDays: 30,
    persistPath: join(homedir(), '.openclaw', 'guardian.usage.json'),
  },
  // Grafana Cloud push (optional, zero external deps)
  grafana: {
    enabled: false,
    mimirUrl: '',   // e.g. https://prometheus-prod-XX.grafana.net/api/prom/push
    lokiUrl:  '',   // e.g. https://logs-prod-XX.grafana.net/loki/api/v1/push
    user:     '',   // numeric Grafana Cloud user ID
    token:    '',   // Grafana Cloud API token
    pushIntervalMs: 15_000,
  },
  // Shared state file (healer writes, exporter reads)
  sharedStatePath: join(homedir(), '.openclaw', 'guardian.state.json'),
  logPath:  join(homedir(), '.openclaw', 'guardian.log'),
  logLevel: 'info',  // info | warn | error
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    // Write defaults on first run so the user has a template to edit.
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
