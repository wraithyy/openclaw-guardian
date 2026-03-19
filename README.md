# openclaw-guardian

**Rate-limit aware HTTP proxy + session healer for OpenClaw / Anthropic Claude API**

Runs on Raspberry Pi. Zero external dependencies. Node 22+.

---

## What it does

### Proxy (`src/proxy.js`)
- Sits between OpenClaw and `api.anthropic.com`
- Reads `anthropic-ratelimit-*` response headers
- Throttles/queues requests before hitting 429
- Enters cooldown mode on 429, retries once with backoff
- Exposes `/_guardian/metrics` (Prometheus text) and `/_guardian/health` (JSON)

### Healer (`src/healer.js`)
- Scans `~/.openclaw/agents/**/sessions/*.jsonl`
- Detects: unmatched `tool_use`/`tool_result`, invalid JSON lines, oversized files
- Repairs what it can; deletes (or archives) what it can't
- Removes stale `.jsonl.lock` files older than 10 min
- Skips session writes when proxy is in cooldown

### Grafana integration
- Prometheus `/_guardian/metrics` endpoint — scrape with Grafana Agent or Alloy
- Optional push to **Grafana Cloud Mimir** (metrics via remote_write) + **Loki** (logs)

---

## Setup

### 1. Install

```bash
git clone https://github.com/wraithyy/openclaw-guardian.git
cd openclaw-guardian
# no npm install needed – zero deps
```

### 2. Configure

On first run, `~/.openclaw/guardian.config.json` is created with defaults.
Edit it to taste:

```json
{
  "proxy": {
    "port": 4747,
    "upstreamBase": "https://api.anthropic.com",
    "maxConcurrency": 1,
    "throttle": {
      "warnThreshold": 5,
      "pauseThreshold": 2,
      "delayMin": 500,
      "delayMax": 1500
    },
    "maxRetries": 1,
    "backoffBase": 1000
  },
  "healer": {
    "sessionDirs": ["~/.openclaw/agents"],
    "pollIntervalMs": 5000,
    "maxFileSizeBytes": 2097152,
    "staleLockMinutes": 10,
    "archiveCorrupted": false
  },
  "grafana": {
    "enabled": false,
    "mimirUrl":      "https://prometheus-prod-XX.grafana.net/api/prom/push",
    "lokiUrl":       "https://logs-prod-XX.grafana.net/loki/api/v1/push",
    "user":          "123456",
    "token":         "glc_...",
    "pushIntervalMs": 15000
  },
  "sharedStatePath": "~/.openclaw/guardian.state.json",
  "logPath": "~/.openclaw/guardian.log",
  "logLevel": "info"
}
```

### 3. Point OpenClaw to the proxy

In `~/.openclaw/openclaw.json`, override the Anthropic base URL:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-sonnet-4-6": {
          "params": { "baseUrl": "http://127.0.0.1:4747" }
        },
        "anthropic/claude-haiku-4-5": {
          "params": { "baseUrl": "http://127.0.0.1:4747" }
        }
      }
    }
  }
}
```

> **Note:** Check your OpenClaw version docs — the exact config key may be
> `baseUrl`, `apiBase`, or set via env `ANTHROPIC_BASE_URL=http://127.0.0.1:4747`.

### 4. Run

```bash
# Both proxy + healer (+ Grafana exporter if enabled)
npm start

# Proxy only
npm run proxy

# Healer only (daemon)
npm run healer

# Single scan pass
npm run once
```

### 5. Run as a service (systemd)

```ini
# /etc/systemd/system/openclaw-guardian.service
[Unit]
Description=OpenClaw Guardian
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

## Metrics & Grafana

### Prometheus scrape

```yaml
# prometheus.yml / Alloy / Grafana Agent config
scrape_configs:
  - job_name: openclaw-guardian
    static_configs:
      - targets: ['127.0.0.1:4747']
    metrics_path: /_guardian/metrics
```

### Available metrics

| Metric | Type | Description |
|--------|------|-------------|
| `guardian_remaining_requests` | gauge | Requests left in current window |
| `guardian_remaining_tokens` | gauge | Tokens left in current window |
| `guardian_cooldown` | gauge | 1 = in cooldown, 0 = normal |
| `guardian_queue_length` | gauge | Pending requests in queue |
| `guardian_at_risk` | gauge | 1 = healer paused due to cooldown |
| `guardian_sessions_scanned` | gauge | Files scanned in last healer pass |
| `guardian_requests_total` | counter | Total forwarded requests |
| `guardian_throttles_total` | counter | Times throttle delay was applied |
| `guardian_429s_total` | counter | Times 429 received from Anthropic |
| `guardian_sessions_repaired_total` | counter | Sessions successfully repaired |
| `guardian_sessions_deleted_total` | counter | Sessions deleted (unrepairable) |
| `guardian_stale_locks_removed_total` | counter | Stale lock files removed |
| `guardian_scan_runs_total` | counter | Total healer scan runs |

### Grafana Cloud push

Set `grafana.enabled: true` in `~/.openclaw/guardian.config.json` and fill in
your Mimir + Loki URLs, numeric user ID, and API token.

Metrics are pushed via **Prometheus remote_write** (protobuf + snappy, no external deps).
Logs are pushed via **Loki JSON API**.

The exporter runs every `pushIntervalMs` ms (default 15 s) when `npm start` is used.
The push is a no-op when `grafana.enabled` is `false`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| OpenClaw still hits 429 | Verify `baseUrl` is pointing to `http://127.0.0.1:4747` |
| Healer not finding sessions | Check `sessionDirs` in config matches your actual path |
| Proxy not starting | Check port 4747 isn't in use: `lsof -i :4747` |
| Metrics endpoint returns nothing | Verify guardian is running: `curl http://127.0.0.1:4747/_guardian/health` |
| Grafana push fails | Verify user/token and URLs; check `guardian.log` |
| Sessions deleted unexpectedly | Set `archiveCorrupted: true` to rename instead of delete |

---

## Logs

Structured JSON logs at `~/.openclaw/guardian.log`:

```json
{"ts":"2026-03-18T14:00:00.000Z","level":"warn","message":"429 from Anthropic","attempt":0,"url":"/v1/messages"}
{"ts":"2026-03-18T14:00:05.000Z","level":"warn","message":"Orphaned tool_use – removing","filePath":"...","orphaned":["toolu_01..."]}
```
