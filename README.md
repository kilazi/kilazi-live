# kilazi-live
Live transcript of calls you take in Chrome (Meet, Zoom web, Teams web) or on your mic, with a copilot that reads along and tells you what to say next.

## Use
```
npx github:kilazi/kilazi-live
```
It opens http://127.0.0.1:4321. Paste your OpenAI key in Settings (or put `OPENAI_API_KEY=` in a `.env` where you run it), press **Start: mic + call tab**, pick the call's tab and tick "Also share tab audio". Notes and the transcript save as markdown in `./kilazi-live-notes`.

Copilot: OpenAI by default; `--provider claude` or `--provider codex` uses the Claude Code or Codex CLI already logged in on that machine (text only, no tools, no API keys passed); `COPILOT_HTTP_URL` + `COPILOT_HTTP_TOKEN` plugs in any model behind a token.

Hand it to someone without giving them a key: run it on a server with `ACCESS_CODES=some-long-code=openai` (see `example.env`); they open the page, type the code, and use your server's key, capped per code per day. To host it with Docker behind nginx, see `deploy/` (compose file + proxy block).

Needs Node 18+ and Chrome. Desktop-app calls (Zoom or Teams app) are heard through your mic only.

More: https://kilazi.com/wiki/kilazi-live/ · by Max Kilazi (https://kilazi.com)
