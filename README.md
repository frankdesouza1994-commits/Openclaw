# OpenClaw Dashboard

A live, self-hosted dashboard for your [OpenClaw](https://openclaw.ai) agent. It shows
the **active model** (status, context and token usage, cost), **system stats**
(CPU, memory, disk, GPU, network, host) and **important information** (alerts).
OpenClaw can **add, remove, move and edit widgets** itself.

- Zero dependencies: Node ≥ 18.15 only (OpenClaw already needs Node 22)
- Live updates over Server-Sent Events, with no page reloads
- Light and dark themes, works on a phone
- The layout lives in a plain JSON file (`data/dashboard.json`) that is watched for changes

## Quick start

```bash
git clone <this repo> openclaw-dashboard && cd openclaw-dashboard
npm start                     # → http://127.0.0.1:7070
```

## Connect it to OpenClaw

1. **Install the skill** so the agent knows how to drive the dashboard:

   ```bash
   mkdir -p ~/.openclaw/workspace/skills
   cp -r skills/openclaw-dashboard ~/.openclaw/workspace/skills/
   ```

   Start a new session (or restart the gateway) so OpenClaw picks it up. Then
   you can just ask: *"add a widget showing disk usage for /mnt/data"*, *"remove the
   network widget"*, *"post an alert when the backup finishes"*.

2. **Model info** comes from three sources, in this order:
   1. What OpenClaw reports via `POST /api/model`. The skill tells it to do this;
      you can also add a line to your `HEARTBEAT.md` / `AGENTS.md` such as
      *"Report your current model, status and token usage to the dashboard."*
   2. The primary model and fallbacks from `~/.openclaw/openclaw.json`.
   3. Models currently loaded in Ollama (`/api/ps`).

   The dashboard also pings the OpenClaw gateway (default `http://127.0.0.1:18789`)
   and raises an alert if it goes offline.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7070` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` for LAN access, and set a token if you do |
| `DASHBOARD_TOKEN` | – | If set, every write needs `Authorization: Bearer <token>` |
| `DATA_DIR` | `./data` | Where the layout, alerts and last model report are stored |
| `OPENCLAW_CONFIG` | `~/.openclaw/openclaw.json` | OpenClaw config to read the primary model from |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | Gateway health check |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local model discovery |
| `MODEL_STALE_MS` | `600000` | When a model report counts as stale |

If you set a token, OpenClaw needs it too (`DASHBOARD_TOKEN` in its environment),
and the browser asks for it the first time you edit.

## Widgets

`model`, `alerts`, `cpu`, `memory`, `disk`, `gpu` (NVIDIA via `nvidia-smi`), `network`,
`system`, `local-models` (Ollama), `text`, `kv`, `json` (a value from any JSON URL),
`iframe`. Sizes: `sm`, `md`, `lg`, `full`. `GET /api/widget-types` describes every type and its options.

You can also edit widgets in the browser: click **Edit** to add, reorder or remove them.

## API

| Method & path | What it does |
|---|---|
| `GET /api/dashboard` · `PUT` · `PATCH` | Whole layout; `PATCH` sets `title`, `refreshMs`, `thresholds` |
| `GET /api/widgets` · `POST` | List widgets, or add one (`position` optional) |
| `GET/PATCH/DELETE /api/widgets/:id` | Read, update (options merge) or remove a widget |
| `POST /api/widgets/:id/move` | `{"position": n}` or `{"by": ±1}` |
| `GET /api/model` · `POST` · `DELETE` | Model snapshot; OpenClaw reports (merges) with `POST` |
| `GET /api/alerts` · `POST` · `DELETE` | Alerts (`level`, `title`, `message`, `ttlMs`) |
| `DELETE /api/alerts/:id` | Dismiss one alert |
| `GET /api/stats` | Raw system stats |
| `GET /api/events` | SSE stream: `dashboard`, `stats`, `model`, `alerts` |

The default alert thresholds are 90% for CPU, memory and disk, and 85°C for the GPU.
Change them with `PATCH /api/dashboard {"thresholds": {...}}`.

## Run it as a service (systemd, user)

```ini
# ~/.config/systemd/user/openclaw-dashboard.service
[Unit]
Description=OpenClaw Dashboard
[Service]
WorkingDirectory=%h/openclaw-dashboard
ExecStart=/usr/bin/env node server.js
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now openclaw-dashboard
```

## Tests

```bash
npm test
```
