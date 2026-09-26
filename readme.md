# OpenClaw ↔ Claude Code Proxy (Enhanced)

> [!WARNING]
> **Note (2026-09-26):** Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) bar automated access to the Services except through an Anthropic API key or where Anthropic explicitly permits it, and the [Claude help center](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) says subscription usage is designed for ordinary use of Anthropic's own apps, names API key authentication as the preferred route for third-party tools, including open-source projects, and states that tools which attempt to route third-party traffic against subscription limits are prohibited. Routing an agent fleet through a Claude subscription, as this proxy does, falls in that territory. If you want agents to call Claude automatically, use an API key from the [Claude Console](https://platform.claude.com/) and pay per use. We stopped running this proxy ourselves on 2026-09-22.

> Turn your $200/mo Claude Max subscription into a free AI API for your entire agent fleet.

**One proxy. All models. Zero API cost.**

```
Your Agents → This Proxy (localhost:3456) → claude --print → Claude Max subscription
                                                              ↓
                                              Opus 4.6 / Sonnet 4.6 / Haiku 4.5
```

## What's New (Ultra Lab Enhanced)

| Feature | Original | Enhanced |
|---------|----------|----------|
| Usage stats | None | `GET /stats` — requests, tokens, cost savings |
| Multi-model | Opus only | Opus / Sonnet / Haiku via `model` param |
| Retry | None | Auto-retry on CLI failures (`MAX_RETRIES`) |
| Plugin system | None | Pre/post processing hooks (`plugins/` dir) |
| Content filter | None | Blocks API keys, tokens, IPs from responses |
| Cost tracker | None | Daily savings report vs API pricing |
| Language enforcer | None | Auto-detects zh-TW and reinforces language |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/ppcvote/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env — set your API_KEY

# 4. Run
node server.js
```

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Claude Max subscription](https://claude.ai) ($200/mo) — gives unlimited `claude --print` usage
- Node.js 18+

```bash
# Verify CLI works
claude --version
echo "hello" | claude --print
```

## Configuration

```env
PORT=3456                    # Proxy port
API_KEY=sk-your-secret       # Auth key for incoming requests
CLAUDE_CLI_PATH=claude       # Path to claude binary
MAX_CONCURRENT=3             # Max parallel CLI processes
REQUEST_TIMEOUT=300000       # 5 min timeout per request
MAX_RETRIES=1                # Retry failed CLI calls
MAX_TOOL_TURNS=10            # Max tool execution turns
PLUGINS_DIR=./plugins        # Plugin directory
```

## Usage

### OpenAI-compatible API

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### Multi-model routing

```bash
# Opus 4.6 — complex reasoning (default)
"model": "claude-opus-4-6"

# Sonnet 4.6 — fast, good quality
"model": "claude-sonnet-4-6"

# Haiku 4.5 — fastest, lightweight tasks
"model": "claude-haiku-4-5"
```

### Streaming (simulated SSE)

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-6", "messages": [...], "stream": true}'
```

### Usage stats

```bash
curl http://localhost:3456/stats \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Returns:
```json
{
  "totalRequests": 142,
  "totalTokensEstimated": 85000,
  "errors": 2,
  "avgResponseMs": 7200,
  "byModel": { "claude-opus-4-6": { "count": 130, "tokens": 80000 } },
  "estimated_cost_saved": "$6.38 (vs API pricing)"
}
```

## Plugin System

Drop `.js` files in the `plugins/` directory. Each plugin exports:

```javascript
module.exports = {
  name: 'my-plugin',
  description: 'What it does',

  // Modify messages/model before sending to Claude
  preProcess(messages, model) {
    return { messages, model };
  },

  // Modify response text after receiving from Claude
  postProcess(text, model) {
    return text;
  }
};
```

### Built-in plugins

| Plugin | Type | Description |
|--------|------|-------------|
| `content-filter.js` | post | Redacts API keys, tokens, IPs from responses |
| `cost-tracker.js` | post | Tracks daily cost savings to `proxy-cost-savings.json` |
| `language-enforcer.js` | pre | Auto-detects Chinese and reinforces zh-TW language |

## Connect to OpenClaw

Add to your `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "claude-proxy": {
        "baseUrl": "http://127.0.0.1:3456",
        "api": "openai",
        "apiKey": "YOUR_API_KEY",
        "models": [{
          "id": "claude-opus-4-6",
          "name": "Claude Opus 4.6 (via Max subscription)",
          "contextWindow": 200000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0 }
        }]
      }
    }
  }
}
```

## Run as systemd service

```bash
sudo tee /etc/systemd/system/claude-proxy.service << EOF
[Unit]
Description=OpenClaw Claude Code Proxy
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/server.js
WorkingDirectory=/path/to/openclaw-claude-proxy
EnvironmentFile=/path/to/.env
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now claude-proxy
```

## Architecture

```
┌───────────────────────────────────────────────────────┐
│  Your Agent Fleet (OpenClaw / LangChain / custom)     │
│                                                        │
│  Agent 1 ──┐                                          │
│  Agent 2 ──┼── POST /v1/chat/completions ──┐          │
│  Agent 3 ──┘                               │          │
│                                             ▼          │
│  ┌───────────────────────────────────────────────┐    │
│  │  Claude Code Proxy (this project)              │    │
│  │                                                 │    │
│  │  Plugins:  [pre]  → language-enforcer           │    │
│  │            [post] → content-filter              │    │
│  │            [post] → cost-tracker                │    │
│  │                                                 │    │
│  │  Queue: MAX_CONCURRENT=3, auto-retry            │    │
│  │  Stats: GET /stats, GET /health                 │    │
│  └──────────────┬────────────────────────────────┘    │
│                  │                                     │
│                  ▼                                     │
│  ┌───────────────────────────────────────────────┐    │
│  │  claude --print [--model sonnet|haiku]          │    │
│  │  (Claude Code CLI, uses Max subscription)      │    │
│  └───────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

## Cost comparison

| | Anthropic API | Claude Max + This Proxy |
|---|---|---|
| Opus 4.6 | $15/M input, $75/M output | $200/mo flat |
| 100K tokens/day | ~$225/mo | $200/mo |
| 500K tokens/day | ~$1,125/mo | $200/mo |
| Break-even | ~89K tokens/day | Everything above = free |

If your agents generate >89K tokens/day, this proxy saves you money.

## Credits

- Original: [51AutoPilot/openclaw-claude-proxy](https://github.com/51AutoPilot/openclaw-claude-proxy)
- Enhanced by: [Ultra Lab](https://ultralab.tw) — AI product company, Taiwan
- Built with: [OpenClaw](https://github.com/openclaw) + [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## License

MIT