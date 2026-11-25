'use strict';
// Kilazi Live, browser side: capture, cut on silence, upload, show.
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d = '') => { try { return localStorage.getItem('kl.' + k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('kl.' + k, v); } catch { /* private mode */ } },
  };
  const RATE = 16000;
  let cfg = { providers: [] };
  let state = null; // the running call
  const lines = []; // { seq, at, text }

  // ---------- server config + settings ----------
  function headers(extra = {}) {
    const h = { ...extra };
    const code = store.get('code'), key = store.get('key'), provider = store.get('provider');
    if (code) h['X-Access-Code'] = code;
    else if (key) h['X-OpenAI-Key'] = key;
    if (provider) h['X-Provider'] = provider;
    return h;
  }

  async function loadConfig() {
    cfg = await fetch('/api/config').then((r) => r.json()).catch(() => cfg);
    $('codeRow').hidden = !cfg.needsCode;
    $('credit').hidden = !!cfg.hideCredit;
    $('tools').hidden = !cfg.allowTools;
    const sel = $('provider');
    sel.innerHTML = '';
    const names = { openai: 'OpenAI', claude: 'Claude Code (this machine)', codex: 'Codex (this machine)', http: 'Token endpoint' };
    const list = cfg.providers.length ? cfg.providers : ['openai'];
    for (const p of list) sel.add(new Option(names[p] || p, p));
    sel.value = list.includes(store.get('provider')) ? store.get('provider') : (list.includes(cfg.provider) ? cfg.provider : list[0]);
    $('code').value = store.get('code');
    $('key').value = store.get('key');
    $('lang').value = store.get('lang');
    $('settingsNote').textContent = cfg.needsCode
      ? 'This server hands out access codes. Enter yours, or use your own OpenAI key instead.'
      : cfg.serverKey ? 'This server has its own key. Your key is optional.' : 'Paste your OpenAI key to start.';
    tagProvider();
    if (!cfg.serverKey && !store.get('code') && !store.get('key')) $('settings').showModal();
  }
  function tagProvider() {
    const code = store.get('code');
    $('providerTag').textContent = code ? 'via access code' : ($('provider').value || 'openai');
  }
  $('openSettings').onclick = () => $('settings').showModal();
  $('settings').addEventListener('close', () => {
    store.set('code', $('code').value.trim());
    store.set('key', $('key').value.trim());
    store.set('provider', $('provider').value);
    store.set('lang', $('lang').value);
    tagProvider();
  });
  if (!store.get('consent')) $('consent').hidden = false;
  $('consentOk').onclick = () => { store.set('consent', '1'); $('consent').hidden = true; };

  function banner(text) { $('banner').textContent = text; $('banner').hidden = !text; }
  function status(text) { $('status').textContent = text; }

  // ---------- capture ----------
  const WORKLET = `class Tap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === 2048) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
      return true;
    }
  } registerProcessor('tap', Tap);`;

  function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }
  function meter(analyser, el) {
    if (!analyser) return 0;
    const a = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(a);
    const v = rms(a);
    el.style.backgroundSize = Math.min(100, v * 600) + '% 100%';
    return v;
  }

  async function start(withTab) {
    if (state) return;
    banner('');
    let mic, tab;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { return banner('No microphone: allow mic access for this page and try again.'); }
    if (withTab) {
      try {
        tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
      } catch (e) { mic.getTracks().forEach((t) => t.stop()); return banner('Share was cancelled. Press Start again and pick your call tab.'); }
      if (!tab.getAudioTracks().length) banner("Only your mic is coming in. Share again and tick 'Also share tab audio' in Chrome's dialog.");
    }
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
    const tap = new AudioWorkletNode(ctx, 'tap');
    const mix = ctx.createGain();
    const mute = ctx.createGain(); mute.gain.value = 0;
    mix.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
    const micSrc = ctx.createMediaStreamSource(mic);
    const micAn = ctx.createAnalyser(); micAn.fftSize = 1024;
    micSrc.connect(mix); micSrc.connect(micAn);
    let tabAn = null;
    if (tab && tab.getAudioTracks().length) {
      const tabSrc = ctx.createMediaStreamSource(new MediaStream(tab.getAudioTracks()));
      tabAn = ctx.createAnalyser(); tabAn.fftSize = 1024;
      tabSrc.connect(mix); tabSrc.connect(tabAn);
    }
    if (tab) tab.getVideoTracks().forEach((t) => t.addEventListener('ended', stop));
    state = {
      ctx, mic, tab, tap, micAn, tabAn, t0: Date.now(), seq: 0,
      id: new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'),
      seg: { frames: [], speechMs: 0, silenceMs: 0, startAt: Date.now() }, preroll: [],
      floor: 0.01, tabSilentMs: 0, warnedTab: false, copilotCount: 0, lastCopilotLen: 0,
    };
    tap.port.onmessage = (ev) => onFrame(ev.data);
    state.timer = setInterval(tick, 250);
    state.copilotTimer = setInterval(() => { if ($('auto').checked) runCopilot(); }, 60000);
    state.saveTimer = setInterval(() => save(true), 30000);
    $('dot').classList.add('on');
    $('stop').hidden = false; $('startCall').hidden = true; $('startMic').hidden = true;
    status(tab ? 'mic + tab' : 'mic');
    if (!lines.length) $('lines').innerHTML = '';
  }

  function tick() {
    if (!state) return;
    const s = Math.floor((Date.now() - state.t0) / 1000);
    $('clock').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    const m = meter(state.micAn, $('micMeter'));
    const t = meter(state.tabAn, $('tabMeter'));
    if (state.tabAn && !state.warnedTab) {
      state.tabSilentMs = t < 0.002 && m > 0.01 ? state.tabSilentMs + 250 : (t >= 0.002 ? 0 : state.tabSilentMs);
      if (state.tabSilentMs > 20000) { state.warnedTab = true; banner("The call tab is silent while you talk. If the others can't be heard here, share again and tick 'Also share tab audio'."); }
    }
  }

  // Cut on silence: a chunk ends after 0.7 s of quiet, or at 15 s.
  function onFrame(f) {
    const s = state; if (!s) return;
    const ms = (f.length / s.ctx.sampleRate) * 1000;
    const v = rms(f);
    s.floor = v < s.floor ? v : s.floor * 0.999 + v * 0.001;
    const speaking = v > Math.max(0.006, s.floor * 3);
    const seg = s.seg;
    if (!seg.frames.length && !speaking) {
      s.preroll.push(f); if (s.preroll.length > 6) s.preroll.shift();
      return;
    }
    if (!seg.frames.length) { seg.frames.push(...s.preroll); s.preroll = []; seg.startAt = Date.now(); }
    seg.frames.push(f);
    if (speaking) { seg.speechMs += ms; seg.silenceMs = 0; } else seg.silenceMs += ms;
    const dur = seg.frames.length * ms;
    if ((seg.silenceMs >= 700 && dur >= 1200) || dur >= 15000) flush();
  }

  function flush() {
    const s = state; if (!s) return;
    const seg = s.seg;
    s.seg = { frames: [], speechMs: 0, silenceMs: 0, startAt: Date.now() };
    if (seg.speechMs < 300) return;
    const wav = toWav(seg.frames, s.ctx.sampleRate);
    upload(wav, ++s.seq, seg.startAt);
  }

  function toWav(frames, inRate) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const all = new Float32Array(total);
    let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
    const ratio = inRate / RATE, n = Math.floor(total / ratio);
    const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (p, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(p + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(total - 1, Math.floor((i + 1) * ratio));
      let sum = 0, c = 0; for (let k = a; k <= b; k++) { sum += all[k]; c++; }
      const x = Math.max(-1, Math.min(1, sum / c));
      dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function upload(wav, seq, at) {
    const line = { seq, at, text: '', pending: true };
    lines.push(line); lines.sort((a, b) => a.seq - b.seq); render();
    const prev = lines.filter((l) => l.text).map((l) => l.text).join(' ').slice(-300);
    const q = new URLSearchParams({ lang: store.get('lang'), prompt: prev });
    try {
      const r = await fetch('/api/transcribe?' + q, { method: 'POST', headers: headers({ 'Content-Type': 'audio/wav' }), body: wav });
      const j = await r.json();
      if (!r.ok) { banner(j.error || 'Transcription failed.'); if (r.status === 401) $('settings').showModal(); }
      line.text = (j.text || '').trim();
    } catch { banner('Lost the connection to the server; still listening.'); }
    line.pending = false;
    const i = lines.indexOf(line); if (!line.text && i >= 0) lines.splice(i, 1);
    render();
  }

  function render() {
    const box = $('lines');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = '';
    for (const l of lines) {
      const p = document.createElement('p');
      if (l.pending) p.className = 'pending';
      const t = document.createElement('time');
      t.textContent = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      p.append(t, document.createTextNode(l.pending ? '...' : l.text));
      box.append(p);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function transcriptText() {
    return lines.filter((l) => l.text).map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.text}`).join('\n');
  }

  function stop() {
    const s = state; if (!s) return;
    flush();
    state = null;
    clearInterval(s.timer); clearInterval(s.copilotTimer); clearInterval(s.saveTimer);
    s.mic.getTracks().forEach((t) => t.stop());
    if (s.tab) s.tab.getTracks().forEach((t) => t.stop());
    s.ctx.close();
    $('dot').classList.remove('on');
    $('stop').hidden = true; $('startCall').hidden = false; $('startMic').hidden = false;
    status('stopped');
    setTimeout(() => save(false), 3000);
  }

  // ---------- copilot ----------
  async function runCopilot(question = '') {
    const text = transcriptText();
    const s = state || {};
    if (!question) {
      if (!text || text.length === s.lastCopilotLen) return;
      if ((s.copilotCount || 0) >= 40) { $('auto').checked = false; return; }
      s.copilotCount = (s.copilotCount || 0) + 1; s.lastCopilotLen = text.length;
    }
    const out = $('copilot');
    out.classList.add('busy');
    try {
      const r = await fetch('/api/copilot', {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ transcript: text, notes: $('notes').value, question }),
      });
      const j = await r.json();
      out.textContent = r.ok ? j.text : ('Copilot: ' + (j.error || r.status));
      if (r.ok) copilotLog.push({ at: Date.now(), question, text: j.text });
    } catch { out.textContent = 'Copilot: no connection to the server.'; }
    out.classList.remove('busy');
  }
  const copilotLog = [];
  $('askForm').onsubmit = (e) => { e.preventDefault(); const q = $('ask').value.trim(); if (q) { $('ask').value = ''; runCopilot(q); } };

  // ---------- notes ----------
  function markdown() {
    const when = new Date().toLocaleString();
    let md = `# Call notes\n\n${when}\n\n## My notes\n\n${$('notes').value || '(none)'}\n\n## Transcript\n\n${transcriptText() || '(empty)'}\n`;
    if (copilotLog.length) md += `\n## Copilot\n\n` + copilotLog.map((c) => `- ${c.question ? 'Q: ' + c.question + ' / ' : ''}${c.text.replace(/\n/g, ' ')}`).join('\n') + '\n';
    return md;
  }
  const noteId = () => (state && state.id) || store.get('lastId') || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  async function save(quiet) {
    const id = noteId(); store.set('lastId', id);
    try { store.set('draft', markdown()); } catch { /* full */ }
    try {
      const r = await fetch('/api/notes', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id, markdown: markdown() }) });
      const j = await r.json();
      $('saved').textContent = j.saved ? `saved to ${j.file}` : (quiet ? '' : 'kept in this browser; use Download .md to keep a copy');
    } catch { if (!quiet) $('saved').textContent = 'server unreachable; use Download .md'; }
  }
  $('save').onclick = () => save(false);
  $('download').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown' }));
    a.download = `call-${noteId()}.md`; a.click();
  };

  $('startCall').onclick = () => start(true);
  $('startMic').onclick = () => start(false);
  $('stop').onclick = stop;
  if (!navigator.mediaDevices || !window.AudioWorkletNode) banner('This browser cannot capture audio here. Use Chrome on http://localhost or https.');
  loadConfig();
  window.kilaziLive = { start, stop, lines, runCopilot };
})();
