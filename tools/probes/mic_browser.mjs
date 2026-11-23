// A spoken question in headless Chromium: SPEECH_WAV is the microphone; tap, STT, answer.
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
const port = 9340;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-mic",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${process.env.SPEECH_WAV}`, `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`,
  "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "True" when the configured STT has what it needs: Whisper on the device
// its model (emkayWhisper.ready starts the download and answers at once,
// as ovos-stt-plugin-whisper-browser asks it); any other STT at once
const STT_READY = `import js
from ovos_config import Configuration
_c = Configuration()
_s = _c.get("stt", {})
if _s.get("module") != "ovos-stt-plugin-whisper-browser":
    _r = True
else:
    from ovos_stt_plugin_whisper_browser import model_for
    _m = (_s.get("ovos-stt-plugin-whisper-browser") or {}).get("model") or model_for(_c.get("lang", "en-US"), bool((_s.get("ovos-stt-plugin-whisper-browser") or {}).get("light")))
    _r = bool(await js.emkayWhisper.ready(_m))
str(_r)`;
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
const INTERESTING = /\[emkay\] (stt|tts)|Parsing utterance|match \(|record|Traceback|Error/i;
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

try {
  // spoken question: Chromium plays SPEECH_WAV as the microphone
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await sleep(3000);
  // Emkay's ears run on the device and are downloaded on the first start
  // (Whisper, ~77 MB from Hugging Face), and no server stands in by itself
  // (defaults v15): wait until the STT plugin itself would find its model
  // ready, so a slow download is not taken for a broken microphone
  const tw = Date.now();
  await until(`window.emkay.call("python_async", {code: ${JSON.stringify(STT_READY)}}).then((r) => r === "True", () => false)`,
    300, "the device's ears (the Whisper model)");
  log(`ears ready ${((Date.now() - tw) / 1000).toFixed(1)}s after the tap`);
  // what the caption shows, and what Emkay says back
  await js(`window.__captions = []; window.__said = [];
    new MutationObserver(() => { const t = document.getElementById("caption-text").textContent;
      if (window.__captions.at(-1) !== t) window.__captions.push(t); })
      .observe(document.getElementById("caption"), { subtree: true, childList: true, characterData: true });
    window.__sounds = 0; const origSound = window.emkay.speaker.playSound.bind(window.emkay.speaker);
    window.emkay.speaker.playSound = (d) => { window.__sounds++; return origSound(d); };
    const orig = window.emkay.speaker.enqueue.bind(window.emkay.speaker);
    window.emkay.speaker.enqueue = (data, meta) => { window.__said.push(meta.utterance); return orig(data, meta); };
    true`);
  const t = Date.now();
  await js(`window.emkay.mic.listen(); true`);   // a tap on the face
  await until(`!window.emkay.mic.busy`, 60, "the recording and STT");
  log(`heard in ${((Date.now() - t) / 1000).toFixed(1)}s; captions: ${await js(`JSON.stringify(window.__captions)`)}`);
  await until(`window.__said.length > 0`, 60, "an answer");
  log(`said: ${await js(`JSON.stringify(window.__said)`)} (${((Date.now() - t) / 1000).toFixed(1)}s after the tap)`);
  // the same question again: the first one pays for loading models, this
  // one shows the time an answer usually takes
  await sleep(8000);
  // Emkay keeps the microphone open, and Chromium's fake one loops
  // SPEECH_WAV from when it was opened: let it go, so the next tap opens it
  // again and hears the question from its start, not from a random point
  await js(`window.emkay.releaseMic(); true`);
  await js(`window.__captions = []; window.__said = []; true`);
  const t2 = Date.now();
  await js(`window.emkay.mic.listen(); true`);
  await until(`!window.emkay.mic.busy`, 60, "the second recording");
  log(`second: heard in ${((Date.now() - t2) / 1000).toFixed(1)}s; captions: ${await js(`JSON.stringify(window.__captions)`)}`);
  await until(`window.__said.length > 0`, 60, "the second answer");
  log(`second said: ${await js(`JSON.stringify(window.__said)`)} (${((Date.now() - t2) / 1000).toFixed(1)}s after the tap)`);
  // OVOS' sounds: the confirm-listening sound played before each recording,
  // and a skill's play_sound (the volume change's "blop") plays too
  const before = await js(`window.__sounds`);
  await py("from emkay_mobile import boot\nfrom ovos_bus_client.message import Message\nboot.bus().emit(Message('mycroft.volume.set', {'percent': 0.6}))\n'ok'");
  await sleep(2000);
  log(`sounds: ${before} while listening, ${await js(`window.__sounds`) - before} after a volume change`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-40)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
