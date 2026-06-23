# CLAUDE.md — Project Guide

## What is this?

OpenClaw Claude Code Proxy — turns a Claude Max subscription ($200/mo) into an OpenAI-compatible API. Incoming requests hit `POST /v1/chat/completions`, get translated into `claude --print` CLI calls, and return OpenAI-formatted responses.

## How to run

```bash
# Install dependencies (first time only)
npm install

# Start the server
npm start
```

The server runs on port 3456 by default. Config is in `.env` (auto-loaded by dotenv).

## Key files

- `server.js` — the entire server (single file)
- `.env` — configuration (port, API key, concurrency, etc.)
- `plugins/` — pre/post processing hooks (auto-loaded on startup)

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/chat/completions` | Yes | OpenAI-compatible chat API |
| GET | `/v1/models` | Yes | List available models |
| GET | `/health` | No | Health check |
| GET | `/stats` | Yes | Usage dashboard |

## Environment variables (.env)

- `PORT` — server port (default: 3456)
- `API_KEY` — bearer token for auth (if empty, auth is disabled)
- `CLAUDE_CLI_PATH` — path to `claude` binary (default: `claude`)
- `MAX_CONCURRENT` — max parallel CLI processes (default: 3)
- `REQUEST_TIMEOUT` — timeout per request in ms (default: 300000)
- `MAX_RETRIES` — retry failed CLI calls (default: 1)

## Prerequisites

- Node.js 18+
- Claude Code CLI installed and authenticated (`claude --version`)
- Claude Max subscription (for unlimited `claude --print`)

## Testing

```bash
# Health check
curl http://localhost:3456/health

# Chat completion (replace with your API_KEY from .env)
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-6", "messages": [{"role": "user", "content": "Hello"}]}'
```
