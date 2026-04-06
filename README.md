# openclaw-guardian

**Session healer + usage tracker for OpenClaw**

Zero external dependencies. Node 22+.

---

## What it does

### Healer
Scans OpenClaw session files (`.jsonl`) on a configurable interval. Detects and repairs corrupted tool use/result pairs (supports both OpenAI and Anthropic conversation formats), invalid JSON lines, and oversized files. Removes stale lock files. Skips files with recent activity to avoid mid-conversation corruption.

### Usage Tracker
Reads session JSONL files to aggregate per-model token usage and cost. Tracks active sessions, daily totals, and per-model breakdowns. Persists data to disk for restart recovery. Uses inode+offset cursors to efficiently read only new data on each scan.

### Observability
- `/_guardian/metrics` — Prometheus text format (per-model token/cost counters, healer stats)
- `/_guardian/health` — JSON health check
- `/_guardian/usage` — JSON usage breakdown (per-model, daily, active sessions)
- Structured JSON logs
- Optional push exporter to **Grafana Cloud** (Mimir + Loki, zero external deps)
- Pre-built Grafana dashboard (`grafana-dashboard.json`)

---

## Quick start

### 1. Install

```bash
git clone https://github.com/wraithyy/openclaw-guardian.git
cd openclaw-guardian
# no npm install needed – zero deps
```

### 2. Configure

On first run, `~/.openclaw/guardian.config.json` is created with defaults:

```json
{
  "http": {
    "port": 4747,
    "bindHost": "127.0.0.1"
  },
  "healer": {
    "sessionDirs": ["~/.openclaw/agents"],
    "pollIntervalMs": 5000,
    "maxFileSizeBytes": 2097152,
    "staleLockMinutes": 10,
    "archiveCorrupted": false
  },
  "usage": {
    "enabled": true,
    "sessionDirs": ["~/.openclaw/agents"],
    "pollIntervalMs": 30000,
    "retentionDays": 30,
    "persistPath": "~/.openclaw/guardian.usage.json"
  },
  "grafana": {
    "enabled": false,
    "mimirUrl":       "https://prometheus-prod-XX.grafana.net/api/prom/push",
    "lokiUrl":        "https://logs-prod-XX.grafana.net/loki/api/v1/push",
    "user":           "123456",
    "token":          "glc_...",
    "pushIntervalMs": 15000
  },
  "sharedStatePath": "~/.openclaw/guardian.state.json",
  "logPath":         "~/.openclaw/guardian.log",
  "logLevel":        "info"
}
```

**`bindHost`** — set to `0.0.0.0` if you need endpoints reachable from Docker containers (e.g. Prometheus). Defaults to `127.0.0.1`.

### 3. Run

```bash
# Full daemon (healer + usage tracker + metrics server)
npm start

# Healer daemon only
npm run healer

# Single healer scan
npm run once
```

### 4. Systemd service

```ini
# /etc/systemd/system/openclaw-guardian.service
[Unit]
Description=OpenClaw Guardian (session healer + usage tracker)
After=network.target

[Service]
Type=simple
User=wraithy
WorkingDirectory=/home/wraithy/openclaw-guardian
ExecStart=/usr/bin/node bin/start.js
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now openclaw-guardian
```

---

## API Endpoints

### GET `/_guardian/health`

```json
{ "ok": true, "version": 2, "uptime": 3600.5 }
```

### GET `/_guardian/usage`

```json
{
  "models": {
    "openai-codex/gpt-5.4": {
      "requests": 227,
      "inputTokens": 686446,
      "outputTokens": 18108,
      "cacheReadTokens": 2077568,
      "cost": 2.51
    },
    "openrouter/google/gemini-2.5-flash-lite": { ... }
  },
  "daily": {
    "2026-04-06": { "requests": 42, "cost": 0.15, "byModel": { ... } }
  },
  "activeSessions": 8,
  "startedAt": "2026-04-06T12:33:12.000Z"
}
```

### GET `/_guardian/metrics`

Prometheus text format. See metrics table below.

---

## Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `guardian_active_sessions` | gauge | | Currently active sessions (activity in last 60s) |
| `guardian_healer_files_scanned` | gauge | | Files scanned in last healer pass |
| `guardian_healer_repairs_total` | counter | | Sessions successfully repaired |
| `guardian_healer_deletions_total` | counter | | Sessions deleted (unrepairable) |
| `guardian_healer_stale_locks_total` | counter | | Stale lock files removed |
| `guardian_healer_scans_total` | counter | | Total healer scan passes |
| `guardian_healer_compactions_suggested_total` | counter | | Oversized file detections |
| `guardian_model_requests_total` | counter | `model` | Requests per model |
| `guardian_model_input_tokens_total` | counter | `model` | Input tokens per model |
| `guardian_model_output_tokens_total` | counter | `model` | Output tokens per model |
| `guardian_model_cache_read_tokens_total` | counter | `model` | Cache read tokens per model |
| `guardian_model_cost` | gauge | `model` | Cumulative cost in USD per model |
| `guardian_daily_cost` | gauge | `date` | Cost for a given day |
| `guardian_daily_requests` | gauge | `date` | Requests for a given day |

### Grafana

Import `grafana-dashboard.json` into Grafana (Dashboards -> Import -> Upload JSON).

For Prometheus scraping from Docker:

```yaml
scrape_configs:
  - job_name: openclaw-guardian
    static_configs:
      - targets: ['host.docker.internal:4747']
    metrics_path: /_guardian/metrics
```

For Grafana Cloud push, set `grafana.enabled: true` in config with Mimir/Loki URLs and credentials.

---

## Architecture

```
                    +-----------------------+
                    |   Guardian v2 Daemon  |
                    |                       |
~/.openclaw/agents/ |  +-------+ +-------+ |  :4747/_guardian/metrics
   *.jsonl -------->|  |Healer | |Usage  | |--------> Prometheus
                    |  +-------+ |Tracker| |  :4747/_guardian/usage
                    |            +-------+ |--------> JSON API
                    |  +--------+          |  :4747/_guardian/health
                    |  |Exporter|----------|--> Grafana Cloud
                    |  +--------+          |
                    +-----------------------+
```

- **Healer**: Scans every 5s, repairs corrupt sessions, removes stale locks
- **Usage Tracker**: Scans every 30s, reads new JSONL entries via cursors, aggregates per-model stats
- **HTTP Server**: Exposes metrics, health, and usage endpoints
- **Exporter**: Optional push to Grafana Cloud (Mimir + Loki)

---

## Migrating from v1

v1 was a rate-limit proxy for Anthropic API traffic. v2 removes the proxy entirely:

| v1 | v2 |
|----|-----|
| HTTP proxy to api.anthropic.com | Removed (no proxy) |
| Request queue with throttling | Removed |
| Anthropic rate-limit tracking | Removed |
| Session healer (Anthropic-only) | Session healer (multi-provider) |
| Per-session proxy tracking | Per-model usage from JSONL files |
| `proxy.js`, `queue.js`, `sessions.js` | `usage.js` (new) |

Config changes: `proxy` and `sessionTracking` sections replaced by `http` and `usage`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Healer not finding sessions | Check `sessionDirs` in config matches your actual path |
| Usage shows 0 for all models | Wait for next scan (30s) or check session files have `usage` in messages |
| Metrics unreachable from Docker | Set `bindHost: "0.0.0.0"` in `http` config |
| Sessions deleted unexpectedly | Set `archiveCorrupted: true` to rename instead of delete |
| Grafana push fails | Check user/token/URLs in config; inspect `guardian.log` |

---

## License

MIT
