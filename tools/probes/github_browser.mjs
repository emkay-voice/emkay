// A skill straight from GitHub (#49), as a user gets it, in a real (headless)
// Chromium: open ?install=github:owner/repo, see the card, tap Install, talk
// to the skill, then Update and Remove from menu → From GitHub.
//
//   CHROME=~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
//     node tools/probes/github_browser.mjs [url] [owner/repo] [utterance] [answer regex]
//
// The defaults are Emkay Dev's own template, which answers "hello from my skill".
import { spawn } from "child_process";

const base = process.argv[2] || "http://127.0.0.1:8080/";
const repo = process.argv[3] || "emkay-voice/ovos-skill-hello-example";
const ask = process.argv[4] || "hello from my skill";
const answer = new RegExp(process.argv[5] || "your very own skill|first skill works", "i");
const port = 9343;
const chrome = spawn(process.env.CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/emkay-chrome-github",
  "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  "--lang=en-US", "--accept-lang=en-US", "about:blank"], { stdio: "ignore" });
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
const spoken = [];
const INTERESTING = /\(pip\)|github|ATTEMPTING TO LOAD|loaded successfully|unload|Traceback|Error|ovos\.pip/i;
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
const text = (elId) => js(`document.getElementById(${JSON.stringify(elId)})?.textContent || ""`);
const shown = (elId) => `!document.getElementById(${JSON.stringify(elId)}).hidden`;
const py = (code) => js(`window.emkay.call("python", {code: ${JSON.stringify(code)}})`);
const skills = async () => JSON.parse(await py("import json; from emkay_mobile import boot; json.dumps(sorted(boot._manager.plugin_skills))"));

try {
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.enable");
  await send("Page.navigate", { url: `${base}?install=github:${repo}` });
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot");
  await js(`document.getElementById("start").click(); true`);
  await until(shown("github"), 60, "the GitHub card");
  await until(`document.getElementById("gh-facts").textContent.includes("·") || document.getElementById("gh-about").textContent`, 30, "repo info");
  log(`card: repo="${await text("gh-repo")}" about="${await text("gh-about")}" facts="${await text("gh-facts")}"`);
  log(`warning shown: ${await js(`!!document.querySelector("#gh-offer .gh-warning").textContent`)}`);
  const before = await skills();
  await js(`document.getElementById("gh-install").click(); true`);
  await until(`/ok|fail/.test(document.getElementById("gh-status").className)`, 600, "the install");
  log(`install: ${await js(`document.getElementById("gh-status").className`)} "${await text("gh-status")}"`);
  if (await js(`!document.getElementById("gh-detail").hidden`)) log(`detail: ${(await js(`document.querySelector("#gh-detail pre").textContent`)).slice(-600)}`);
  const after = await skills();
  log(`new skills: ${after.filter((s) => !before.includes(s)).join(", ") || "–"}`);
  log(`listed: ${await js(`[...document.querySelectorAll("#gh-list .gh-item b")].map((b) => b.textContent).join(", ")`)}`);
  log(`installed: ${JSON.stringify(await js(`window.emkay.call("gh_installed")`))}`);

  // talk to it (padatious trains the new intents first)
  await js(`document.getElementById("github-close").click(); true`);
  await py(`from emkay_mobile import boot
import builtins
builtins._gh_said = []
boot.bus().on("speak", lambda m: builtins._gh_said.append(m.data.get("utterance")))
None`);
  let said = [];
  for (let i = 0; i < 6 && !said.some((s) => answer.test(s)); i++) {
    await sleep(i ? 15000 : 20000);
    await js(`window.emkay.call("say", {text: ${JSON.stringify(ask)}})`);
    await sleep(6000);
    said = JSON.parse(await py("import json, builtins; json.dumps(builtins._gh_said)"));
  }
  log(`asked "${ask}": ${answer.test(said.join(" ")) ? "answered by the skill" : "NOT answered"} said ${JSON.stringify(said.slice(-2))}`);

  // it is still there after a reload (~/.local is kept in IndexedDB)
  await js(`window.emkay.call("sync").then(() => true)`);
  await send("Page.navigate", { url: base });
  await sleep(3000);
  await until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "OVOS boot after reload");
  await js(`document.getElementById("start").click(); true`);
  await sleep(3000);
  log(`after reload: still loaded=${(await skills()).some((s) => !before.includes(s))}`);

  // menu → About → From GitHub (for developers): Update (same commit: up
  // to date), then Remove (two taps)
  await js(`document.getElementById("menu-button").click(); true`);
  await until(shown("menu"), 10, "the menu");
  await js(`document.getElementById("menu-about").click(); true`);
  await until(shown("about"), 10, "About");
  log(`menu entry: "${await js(`document.querySelector("#menu-github b").textContent`)}" shown=${await js(shown("menu-github"))}`);
  await js(`document.getElementById("menu-github").click(); true`);
  await until(`document.querySelectorAll("#gh-list .gh-item").length > 0`, 20, "the list");
  await js(`document.querySelector("#gh-list .gh-item .row button").click(); true`);
  await until(`/ok|fail/.test(document.getElementById("gh-note").className)`, 600, "the update");
  log(`update: ${await js(`document.getElementById("gh-note").className`)} "${await text("gh-note")}"`);
  await js(`document.querySelectorAll("#gh-list .gh-item .row button")[1].click(); true`);
  log(`remove first tap: "${await js(`document.querySelectorAll("#gh-list .gh-item .row button")[1].textContent`)}"`);
  await js(`document.querySelectorAll("#gh-list .gh-item .row button")[1].click(); true`);
  await until(`/ok|fail/.test(document.getElementById("gh-note").className) && document.getElementById("gh-note").textContent !== ${JSON.stringify(await text("gh-note"))}`, 300, "the removal");
  log(`remove: ${await js(`document.getElementById("gh-note").className`)} "${await text("gh-note")}"`);
  await sleep(3000);
  const gone = await skills();
  log(`after remove: skill gone=${!gone.some((s) => !before.includes(s))} listed=${await js(`document.querySelectorAll("#gh-list .gh-item").length`)} empty="${await js(`document.querySelector("#gh-list p")?.textContent || ""`)}"`);
} catch (e) {
  log(`FAILED: ${e.message}`);
} finally {
  log("worker log:");
  for (const l of workerLines.slice(-60)) console.log(`  ${l}`);
  ws.close();
  chrome.kill();
}
