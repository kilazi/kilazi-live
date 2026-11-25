"""Real end-to-end check: Chrome with a fake mic playing a wav, the real page,
the real transcription API. Needs OPENAI_API_KEY in the environment and
Python Playwright with Chromium.

  OPENAI_API_KEY=... python test/e2e_browser.py [--wav speech.wav] [--shot out.png]
"""
import argparse, json, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
LINES = [
    "Hi, thanks for joining. Today we need to agree on the launch date for the new app.",
    "I think the fourteenth of March works, if the design is done by the end of February.",
    "Great. Let's also check the budget: we have twelve thousand dollars for ads.",
]


def make_wav(path):
    key = os.environ["OPENAI_API_KEY"]
    parts = []
    for i, line in enumerate(LINES):
        req = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=json.dumps({"model": "tts-1", "voice": "alloy" if i % 2 == 0 else "onyx", "input": line, "response_format": "wav"}).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        p = path.with_name(f"part{i}.wav")
        p.write_bytes(urllib.request.urlopen(req, timeout=120).read())
        parts.append(p)
    # each line, then 1.5 s of silence; Chrome's fake mic wants 48 kHz mono 16-bit
    inputs, filt = [], ""
    for i, p in enumerate(parts):
        inputs += ["-i", str(p)]
        filt += f"[{i}:a]aresample=48000,apad=pad_dur=1.5[a{i}];"
    filt += "".join(f"[a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", filt, "-map", "[out]",
                    "-ac", "1", "-ar", "48000", "-sample_fmt", "s16", str(path)], check=True)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default=str(ROOT / "test" / "out" / "speech.wav"))
    ap.add_argument("--shot", default=str(ROOT / "test" / "out" / "kilazi-live.png"))
    a = ap.parse_args()
    wav, shot = Path(a.wav), Path(a.shot)
    wav.parent.mkdir(parents=True, exist_ok=True); shot.parent.mkdir(parents=True, exist_ok=True)
    if not wav.exists():
        make_wav(wav)
    port = free_port()
    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1", "NO_OPEN": "1", "NOTES_DIR": str(ROOT / "test" / "out" / "notes")}
    srv = subprocess.Popen(["node", str(ROOT / "bin" / "kilazi-live.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        time.sleep(1.5)
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=[
                "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-audio-capture={wav}", "--autoplay-policy=no-user-gesture-required",
            ])
            ctx = b.new_context(viewport={"width": 1440, "height": 900}, permissions=["microphone"])
            page = ctx.new_page()
            page.set_default_timeout(240000)
            page.goto(f"http://127.0.0.1:{port}/")
            page.evaluate("localStorage.setItem('kl.consent','1')")
            page.reload()
            page.click("#startMic")
            page.wait_for_function("window.kilaziLive.lines.filter(l => l.text && /launch|budget|march|design/i.test(l.text)).length >= 2", timeout=240000)
            page.evaluate("window.kilaziLive.runCopilot('What should I ask next?')")
            page.wait_for_function("document.getElementById('copilot').textContent.length > 20 && !document.getElementById('copilot').classList.contains('busy')", timeout=180000)
            page.fill("#notes", "Launch date and ad budget agreed in principle.")
            page.click("#save")
            page.wait_for_function("document.getElementById('saved').textContent.includes('saved')", timeout=60000)
            page.screenshot(path=str(shot))
            got = page.evaluate("window.kilaziLive.lines.map(l => l.text)")
            cop = page.inner_text("#copilot")
            page.click("#stop")
            b.close()
        print("TRANSCRIPT:", json.dumps(got, ensure_ascii=False))
        print("COPILOT:", cop.replace("\n", " | ")[:400])
        print("SHOT:", shot)
        print("E2E OK")
    finally:
        srv.terminate(); srv.wait(10)
        print("SERVER LOG:", srv.stdout.read().strip().replace("\n", " | "))


if __name__ == "__main__":
    sys.exit(main())
