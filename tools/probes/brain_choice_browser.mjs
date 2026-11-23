// "Where should Emkay think?" (#27) in headless Chromium, from a first
// start with nothing chosen: the boot screen offers Start, Set up and "an
// assistant in the house"; that opens the choice; HiveMind asks for the
// connection; a wrong password offers "use Emkay on this device instead",
// which goes back to the local OVOS; the right one starts Emkay as a
// satellite; the ⚙ menu has the entry on top and says where Emkay thinks.
// Screenshots in OUT (default /tmp/brain-choice-*.png).
//
//   HM_KEY=K HM_PASSWORD=P CHROME=... PHONE_LANG=da-DK node tools/probes/brain_choice_browser.mjs [url]
import { spawn } from "child_process";
import { writeFileSync } from "fs";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const out = process.env.OUT || "/tmp/brain-choice";
const lang = process.env.PHONE_LANG || "en-US";
const port = 9397;
const chrome = spawn(process.env.CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  "--user-data-dir=/tmp/emkay-chrome-brain-choice", "--window-size=390,844", "--no-first-run",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader",
  `--lang=${lang}`, `--accept-lang=${lang}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) return pending.get(m.id)?.(m.result);
  if (m.method === "Runtime.exceptionThrown") log(`EXCEPTION ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
};
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
async function until(expr, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) { if (await js(expr)) return; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}
async function shot(name) {
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}-${name}.png`, Buffer.from(png.data, "base64"));
  log(`screenshot ${out}-${name}.png`);
}
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e || e.hidden) return false; for (let p = e; p; p = p.parentElement) if (getComputedStyle(p).display === "none") return false;
  return true; })()`;
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
const fill = (name, value) => js(`(() => { const i = document.querySelector('#hivemind-setup [name="${name}"]');
  if (i.type === "checkbox") i.checked = ${JSON.stringify(value)}; else i.value = ${JSON.stringify(value)}; return true; })()`);
const texts = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`);

try {
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await until(visible("#first-setup"), 400, "the first start's choices (local OVOS booted)");
  log(`first start: ${JSON.stringify(await texts("#boot button:not([hidden])"))}`);
  await shot("1-first-start");

  await click("#first-setup");   // Set up asks where Emkay should think first
  await until(visible("#brain-choice"), 10, "the choice");
  log(`choice: ${JSON.stringify(await texts("#brain-choice .menu-item"))}`);
  log(`disabled: ${JSON.stringify(await js(`[...document.querySelectorAll("#brain-choice .menu-item")].map((b) => b.disabled)`))}`);
  await shot("2-choice");

  await click("#brain-choice .menu-item:nth-of-type(2)");   // the house
  await until(visible("#hivemind-setup"), 10, "the HiveMind form");
  await shot("3-hivemind-form");
  await click('#hivemind-setup [data-act="back"]');
  await until(visible("#brain-choice"), 10, "back at the choice");
  log("back: the choice again");

  // a wrong password: the form comes back with the error and a way out
  await click("#brain-choice .menu-item:nth-of-type(2)");
  await until(visible("#hivemind-setup"), 10, "the HiveMind form");
  await fill("host", process.env.HM_HOST || "127.0.0.1");
  await fill("port", process.env.HM_PORT || "5678");
  await fill("ssl", false);
  await fill("key", process.env.HM_KEY);
  await fill("password", "not-the-password");
  await click('#hivemind-setup button[type="submit"]');
  await until(`document.readyState === "complete" && ${visible('#hivemind-setup .error')}`, 60, "the error after a reload");
  log(`brain now: ${await js(`localStorage.getItem("emkay-brain")`)}; error: ${await js(`document.querySelector("#hivemind-setup .error").textContent`)}`);
  log(`buttons: ${JSON.stringify(await texts("#hivemind-setup button"))}`);
  await shot("4-wrong-password");

  // the way out: back to Emkay on this device
  await click('#hivemind-setup [data-act="local"]');
  await sleep(2000);
  await until(`!!document.getElementById("boot-text")`, 30, "a new page");
  log(`after "use on this device": brain ${await js(`localStorage.getItem("emkay-brain")`)}, address ${await js("location.href")}`);

  // and the right password: Emkay as a satellite, the menu says so
  await js(`localStorage.setItem("emkay-hivemind", JSON.stringify({ host: ${JSON.stringify(process.env.HM_HOST || "127.0.0.1")},
    port: ${+(process.env.HM_PORT || 5678)}, ssl: false, key: ${JSON.stringify(process.env.HM_KEY)},
    password: ${JSON.stringify(process.env.HM_PASSWORD)} })); localStorage.setItem("emkay-brain", "hivemind"); location.reload(); true`);
  await sleep(1500);
  await until(`!!document.getElementById("visage2") && !document.getElementById("start").hidden`, 60, "the satellite to start");
  log(`satellite boot: ${await js(`document.getElementById("boot-text").textContent`)}; set up shown: ${await js(visible("#first-setup"))}`);
  await js(`document.getElementById("start").click(); true`);
  await sleep(1500);
  await js(`document.getElementById("menu").hidden = false; true`);
  await sleep(500);
  log(`menu: ${JSON.stringify(await texts("#menu .menu-item:not([hidden])"))}`);
  await shot("5-menu-satellite");
  log("ok");
} catch (e) {
  log(`FAILED: ${e.message}`);
  await shot("failed");
}
chrome.kill();
process.exit(0);
