// The privacy chip (privacy.js) in a real (headless) Chromium: at rest, while
// Emkay speaks (on this device, the defaults), with speech on a server
// (amber), and a tap → ⚙ → Settings with the same three lines.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/privacy_browser.mjs [url] [screenshot-prefix]
import { spawn } from "child_process";
import fs from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const prefix = process.argv[3] || "";
const port = 9348;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-privacy",
  "--window-size=430,932", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  `--lang=${process.env.PHONE_LANG || "en-US"}`, `--accept-lang=${process.env.PHONE_LANG || "en-US"}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 4; i++) { if (await js(expression)) return; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
async function shot(name) {
  if (!prefix) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${prefix}${name}.png`, Buffer.from(r.result.data, "base64"));
  log(`screenshot ${prefix}${name}.png`);
}
const chip = () => js(`(() => { const c = document.getElementById("privacy-chip");
  return c.hidden ? "hidden" : c.className + " | " + c.textContent.trim() + " | " + c.getAttribute("aria-label"); })()`);

let failed = false;
const check = (ok, what) => { log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };

try {
  await send("Page.enable");
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await sleep(3000);
  const rest = await chip();
  log(`at rest: ${rest}`);
  check(/privacy-chip device(?! open)/.test(rest), "at rest: on this device, closed");
  await shot("1-rest");

  // speaking: the chip opens while the sentence plays
  await js(`window.emkay.call("say", {text: "what time is it"}); true`);
  await until(`document.getElementById("privacy-chip").classList.contains("open")`, 90, "the chip to open while speaking");
  const speaking = await chip();
  log(`speaking: ${speaking}`);
  // on this device – or, the first time, the fallback server while the
  // device's voice still downloads: then the chip must say so
  check((/device open/.test(speaking) && /On this device/.test(speaking))
    || (/external open/.test(speaking) && /Sending to/.test(speaking)), "speaking: open, and says where");
  await shot("2-speaking");
  await until(`!document.getElementById("privacy-chip").classList.contains("open")`, 60, "the chip to close again");
  check(true, "closes after speaking");

  // where a host is, by its name
  const parts = await js(`import("./privacy.js").then((p) => JSON.stringify([
    p.speechPart({ module: "ovos-stt-plugin-whisper-browser" }),
    p.speechPart({ module: "ovos-stt-plugin-browser" }),
    p.speechPart({ module: "ovos-stt-plugin-server", hosts: [] }),
    p.speechPart({ module: "ovos-stt-plugin-server", hosts: ["http://192.168.1.20:8080/stt"] }),
    p.speechPart({ module: "ovos-tts-plugin-server", hosts: ["https://tts.openvoiceos.pt"] }),
    p.speechPart({ module: "ovos-tts-plugin-server", hosts: ["http://emkay-home.local"] })]))`);
  log(`parts: ${parts}`);
  check(parts === JSON.stringify([{ what: "device" }, { what: "browser" }, { what: "public" },
    { what: "own", host: "192.168.1.20" }, { what: "server", host: "tts.openvoiceos.pt" },
    { what: "own", host: "emkay-home.local" }]), "places by host");

  // speech on a server: amber, and it says where
  await js(`window.emkay.privacy.route({ stt: { module: "ovos-stt-plugin-server", hosts: ["https://stt.openvoiceos.org"] },
    tts: { module: "ovos-tts-plugin-piper-browser", hosts: [] } }); window.emkay.privacy.active("hear", true); true`);
  const ext = await chip();
  log(`listening, server STT: ${ext}`);
  check(/external open/.test(ext) && /stt\.openvoiceos\.org/.test(ext), "server STT: amber, names the host");
  await shot("3-external");
  await js(`window.emkay.privacy.active("hear", false); true`);
  await sleep(3000);
  const extRest = await chip();
  log(`at rest, server STT: ${extRest}`);
  check(/privacy-chip external(?! open)/.test(extRest), "at rest it still shows the furthest place (amber icon)");

  // a fallback while a model downloads, then the model is ready
  await js(`window.emkay.privacy.route({ stt: { module: "ovos-stt-plugin-whisper-browser", hosts: [] },
    stt_fallback: { module: "ovos-stt-plugin-server", hosts: [] },
    tts: { module: "ovos-tts-plugin-piper-browser", hosts: [] } }); true`);
  check(/privacy-chip device/.test(await chip()), "back on the device");
  await js(`window.emkay.privacy.interim({ what: "stt", using: "fallback", module: "ovos-stt-plugin-server" }); true`);
  const fb = await chip();
  log(`fallback: ${fb}`);
  check(/external/.test(fb), "fallback to the public servers shows");
  await js(`window.emkay.privacy.ready("stt"); true`);
  check(/privacy-chip device/.test(await chip()), "model ready: on the device again");

  // a tap: ⚙ → Settings, with the three lines at the top
  await js(`document.getElementById("privacy-chip").click(); true`);
  await until(`!document.getElementById("menu").hidden && !!document.getElementById("privacy").offsetParent`, 5, "the menu at its three lines");
  const rows = await js(`document.getElementById("privacy").innerText.replace(/\\n+/g, " | ")`);
  log(`settings: ${rows}`);
  check(/Hears/.test(rows) && /Speaks/.test(rows) && /Thinks/.test(rows), "Settings shows hears/speaks/thinks");
  await sleep(400);
  await shot("4-settings");
} catch (e) {
  log(`FAILED: ${e.message}`);
  failed = true;
} finally {
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
