// The wake word in headless Chromium: SPEECH_WAV ("hey mycroft, ...") is the microphone; no tap.
// real (headless) Chromium: panel API -> ovos-core's installer -> pip.py.
// Also collects the worker's own console (OVOS' log) with timestamps.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/install_browser.mjs [url] [package] [utterance]
//
// Uses a throw-away profile in /tmp and talks to Chromium over CDP.
import { spawn } from "child_process";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const pkg = process.argv[3] || "ovos-skill-randomness";
const ask = process.argv[4] || "flip a coin";
const port = 9342;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-ww",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${process.env.SPEECH_WAV}`, `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`,
  "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (m) => console.log(`${stamp()} ${m}`);

let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
      .find((t) => t.type === "page" && t.url.startsWith("about:blank"));
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const workerLines = [];
const INTERESTING = /\[stack\]|asked a question|get_response|wakeword|\[emkay\] (stt|tts)|Parsing utterance|match \(|Traceback|Error/i;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.sessionId) {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (INTERESTING.test(text)) workerLines.push(`${stamp()} ${text.slice(0, 220)}`);
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await js(expression);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const py = (code) => js(`window.emkay.call("python", {code: ${JSON.stringify(code)}})`);
const pyAsync = (code) => js(`window.emkay.call("python_async", {code: ${JSON.stringify(code)}})`);

try {
  // no tap on the face: the wake word starts the listening
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  // STACKS=1: where Python is, every 5 s while it runs (to see what a busy worker does)
  if (process.env.STACKS) await py(`import sys, time, traceback
_t = [time.time()]
def _prof(frame, event, arg):
    if time.time() - _t[0] > 5:
        _t[0] = time.time()
        print("[stack] " + " <- ".join(f"{fs.name}@{fs.filename.split('/')[-1]}:{fs.lineno}" for fs in reversed(traceback.extract_stack(frame)[-14:])))
sys.setprofile(_prof)
"ok"`);
  await js(`window.__captions = []; window.__said = [];
    new MutationObserver(() => { const t = document.getElementById("caption-text").textContent;
      if (window.__captions.at(-1) !== t) window.__captions.push(t); })
      .observe(document.getElementById("caption"), { subtree: true, childList: true, characterData: true });
    const orig = window.emkay.speaker.enqueue.bind(window.emkay.speaker);
    window.emkay.speaker.enqueue = (data, meta) => { window.__said.push(meta.utterance); return orig(data, meta); };
    document.getElementById("start").click(); true`);
  const t = Date.now();
  await until(`document.getElementById("mic").classList.contains("wake")`, 60, "the wake word engine");
  // WAKE_WORD=hey_mycroft: the recording says "hey mycroft", but Emkay's own
  // default is "hey_emkay" (boot.py, defaults v13). Switch the way the
  // control panel does (configuration.patch on the bus); the page then
  // starts the engine for the new wake word (worker_main._settings_changed)
  const ww = process.env.WAKE_WORD;
  if (ww) {
    log(`default wake word engine ready in ${((Date.now() - t) / 1000).toFixed(1)}s: ${await js("window.emkay.wake.engineName")}`);
    await py(`from ovos_bus_client.message import Message
from emkay_mobile import boot
boot.bus().emit(Message("configuration.patch", {"config": {"listener": {"wake_word": ${JSON.stringify(ww)}}}}))
"ok"`);
    await until(`window.emkay.wake.engineName !== "oww" && document.getElementById("mic").classList.contains("wake")`, 60, `the ${ww} engine`);
  }
  log(`wake word engine ready in ${((Date.now() - t) / 1000).toFixed(1)}s: ${await js("window.emkay.wake.engineName")}`);
  // ANSWERS=2: the fake microphone loops the file, so a second "hey mycroft"
  // follows; Emkay must be back waiting for it after the first answer
  const answers = Number(process.env.ANSWERS || 1);
  for (let n = 1; n <= answers; n++) {
    await until(`window.__said.length >= ${n}`, Number(process.env.WAIT_S || 120), `answer ${n} without a tap`);
    log(`answer ${n}; mic: ${await js(`document.getElementById("mic").className + ", wake " + window.emkay.wake.state`)}`);
  }
  log(`captions: ${await js(`JSON.stringify(window.__captions)`)}`);
  log(`said: ${await js(`JSON.stringify(window.__said)`)} (${((Date.now() - t) / 1000).toFixed(1)}s after start)`);
} catch (e) {
  log(`FAILED: ${e.message}`);
  log(`captions so far: ${await js(`JSON.stringify(window.__captions)`)}`);
  log(`wake word state: ${await js(`window.emkay.wake.state + ", chunks " + window.emkay.wake.chunks + ", best score " + window.emkay.wake.best`)}`);
} finally {
  // the audio transformers (listener.py): what the page sent them, and what they made of it
  log(`room: ${await js(`JSON.stringify({sent: window.emkay.room?.sent, dropped: window.emkay.room?.dropped})`).catch((e) => e.message)}`);
  log(`room listeners: ${await pyAsync(`import json
from emkay_mobile import listener
def state(p):
    if hasattr(p, "_measured"):      # auto volume: seconds of room measured
        return round(p._measured, 1)
    out = {"ready": getattr(p, "_ready", None), "off": getattr(p, "_off_reason", None)}
    if out["ready"]:                 # overheard manners: one window through its model, timed
        import time, numpy as np
        noise = (np.random.default_rng(1).standard_normal(p.spotter.window_size) * 0.05).astype(np.float32)
        try:
            p.spotter.score_window(noise)          # the first opens the session
            t = time.time()
            for _ in range(5):
                scores = p.spotter.score_window(noise)
            out.update(window_ms=round((time.time() - t) * 200), pronunciations=len(scores))
        except Exception as e:
            out["window_error"] = repr(e)[:200]
    return out
json.dumps({p.name: state(p) for p in listener.plugins()})`).catch((e) => e.message)}`);
  log("worker log:");
  for (const l of workerLines.slice(-Number(process.env.LINES || 25))) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
