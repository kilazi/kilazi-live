'use strict';
// Settings come from the environment, optionally from a .env file in the
// directory you start kilazi-live from. Nothing has a default host, key or
// account: an empty config is a valid config.
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

// ACCESS_CODES="code1=openai,code2=claude"  ->  { code1: 'openai', code2: 'claude' }
function parseCodes(s) {
  const out = {};
  for (const part of String(s || '').split(',')) {
    const [code, provider] = part.split('=').map((x) => (x || '').trim());
    if (code) out[code] = provider || 'openai';
  }
  return out;
}

function load(argv = []) {
  loadDotEnv(path.join(process.cwd(), '.env'));
  const flag = (name) => argv.includes(name);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const e = process.env;
  return {
    host: opt('--host') || e.HOST || '127.0.0.1',
    port: Number(opt('--port') || e.PORT || 4321),
    open: !flag('--no-open') && e.NO_OPEN !== '1' && !e.CI,
    openaiKey: e.OPENAI_API_KEY || '',
    openaiBase: (e.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    transcribeModel: e.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
    copilotProvider: opt('--provider') || e.COPILOT_PROVIDER || 'openai',
    copilotModel: e.COPILOT_MODEL || 'gpt-4o-mini',
    httpUrl: e.COPILOT_HTTP_URL || '',
    httpToken: e.COPILOT_HTTP_TOKEN || '',
    agentPath: opt('--agent-path') || e.AGENT_PATH || '',
    keepKeyEnv: flag('--keep-key-env') || e.KEEP_KEY_ENV === '1',
    allowTools: flag('--allow-tools'),
    codes: parseCodes(e.ACCESS_CODES),
    codeDailyMinutes: Number(e.CODE_DAILY_MINUTES || 120),
    notesDir: path.resolve(e.NOTES_DIR || 'kilazi-live-notes'),
    hideCredit: e.HIDE_CREDIT === '1',
  };
}

module.exports = { load, parseCodes };
