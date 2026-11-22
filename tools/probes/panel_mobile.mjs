// The control panel's menu on a phone (touch), in headless Chromium (issue #15).
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
const port = 9344;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-pm",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--lang=en-US", "--accept-lang=en-US",
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
const INTERESTING = /utterance|speak|match|lang|Traceback|Error/i;
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
  // a phone: touch screen, 390 x 844; taps are touch events (issue #15)
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  const tapAt = async (x, y) => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(80);
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(600);
  };
  const center = (expr) => js(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await tapAt(...await center(`document.getElementById("start")`));
  await sleep(2000);
  await tapAt(...await center(`document.getElementById("menu-button")`));
  await tapAt(...await center(`document.getElementById("menu-panel")`));
  const doc = `document.getElementById("panel-frame").contentDocument`;
  await until(`${doc}?.readyState === "complete" && ${doc}.getElementById("menu-toggle")`, 120, "panel page with its menu button");
  const frameAt = `document.getElementById("panel-frame").getBoundingClientRect()`;
  const inFrame = async (sel) => {
    const [fx, fy] = await js(`(() => { const r = ${frameAt}; return [r.x, r.y]; })()`);
    const [x, y] = await center(`${doc}.querySelector(${JSON.stringify(sel)})`);
    return [fx + x, fy + y];
  };
  log(`panel url: ${await js(`${doc}.location.pathname`)}`);
  await tapAt(...await inFrame("#menu-toggle"));
  log(`menu open: ${await js(`${doc}.querySelector("nav").classList.contains("open")`)}`);
  log(`links: ${await js(`[...${doc}.querySelectorAll("nav a")].map(a => a.getAttribute("href")).join(" ")`)}`);
  // Settings may sit in folded groups (Advanced, Maintenance): open each by touch, outermost first
  const folds = await js(`(() => { const out = []; let g = ${doc}.querySelector('nav a[href$="/config"]')?.closest(".nav-group[data-group]");
    while (g) { out.unshift(g.getAttribute("data-group")); g = g.parentElement.closest(".nav-group[data-group]"); } return out; })()`);
  for (const name of folds || []) {
    const fold = `.nav-group[data-group="${name}"] > .nav-fold`;
    if (await js(`${doc}.querySelector('${fold}').getAttribute("aria-expanded")`) !== "true") {
      await tapAt(...await inFrame(fold));
      await sleep(500);
    }
  }
  log(`folds open: ${JSON.stringify(folds)}`);
  await js(`${doc}.querySelector('nav a[href$="/config"]').scrollIntoView({block: "center"}); true`);
  await sleep(300);
  await tapAt(...await inFrame('nav a[href$="/config"]'));
  await sleep(3000);
  log(`after tapping Settings: ${await js(`${doc}.location.pathname`)} | menu open: ${await js(`${doc}.querySelector("nav")?.classList.contains("open")`)}`);
  // and with a mouse-style click, for comparison
  await js(`${doc}.querySelector('nav a[href$="/skills"]')?.click(); true`);
  await sleep(3000);
  log(`after click() on Skills: ${await js(`${doc}.location.pathname`)}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  ws.close();
  chrome.kill();
}
