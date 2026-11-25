'use strict';
// Offline smoke test: a fake OpenAI on a local port, then the real server
// against it. Checks transcribe, copilot, notes and access codes.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const fake = http.createServer((req, res) => {
  let n = 0; req.on('data', (c) => { n += c.length; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.endsWith('/audio/transcriptions')) res.end(JSON.stringify({ text: `heard ${n > 100 ? 'audio' : 'nothing'}` }));
    else res.end(JSON.stringify({ choices: [{ message: { content: 'ask about the budget' } }] }));
  });
});

function wav(seconds) { const b = Buffer.alloc(44 + seconds * 32000); b.write('RIFF', 0); return b; }

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-notes-'));
  const { create } = require('../src/server');
  const mk = (extra) => create({
    openaiKey: 'server-key', openaiBase: base, transcribeModel: 'm', copilotProvider: 'openai', copilotModel: 'm',
    httpUrl: '', httpToken: '', agentPath: '', keepKeyEnv: false, allowTools: false, codes: {}, codeDailyMinutes: 1,
    notesDir, hideCredit: false, ...extra,
  });
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

  const open = mk(); const u = await listen(open);
  let r = await fetch(`${u}/api/transcribe`, { method: 'POST', body: wav(2) });
  assert.equal((await r.json()).text, 'heard audio');
  r = await fetch(`${u}/api/copilot`, { method: 'POST', body: JSON.stringify({ transcript: 'hello' }) });
  assert.equal((await r.json()).text, 'ask about the budget');
  r = await fetch(`${u}/api/notes`, { method: 'POST', body: JSON.stringify({ id: '../evil', markdown: '# hi' }) });
  assert.ok((await r.json()).saved && fs.existsSync(path.join(notesDir, 'evil.md')));
  r = await fetch(`${u}/index.html`); assert.equal(r.status, 200);
  r = await fetch(`${u}/../package.json`); assert.notEqual(r.status, 200);

  const coded = mk({ codes: { good: 'openai' } }); const c = await listen(coded);
  r = await fetch(`${c}/api/transcribe`, { method: 'POST', body: wav(2) }); assert.equal(r.status, 401);
  r = await fetch(`${c}/api/transcribe`, { method: 'POST', headers: { 'X-Access-Code': 'bad' }, body: wav(2) }); assert.equal(r.status, 401);
  r = await fetch(`${c}/api/transcribe`, { method: 'POST', headers: { 'X-Access-Code': 'good' }, body: wav(2) }); assert.equal(r.status, 200);
  r = await fetch(`${c}/api/transcribe`, { method: 'POST', headers: { 'X-Access-Code': 'good' }, body: wav(70) }); assert.equal(r.status, 429);
  r = await fetch(`${c}/api/notes`, { method: 'POST', headers: { 'X-Access-Code': 'good' }, body: JSON.stringify({ id: 'x', markdown: 'y' }) });
  assert.equal((await r.json()).saved, false);
  r = await fetch(`${c}/api/config`); assert.equal((await r.json()).needsCode, true);

  console.log('smoke ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
