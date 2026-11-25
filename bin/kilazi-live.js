#!/usr/bin/env node
'use strict';
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`kilazi-live needs Node 18 or newer (you have ${process.versions.node}). Get it at https://nodejs.org`);
  process.exit(1);
}
const { spawn } = require('child_process');
const net = require('net');
const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`kilazi-live: live call transcript + copilot in your browser

  npx github:kilazi/kilazi-live [--port 4321] [--host 127.0.0.1] [--provider openai|claude|codex|http]
                                [--agent-path /path/to/claude] [--allow-tools] [--keep-key-env] [--no-open]

Settings live in a .env next to where you run it (see example.env).`);
  process.exit(0);
}

const cfg = require('../src/config').load(argv);
const { create } = require('../src/server');

function freePort(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(port + 1, host)));
    s.listen(port, host, () => s.close(() => resolve(port)));
  });
}

(async () => {
  const want = cfg.port;
  const port = await freePort(want, cfg.host);
  const server = create(cfg);
  server.listen(port, cfg.host, () => {
    const url = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${port}`;
    if (port !== want) console.log(`port ${want} is busy, using ${port}`);
    console.log(`kilazi-live running at ${url}`);
    const codes = Object.keys(cfg.codes).length;
    if (codes) console.log(`access codes on (${codes}); guests use the server key, capped at ${cfg.codeDailyMinutes} min a day each`);
    else if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host) && cfg.openaiKey)
      console.log('warning: listening beyond localhost with a server key and no ACCESS_CODES; anyone who reaches this port spends your key');
    if (!cfg.openaiKey) console.log('no OPENAI_API_KEY set: paste your key in the page (Settings) or add it to .env');
    if (cfg.allowTools) console.log('warning: --allow-tools is on; your agent can run commands and anyone on the call can try to steer it');
    if (cfg.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
