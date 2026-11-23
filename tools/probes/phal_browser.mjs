// The browser PHAL plugin in headless Chromium: connectivity, camera (a fake device), sensors, the
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
const port = 9339;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-phal",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
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
const INTERESTING = /phal|camera|Picture|Network state|reload|Reboot|restart|Traceback|Error/i;
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
  // panel's power and system cards, and "restart the services" from the panel.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await sleep(3000);
  const ask = (topic, data = {}) => py(`import json
from emkay_mobile import boot
from ovos_bus_client.message import Message
got = []
bus = boot.bus()
bus.on("${topic}.response", lambda m: got.append(m.data))
bus.emit(Message("${topic}", ${JSON.stringify(data)}))
json.dumps(got)`);
  log(`internet_check: ${await ask("ovos.PHAL.internet_check")}`);
  // camera: the page answers asynchronously, so collect the responses first
  await py(`from emkay_mobile import boot
from ovos_bus_client.message import Message
import builtins
builtins.PICS = []
boot.bus().on("ovos.phal.camera.get.response", lambda m: builtins.PICS.append({k: (len(v) if isinstance(v, str) and len(v) > 80 else v) for k, v in m.data.items()}))
boot.bus().emit(Message("ovos.phal.camera.get"))
boot.bus().emit(Message("ovos.phal.camera.get", {"path": "~/pictures/test.jpg"}))
"sent"`);
  await sleep(6000);
  log(`camera.get: ${await py(`import builtins, json, os
p = os.path.expanduser("~/pictures/test.jpg")
json.dumps(builtins.PICS) + " file bytes " + str(os.path.getsize(p) if os.path.exists(p) else 0)`)}`);
  // the panel: sensors page data, capabilities
  await js(`navigator.serviceWorker.ready.then(() => true)`);
  await js(`document.getElementById("menu-panel").click(); true`);
  const w = `document.getElementById("panel-frame").contentWindow`;
  const doc = `document.getElementById("panel-frame").contentDocument`;
  await until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "panel page");
  const api = (method, path, body) => js(`${w}.fetch("${path}", {method: "${method}", headers: {"content-type": "application/json"}${body ? `, body: JSON.stringify(${JSON.stringify(body)})` : ""}}).then(async r => r.status + " " + (await r.text()))`);
  const caps = JSON.parse((await api("GET", "/api/device/capabilities")).replace(/^\d+ /, ""));
  log(`capabilities: ${Object.entries(caps.capabilities).map(([k, v]) => `${k}=${v.installed ? v.provider : "-"}`).join(" ")}`);
  log(`set token: ${await api("POST", "/api/auth/token", { new: "emkay-test-token" })}`);
  await js(`window.__beforeReload = true; true`);
  log(`restart services: ${await api("POST", "/api/system/restart_services")}`);
  await sleep(6000);
  log(`page reloaded: ${await js(`window.__beforeReload !== true`)} | boot text: ${await js(`document.getElementById("boot-text")?.innerText`)}`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-25)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
