'use strict';
// Copilot providers. Each takes { system, user } and returns plain text.
// The CLI agents run text-only by default: no tools, no MCP servers, an empty
// temp dir as cwd, and provider API keys stripped from their environment so
// they use the subscription login of whoever runs this server.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

function findAgent(name, override) {
  if (override && fs.existsSync(override)) return override;
  if (process.platform !== 'win32') {
    try {
      const sh = process.env.SHELL || '/bin/sh';
      const out = execFileSync(sh, ['-lic', `command -v ${name}`], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split('\n').pop();
      if (out && out.startsWith('/') && fs.existsSync(out)) return out;
    } catch { /* fall through to known paths */ }
  }
  const home = os.homedir();
  const dirs = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.npm-global/bin')];
  const nvm = path.join(home, '.nvm/versions/node');
  try { for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, 'bin')); } catch { /* no nvm */ }
  for (const d of dirs) {
    const p = path.join(d, process.platform === 'win32' ? `${name}.cmd` : name);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function run(bin, args, input, { keepKeyEnv, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kilazi-live-'));
    const env = { ...process.env };
    if (!keepKeyEnv) for (const k of KEY_VARS) delete env[k];
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      fs.rm(cwd, { recursive: true, force: true }, () => {});
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error((err || out || `exit ${code}`).trim().slice(-400)));
    });
    child.stdin.end(input);
  });
}

async function openaiChat(cfg, key, { system, user }) {
  const r = await fetch(`${cfg.openaiBase}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.copilotModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 500,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `OpenAI ${r.status}`);
  return (j.choices?.[0]?.message?.content || '').trim();
}

function claudeCli(cfg, bin, { system, user }) {
  const args = ['-p', '--output-format', 'text', '--system-prompt', system, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  if (!cfg.allowTools) args.push('--tools', '');
  return run(bin, args, user, cfg);
}

function codexCli(cfg, bin, { system, user }) {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', cfg.allowTools ? 'workspace-write' : 'read-only', '-'];
  return run(bin, args, `${system}\n\n${user}`, cfg);
}

async function httpToken(cfg, { system, user, transcript }) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.httpToken) headers.Authorization = `Bearer ${cfg.httpToken}`;
  const r = await fetch(cfg.httpUrl, { method: 'POST', headers, body: JSON.stringify({ system, prompt: user, transcript }) });
  const body = await r.text();
  if (!r.ok) throw new Error(`endpoint ${r.status}: ${body.slice(0, 200)}`);
  try { const j = JSON.parse(body); return String(j.text ?? j.output ?? j.answer ?? body).trim(); } catch { return body.trim(); }
}

function detect(cfg) {
  return {
    claude: findAgent('claude', cfg.copilotProvider === 'claude' ? cfg.agentPath : ''),
    codex: findAgent('codex', cfg.copilotProvider === 'codex' ? cfg.agentPath : ''),
  };
}

module.exports = { openaiChat, claudeCli, codexCli, httpToken, detect, KEY_VARS };
