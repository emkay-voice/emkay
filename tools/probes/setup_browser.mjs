// Walk the control panel's first-start wizard (/setup) inside Emkay
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
const port = 9336;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-setup",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
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
const INTERESTING = /\(pip\)|rescan|ATTEMPTING TO LOAD|loaded successfully|padaos compile|train|skill\.handler\.start|"speak"|utterance|Traceback|Error|ovos\.pip/i;
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
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  // a fresh profile is a first start: Emkay offers the wizard
  log(`first start: ${await js(`!document.getElementById("first").hidden && document.getElementById("first").innerText + " | " + document.getElementById("start").innerText`)}`);
  await js(`navigator.serviceWorker.ready.then(() => true)`);
  await js(`document.getElementById("first-setup").click(); true`);
  // Set up asks where Emkay should think first: here, on this device
  await until(`!document.getElementById("brain-choice")?.hidden`, 20, "the brain choice");
  await js(`document.querySelector("#brain-choice .menu-item:nth-of-type(1)").click(); true`);
  const doc = `document.getElementById("panel-frame").contentDocument`;
  await until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "panel page");
  log("panel open");
  const w = `document.getElementById("panel-frame").contentWindow`;
  const api = async (method, path, body) => {
    const r = await js(`${w}.fetch("${path}", {method: "${method}",
      headers: {"content-type": "application/json"}${body ? `, body: JSON.stringify(${JSON.stringify(body)})` : ""}})
      .then(async (r) => ({status: r.status, body: await r.text()}))`);
    log(`  ${method} ${path} -> ${r?.status}`);
    try { return JSON.parse(r.body); } catch { return { raw: String(r?.body ?? r).slice(0, 300) }; }
  };
  for (const p of ["/api/status", "/api/config/quick", "/api/plugins/recommended", "/api/events"])
    log(`${p}: ${JSON.stringify(await api("GET", p)).slice(0, 900)}`);
  await until(`${doc}?.querySelector("#recommended") && !/Loading/.test(${doc}.querySelector("#recommended").textContent)`, 60, "setup page");
  await sleep(3000);
  // Emkay's guide (webui.setup in boot.py) leaves the wake word test out
  log(`wake step shown: ${await js(`${doc}.querySelector("#wake-test").closest(".card").offsetParent !== null`)}`);
  log(`setup url: ${await js(`${w}.location.href`)}`);
  log("setup text:\n" + await js(`${doc}.querySelector("main").innerText`));
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  (await import("fs")).writeFileSync("setup_shot.png", Buffer.from(shot.result.data, "base64"));
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-30)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
