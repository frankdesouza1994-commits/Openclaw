---
name: openclaw-dashboard
description: Manage the user's live OpenClaw Dashboard. Add, remove, reorder or edit widgets; report the active model, status and token usage; post important alerts. Use when the user asks to change the dashboard, show something on it, or when something important happens that they should see.
metadata: {"openclaw": {"requires": {"bins": ["curl"]}, "emoji": "📊"}}
---

# OpenClaw Dashboard

A local web dashboard (default `http://127.0.0.1:7070`) shows system stats, the
active model and important information. You control it over a small JSON REST API.

Set these once per command (or rely on the defaults):

```bash
DASH="${OPENCLAW_DASHBOARD_URL:-http://127.0.0.1:7070}"
AUTH=(-H "Authorization: Bearer ${DASHBOARD_TOKEN:-}")   # only needed if the dashboard has a token
```

Always send `-H 'content-type: application/json'` with a body. Every write is
validated: on a mistake you get `{"error": "..."}` with a 4xx status. Read it and retry.

## 1. Report the active model (do this whenever it changes)

Merge-update what you are running. Send only the fields you know:

```bash
curl -s -X POST "$DASH/api/model" "${AUTH[@]}" -H 'content-type: application/json' -d '{
  "model": "anthropic/claude-opus-5-5",
  "status": "thinking",
  "task": "Summarising inbox",
  "session": "main",
  "channel": "telegram",
  "contextTokens": 48210,
  "contextWindow": 200000,
  "inputTokens": 1200,
  "outputTokens": 340,
  "costUsd": 0.0123
}'
```

- `status` suggestions: `idle`, `thinking`, `running`, `streaming`, `busy`, `error`.
- Any other keys you add are shown in a details table.
- Send `{"reset": true, ...}` to replace the report instead of merging.
- Reports go stale after 10 minutes; the dashboard then falls back to the
  primary model in `~/.openclaw/openclaw.json`.

## 2. Post important information

```bash
curl -s -X POST "$DASH/api/alerts" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"level":"warning","title":"API quota at 85%","message":"Anthropic usage this month","ttlMs":86400000}'
```

`level` is one of `info`, `success`, `warning`, `error`. `ttlMs` is optional
(auto-expires). Post only what the user really needs to see. List: `GET /api/alerts`.
Dismiss: `DELETE /api/alerts/<id>`. Clear all: `DELETE /api/alerts`.

CPU, memory, disk, GPU temperature and gateway-offline warnings are added
automatically. Don't duplicate them.

## 3. Manage widgets

Discover types and their options first:

```bash
curl -s "$DASH/api/widget-types"
curl -s "$DASH/api/widgets"            # current layout, in order
```

| type | shows | options |
|---|---|---|
| `model` | active model card | – |
| `alerts` | important info feed | `limit`, `levels` |
| `cpu` / `memory` | usage + sparkline | – |
| `disk` | disk usage | `path` (default `/`) |
| `gpu` | NVIDIA GPU stats | – |
| `network` | throughput + IPs | – |
| `system` | host, OS, uptime | – |
| `local-models` | models loaded in Ollama | – |
| `text` | notes (`**bold**`, `` `code` ``) | `text` (required) |
| `kv` | key/value facts | `items` object (required) |
| `json` | value from a JSON URL | `url` (required), `path`, `unit`, `intervalMs` |
| `iframe` | embedded page | `url` (required), `height` |

Sizes: `sm` (1 column), `md` (2), `lg` (3), `full` (whole row).

```bash
# Add (id is optional, it's derived from the title; position is optional, it defaults to the end)
curl -s -X POST "$DASH/api/widgets" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"id":"todo","type":"text","title":"Today","size":"md","options":{"text":"**Ship** the release\nReply to Sam"},"position":0}'

# Update (options are merged; add "replaceOptions": true to overwrite them)
curl -s -X PATCH "$DASH/api/widgets/todo" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"options":{"text":"All done ✅"}}'

# Move: absolute position or relative step
curl -s -X POST "$DASH/api/widgets/todo/move" "${AUTH[@]}" -H 'content-type: application/json' -d '{"position":2}'
curl -s -X POST "$DASH/api/widgets/todo/move" "${AUTH[@]}" -H 'content-type: application/json' -d '{"by":-1}'

# Remove
curl -s -X DELETE "$DASH/api/widgets/todo" "${AUTH[@]}"

# Dashboard title / refresh rate / alert thresholds
curl -s -X PATCH "$DASH/api/dashboard" "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"title":"Home Lab","refreshMs":3000,"thresholds":{"cpu":85,"memory":90,"disk":92,"gpuTemp":80}}'
```

You can also edit `data/dashboard.json` in the dashboard folder directly. It is
watched and reloads live. If you write invalid JSON, the last good layout stays
and an error alert explains what's wrong.

## Rules

- Confirm before removing widgets the user didn't ask you to remove.
- Keep the `model` and `alerts` widgets unless the user explicitly asks otherwise.
- Never put secrets (API keys, tokens, passwords) into widgets or alerts.
- After changing the layout, briefly tell the user what you changed.
