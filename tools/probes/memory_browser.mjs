// Where a running Emkay's memory goes, in headless Chromium:
//   * the browser's memory (PSS, by kind of process) through the boot,
//   * each JavaScript context's heap (the page and every worker),
//   * inside Python (memory_report.py): Pyodide's WebAssembly heap, the
//     files in its file system, and what each skill and package keeps.
//
//   CHROME=~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome PHONE_LANG=da-DK \
//     node tools/probes/memory_browser.mjs [url] [seconds to wait after the start]
//
// The browser profile is kept in /tmp/emkay-chrome-memory, so a second run
// finds the models in the cache (as a phone does on its second start).
import { spawn, execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const url = process.argv[2] || "https://app.emkay.ai/";
const settle = Number(process.argv[3] || 120);
const lang = process.env.PHONE_LANG || "da-DK";
const port = 9345;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-memory",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream", "--no-first-run", `--lang=${lang}`, `--accept-lang=${lang}`, "about:blank"],
  { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

/** Proportional memory (PSS: shared pages split between the processes) of
 * this Chromium's processes, MB, in total and by kind (browser, renderer, gpu, ...). */
function rss() {
  const byKind = {};
  let total = 0;
  try {
    for (const pid of execSync("pgrep -f emkay-chrome-memory").toString().trim().split("\n")) {
      let kb = 0, kind = "browser";
      try {
        kb = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))[1]);
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        kind = /--type=([\w-]+)/.exec(cmd)?.[1] || "browser";
        const sub = /--utility-sub-type=([\w.]+)/.exec(cmd)?.[1];
        if (sub) kind += ":" + sub.split(".").pop();
      } catch { continue; }
      byKind[kind] = (byKind[kind] || 0) + kb;
      total += kb;
    }
  } catch {}
  rss.byKind = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v / 1024)]));
  return Math.round(total / 1024);
}
let peak = 0;
const timeline = [];
const sampler = setInterval(() => {
  const r = rss();
  peak = Math.max(peak, r);
  timeline.push([Math.round((Date.now() - t0) / 1000), r]);
}, 2000);

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
const workers = new Map();          // sessionId -> url
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    workers.set(m.params.sessionId, m.params.targetInfo.url);
    ws.send(JSON.stringify({ id: ++id, method: "Target.setAutoAttach", sessionId: m.params.sessionId,
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
    ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
  }
  if (m.method === "Target.detachedFromTarget") workers.delete(m.params.sessionId);
};
const send = (method, params = {}, sessionId) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) { if (await js(expression)) return; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}
async function heaps() {
  const out = [["page", (await send("Runtime.getHeapUsage")).result]];
  for (const [sid, u] of workers) out.push([u.split("/").pop(), (await send("Runtime.getHeapUsage", {}, sid)).result]);
  return out.map(([n, h]) => `${n} ${Math.round((h?.usedSize ?? 0) / 2 ** 20)}/${Math.round((h?.totalSize ?? 0) / 2 ** 20)} MB`);
}

const report = { url, lang };
try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 600, "OVOS boot");
  report.booted = { s: Math.round((Date.now() - t0) / 1000), rss: rss() };
  report.booted.byKind = rss.byKind;
  log(`OVOS up, browser ${report.booted.rss} MB ${JSON.stringify(rss.byKind)}`);
  await js(`document.getElementById("start").click(); true`);
  for (let s = 0; s < settle; s += 15) {
    await sleep(15000);
    log(`browser ${rss()} MB (peak ${peak} MB) ${JSON.stringify(rss.byKind)}`);
  }
  report.settled = { rss: rss(), peak, byKind: rss.byKind };
  report.heaps = await heaps();
  log(`JS heaps: ${report.heaps.join(", ")}`);
  // EMKAY_* variables reach the report as os.environ (EMKAY_MEMORY_SKILL, EMKAY_RELEASE, ...)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("EMKAY_")));
  const code = `import os; os.environ.update(${JSON.stringify(env)})\n` +
    readFileSync(new URL(process.env.REPORT || "./memory_report.py", import.meta.url), "utf8");
  const py = await js(`window.emkay.call("${process.env.PY_CALL || "python"}", {code: ${JSON.stringify(code)}})`);
  try { report.python = JSON.parse(py); } catch { report.python = py; }
  report.after_report = rss();
} catch (e) {
  log(`FAILED: ${e.message}`);
  report.error = e.message;
} finally {
  clearInterval(sampler);
  report.timeline = timeline;
  writeFileSync(process.env.OUT || "/tmp/emkay-memory.json", JSON.stringify(report, null, 1));
  log(`report: ${process.env.OUT || "/tmp/emkay-memory.json"}`);
  ws.close();
  chrome.kill();
}
