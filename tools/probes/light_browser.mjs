// A start that closes the page while the ears open (a small device: Røst
// closed the tab on a 4 GB tablet) and the next start, in headless Chromium:
// the first start ends without the page taking its mark away, as a crash,
// and the second start must turn ovos-stt-plugin-whisper-browser's "light"
// on, say so (light.after_crash) and open the light model.
//
//   CHROME=... PHONE_LANG=da-DK node tools/probes/light_browser.mjs [url]
import { spawn } from "child_process";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const lang = process.env.PHONE_LANG || "da-DK";
const port = 9346;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/emkay-chrome-light-${Date.now()}`,
  "--window-size=390,844", "--no-first-run", `--lang=${lang}`, `--accept-lang=${lang}`, "about:blank"], { stdio: "ignore" });
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
const consoleLines = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    const sid = m.params.sessionId;
    for (const method of ["Runtime.enable", "Runtime.runIfWaitingForDebugger"]) ws.send(JSON.stringify({ id: ++id, method, sessionId: sid }));
    ws.send(JSON.stringify({ id: ++id, method: "Target.setAutoAttach", sessionId: sid,
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }));
  }
  if (m.method === "Runtime.consoleAPICalled") {
    consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
}
async function until(expression, seconds, what) {
  for (let i = 0; i < seconds * 2; i++) { if (await js(expression)) return; await sleep(500); }
  throw new Error(`timed out waiting for ${what}`);
}
const lightOf = `window.emkay.call("python", {code: "from ovos_config import Configuration as C; ` +
  `str((C().get('stt', {}).get('ovos-stt-plugin-whisper-browser') or {}).get('light'))"})`;

let failed = false;
const check = (ok, what) => { log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };
try {
  await send("Runtime.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // 1. a start that the browser ends: the page is crashed while OVOS boots
  await send("Page.navigate", { url });
  await until(`!!localStorage.getItem("emkay.opening")`, 60, "the start's mark");
  await sleep(4000);
  // as a crash: the page gets no chance to take its mark away (a real
  // crash runs no JavaScript; CDP's Page.crash would cut this connection)
  log("ending the page while it starts, as a crash would");
  await js(`localStorage.removeItem = () => {}; true`);
  // 2. the next start
  consoleLines.length = 0;
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  check(await js(lightOf) === "True", `the light STT model is on after the crash (light=${await js(lightOf)})`);
  const caption = await js(`document.getElementById("caption")?.textContent || ""`);
  check(/hukommelse|memory/i.test(caption), `the page says so: "${caption.slice(0, 90)}"`);
  await js(`document.getElementById("start").click(); true`);
  // the light model opens, not Røst
  for (let i = 0; i < 240 && !consoleLines.some((l) => /whisper .* ready/.test(l)); i++) await sleep(500);
  const ready = consoleLines.find((l) => /whisper .* ready/.test(l)) || "";
  check(/alvenir/.test(ready), `the ears: ${ready || "(not ready)"}`);
  if (!ready) {
    for (const l of consoleLines.filter((l) => /whisper|alvenir|roest|stt|speech|model/i.test(l)).slice(-25)) log(`  ${l.slice(0, 200)}`);
  }
  check(!(await js(`!!localStorage.getItem("emkay.opening")`)), "the mark is gone once the ears are ready");
  // 3. a start after a normal one: nothing to say
  await send("Page.navigate", { url });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  const again = await js(`document.getElementById("caption")?.textContent || ""`);
  check(!/hukommelse|memory/i.test(again), "no note after a start that went well");
} catch (e) {
  log(`FAILED: ${e.message}`);
  failed = true;
} finally {
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
