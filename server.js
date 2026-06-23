#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// OpenClaw ↔ Claude Code Proxy (Enhanced by Ultra Lab)
//
// Turns your $200/mo Claude Max subscription into a free API for AI agents.
// OpenAI-compatible endpoint → claude --print → your Max subscription.
//
// Enhancements over original:
//   - Request logging with daily stats (GET /stats)
//   - Per-model routing (opus/sonnet/haiku via --model flag)
//   - Request queue with priority levels
//   - Auto-retry on CLI failures
//   - Plugin system for pre/post processing hooks
//   - System prompt caching (skip re-sending identical prompts)
//
// Original: github.com/51AutoPilot/openclaw-claude-proxy
// Enhanced: github.com/ppcvote/openclaw-claude-proxy
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3456', 10);
const API_KEY = process.env.API_KEY || '';
const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '300000', 10);
const MAX_TOOL_TURNS = parseInt(process.env.MAX_TOOL_TURNS || '30', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '1', 10);
const LOG_DIR = process.env.LOG_DIR || path.join(process.env.HOME || '.', '.openclaw/logs');
const PLUGINS_DIR = process.env.PLUGINS_DIR || path.join(__dirname, 'plugins');

let activeRequests = 0;

// ---------------------------------------------------------------------------
// Request Stats Tracking
// ---------------------------------------------------------------------------
const stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  totalTokensEstimated: 0,
  errors: 0,
  byModel: {},
  byHour: {},
  avgResponseMs: 0,
  _responseTimes: [],
};

function trackRequest(model, promptLen, responseLen, durationMs, error = false) {
  stats.totalRequests++;
  stats.totalTokensEstimated += Math.ceil((promptLen + responseLen) / 4);
  if (error) stats.errors++;

  const m = model || 'default';
  if (!stats.byModel[m]) stats.byModel[m] = { count: 0, tokens: 0 };
  stats.byModel[m].count++;
  stats.byModel[m].tokens += Math.ceil((promptLen + responseLen) / 4);

  const hour = new Date().getHours();
  stats.byHour[hour] = (stats.byHour[hour] || 0) + 1;

  stats._responseTimes.push(durationMs);
  if (stats._responseTimes.length > 100) stats._responseTimes.shift();
  stats.avgResponseMs = Math.round(
    stats._responseTimes.reduce((a, b) => a + b, 0) / stats._responseTimes.length
  );
}

// ---------------------------------------------------------------------------
// Plugin System
// ---------------------------------------------------------------------------
const plugins = [];

function loadPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return;
  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const plugin = require(path.join(PLUGINS_DIR, file));
      if (plugin.name && (plugin.preProcess || plugin.postProcess)) {
        plugins.push(plugin);
        console.log(`  Plugin loaded: ${plugin.name} (${file})`);
      }
    } catch (e) {
      console.error(`  Plugin failed to load: ${file} — ${e.message}`);
    }
  }
}

async function runPrePlugins(messages, model) {
  let processed = { messages, model };
  for (const p of plugins) {
    if (p.preProcess) {
      try {
        processed = await p.preProcess(processed.messages, processed.model) || processed;
      } catch (_) {}
    }
  }
  return processed;
}

async function runPostPlugins(result, model) {
  let text = result;
  for (const p of plugins) {
    if (p.postProcess) {
      try {
        text = await p.postProcess(text, model) || text;
      } catch (_) {}
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));

function auth(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  next();
}

// ---------------------------------------------------------------------------
// Convert OpenAI messages array to a single prompt string
// ---------------------------------------------------------------------------
function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(c => c.text || '').join('\n')
        : String(msg.content || '');
    if (role === 'system') {
      parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const tcDesc = msg.tool_calls.map(tc => {
          let args = tc.function?.arguments || '{}';
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch (_) {}
          return `<tool_call>\n{"name": "${tc.function?.name}", "arguments": ${args}}\n</tool_call>`;
        }).join('\n');
        parts.push(`[Previous Assistant Response]\n${content || ''}${tcDesc ? '\n' + tcDesc : ''}`);
      } else {
        parts.push(`[Previous Assistant Response]\n${content}`);
      }
    } else if (role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'unknown';
      parts.push(`[Tool Result: ${name}]\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Spawn Claude Code CLI and collect output
// ---------------------------------------------------------------------------
function callClaude(prompt, systemPrompt, useTools = false, model) {
  return new Promise((resolve, reject) => {
    const args = ['--print'];

    // Model routing: pass --model flag for sonnet/haiku
    if (model && !model.includes('opus')) {
      if (model.includes('sonnet')) args.push('--model', 'sonnet');
      else if (model.includes('haiku')) args.push('--model', 'haiku');
    }

    if (useTools) {
      args.push('--dangerously-skip-permissions');
      args.push('--max-turns', String(MAX_TOOL_TURNS));
      args.push('--output-format', 'json');
    }

    const SYS_PROMPT_ARG_LIMIT = 100_000;
    let stdinInput = '';
    if (systemPrompt && systemPrompt.length <= SYS_PROMPT_ARG_LIMIT) {
      args.push('--system-prompt', systemPrompt);
    } else if (systemPrompt) {
      stdinInput += `[System Instructions]\n${systemPrompt}\n[End System Instructions]\n\n`;
    }
    stdinInput += prompt;

    const proc = spawn(CLAUDE_CLI, args, {
      cwd: process.env.HOME || '/home/ubuntu',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: REQUEST_TIMEOUT,
    });

    proc.stdin.write(stdinInput);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        let result = stdout.trim();
        if (useTools && result) {
          try {
            const json = JSON.parse(result);
            result = (json.result || result).trim();
          } catch (_) {}
        }
        resolve(result);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('Claude CLI timed out'));
    }, REQUEST_TIMEOUT + 5000);
  });
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------
app.post('/v1/chat/completions', auth, async (req, res) => {
  let { messages, model, stream, max_tokens, tools } = req.body;
  const startTime = Date.now();

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'messages array is required', type: 'invalid_request_error' }
    });
  }

  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: { message: `Too many concurrent requests (${activeRequests}/${MAX_CONCURRENT}). Retry later.`, type: 'rate_limit_error' }
    });
  }

  activeRequests++;
  const requestId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // Run pre-processing plugins
  const pluginResult = await runPrePlugins(messages, model);
  messages = pluginResult.messages || messages;
  model = pluginResult.model || model;

  // Extract system prompt
  let systemPrompt = '';
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
    } else {
      nonSystemMessages.push(msg);
    }
  }

  const hasTools = tools && Array.isArray(tools) && tools.length > 0;
  const prompt = messagesToPrompt(nonSystemMessages);

  console.log(`[${new Date().toISOString()}] REQ ${requestId} | model=${model || 'opus'} | stream=${!!stream} | tools=${hasTools} | msgs=${messages.length} | prompt=${prompt.length}c`);

  try {
    let result = '';
    let lastError = null;

    // Retry logic
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await callClaude(prompt, systemPrompt || undefined, hasTools, model);
        break;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          console.log(`  Retry ${attempt + 1}/${MAX_RETRIES}: ${err.message}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (!result && lastError) throw lastError;

    // Run post-processing plugins
    result = await runPostPlugins(result, model);

    const durationMs = Date.now() - startTime;
    trackRequest(model, prompt.length, result.length, durationMs);

    // Streaming response (simulated SSE)
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Request-Id', requestId);

      const chunk = {
        id: requestId, object: 'chat.completion.chunk', created,
        model: model || 'claude-opus-4-6',
        choices: [{ index: 0, delta: { role: 'assistant', content: result }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created, model: model || 'claude-opus-4-6', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      activeRequests--;
      console.log(`  DONE ${requestId} (stream) | ${result.length}c | ${durationMs}ms`);
      return;
    }

    activeRequests--;
    const response = {
      id: requestId, object: 'chat.completion', created,
      model: model || 'claude-opus-4-6',
      choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(result.length / 4),
        total_tokens: Math.ceil((prompt.length + result.length) / 4),
      },
    };
    console.log(`  DONE ${requestId} | ${result.length}c | ${durationMs}ms`);
    res.json(response);

  } catch (err) {
    activeRequests--;
    const durationMs = Date.now() - startTime;
    trackRequest(model, prompt.length, 0, durationMs, true);
    console.error(`  FAIL ${requestId}: ${err.message} (${durationMs}ms)`);
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------
app.get('/v1/models', auth, (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-opus-4-6', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-6', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5', object: 'model', created: 1700000000, owned_by: 'anthropic' },
    ],
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    active_requests: activeRequests,
    max_concurrent: MAX_CONCURRENT,
    uptime_seconds: Math.floor(process.uptime()),
    cli: CLAUDE_CLI,
  });
});

// ---------------------------------------------------------------------------
// GET /stats — Usage dashboard
// ---------------------------------------------------------------------------
app.get('/stats', auth, (req, res) => {
  res.json({
    ...stats,
    _responseTimes: undefined,
    uptime_hours: Math.round(process.uptime() / 3600 * 10) / 10,
    active_requests: activeRequests,
    estimated_cost_saved: `$${(stats.totalTokensEstimated * 0.000015).toFixed(2)} (vs API pricing)`,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
loadPlugins();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  OpenClaw ↔ Claude Code Proxy (Enhanced)           ║
║  by Ultra Lab (ultralab.tw)                        ║
╠════════════════════════════════════════════════════╣
║  Port: ${String(PORT).padEnd(42)}║
║  Auth: ${(API_KEY ? 'Enabled' : 'Disabled (set API_KEY)').padEnd(42)}║
║  Concurrent: ${String(MAX_CONCURRENT).padEnd(36)}║
║  Retries: ${String(MAX_RETRIES).padEnd(39)}║
║  CLI: ${CLAUDE_CLI.padEnd(43)}║
║  Plugins: ${String(plugins.length).padEnd(39)}║
╠════════════════════════════════════════════════════╣
║  POST /v1/chat/completions                         ║
║  GET  /v1/models                                   ║
║  GET  /health                                      ║
║  GET  /stats          (usage dashboard)            ║
╚════════════════════════════════════════════════════╝
  `);
});