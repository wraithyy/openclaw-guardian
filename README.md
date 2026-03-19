# openclaw-guardian

**Rate-limit aware HTTP proxy + session healer for OpenClaw / Anthropic Claude API**

Zero external dependencies. Node 22+.

---

## What it does

### Proxy
Sits between OpenClaw and `api.anthropic.com`. Queues concurrent requests, applies throttle delays when rate limits get tight, and enters cooldown on 429 until the window resets. Supports both the legacy per-resource headers and the new **unified rate-limit system** (`anthropic-ratelimit-unified-*`).

### Healer
Scans OpenClaw session files (`.jsonl`) on a configurable interval. Detects and repairs corrupted tool use/result pairs, invalid JSON lines, and oversized files. Removes stale lock files. Skips writes when the proxy is in cooldown to avoid compounding problems.

### Observability
- `/_guardian/metrics` — Prometheus text format, scraped by Grafana Alloy/Agent
- `/_guardian/health` — JSON health check
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

On first run, `~/.openclaw/guardian.config.json` is created with defaults. The full schema:

```json
{
  "proxy": {
    "port": 4747,
    "bindHost": "127.0.0.1",
    "upstreamBase": "https://api.anthropic.com",
    "maxConcurrency": 5,
    "throttle": {
      "warnThreshold": 3,
      "pauseThreshold": 1,
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

**`bindHost`** — set to `0.0.0.0` if you need the metrics endpoint reachable from Docker containers (e.g. Prometheus in a compose stack). Defaults to `127.0.0.1`.

### 3. Point OpenClaw to the proxy

In `~/.openclaw/openclaw.json`, override the Anthropic base URL per model:

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

### 4. Run

```bash
# Proxy + healer (recommended)
npm start

# Proxy only
npm run proxy

# Healer daemon
npm run healer

# Single healer scan
npm run once
```

### 5. Systemd service

```ini
# /etc/systemd/system/openclaw-guardian.service
[Unit]
Description=OpenClaw Guardian (proxy + session healer)
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

### Local Prometheus scrape (recommended)

If Prometheus runs in Docker, set `bindHost: "0.0.0.0"` (or `"172.17.0.1"`) in the config and add `extra_hosts: ["host.docker.internal:host-gateway"]` to the Prometheus container:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: openclaw-guardian
    static_configs:
      - targets: ['host.docker.internal:4747']
    metrics_path: /_guardian/metrics
```

### Loki log collection (Grafana Alloy)

```alloy
local.file_match "guardian" {
  path_targets = [{
    __path__ = "/path/to/.openclaw/guardian.log",
    job      = "guardian",
  }]
}

loki.source.file "guardian" {
  targets    = local.file_match.guardian.targets
  forward_to = [loki.process.guardian.receiver]
}

loki.process "guardian" {
  stage.json {
    expressions = {
      level     = "level",
      component = "component",
      message   = "message",
      error     = "error",
    }
  }
  stage.labels {
    values = { level = "level", component = "component" }
  }
  forward_to = [loki.write.default.receiver]
}
```

### Grafana dashboard

Import `grafana-dashboard.json` into Grafana (Dashboards → Import → Upload JSON).

### Available metrics

| Metric | Type | Description |
|--------|------|-------------|
| `guardian_unified_5h_utilization` | gauge | Anthropic unified 5h token utilization (0–1) |
| `guardian_unified_7d_utilization` | gauge | Anthropic unified 7d token utilization (0–1) |
| `guardian_unified_throttled` | gauge | 1 = throttled/blocked by Anthropic, 0 = allowed |
| `guardian_remaining_requests` | gauge | Requests left in window (legacy API, -1 if unknown) |
| `guardian_remaining_tokens` | gauge | Tokens left in window (legacy API, -1 if unknown) |
| `guardian_cooldown` | gauge | 1 = proxy in cooldown, 0 = normal |
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

> **Note:** Anthropic switched to a unified rate-limit system in early 2026. The legacy `remaining_requests` / `remaining_tokens` metrics will show `-1` on accounts using the new system. Use `unified_5h_utilization` and `unified_7d_utilization` instead.

### Grafana Cloud push (optional)

Set `grafana.enabled: true` and fill in Mimir/Loki URLs, numeric user ID, and API token. Metrics are pushed via Prometheus remote_write (protobuf + snappy). Logs via Loki JSON API. No external npm packages required.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| OpenClaw still hits 429 | Verify `baseUrl` points to `http://127.0.0.1:4747` |
| `remaining_requests` always `-1` | Normal on new Anthropic unified rate-limit accounts — use `unified_5h_utilization` |
| Healer not finding sessions | Check `sessionDirs` in config matches your actual path |
| Proxy not starting | Check port isn't in use: `lsof -i :4747` |
| Metrics unreachable from Docker | Set `bindHost: "0.0.0.0"` and add `extra_hosts` to Prometheus container |
| Sessions deleted unexpectedly | Set `archiveCorrupted: true` to rename instead of delete |
| Grafana push fails | Check user/token/URLs in config; inspect `guardian.log` |

---

## Logs

Structured JSON at `~/.openclaw/guardian.log`:

```json
{"ts":"2026-03-19T12:40:15.359Z","level":"info","message":"Rate-limit headers","anthropic-ratelimit-unified-status":"allowed","anthropic-ratelimit-unified-5h-utilization":"0.44"}
{"ts":"2026-03-19T12:00:00.000Z","level":"warn","message":"429 from Anthropic","attempt":0,"url":"/v1/messages"}
{"ts":"2026-03-19T12:00:05.000Z","level":"warn","message":"Orphaned tool_use – removing","filePath":"...","orphaned":["toolu_01..."]}
```
