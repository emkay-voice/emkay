// Emkay Dev – Emkay as the test device for a skill you are writing (#43).
//
// With ?dev, Emkay runs inside another window – the "Emkay Dev" extension's
// panel in VS Code (vscode.dev, github.dev, Codespaces or the desktop app),
// or a page on dev.emkay.ai or blocks.emkay.ai (Emkay Blocks) – and takes
// orders from it with postMessage:
//
//   to Emkay  {emkayDev: 1, op, id?, ...}
//     hello                         who are you, are you up?
//     load   {skillId, files, requirements}
//                                   (re)load a skill from its files:
//                                   files is {"path/in/skill": base64}
//     unload {skillId}              stop the dev copy (an installed copy returns)
//     say    {text}                 an utterance, as if typed
//     test   {row}                  one golden utterance, judged (dev.py);
//                                   skipped when not in Emkay's language
//     lang                          the language Emkay speaks now
//     translate {lang, files}       a skill's en-US files translated into lang,
//                                   on this device (translate.py, mt.js)
//     skills                        the skill ids Emkay runs
//     python {code}                 run Python in Emkay's OVOS; its value as text
//
//   from Emkay  {emkayDev: 1, op, ...}
//     hello  {version, ready, lang} the answer to hello, and once OVOS is up
//     result {id, ok, result|error} the answer to an op with an id
//     bus    {raw}                  every bus message (JSON string)
//     log    {record}               an OVOS log line (dev.py)
//
// Only windows on the origins in ALLOWED may give orders. Emkay in such a
// frame has its own storage (browsers keep a frame's storage apart per site),
// so a dev Emkay never touches the one you use day to day.

/** Who may drive a dev Emkay: VS Code's webviews (web and desktop), dev.emkay.ai, Emkay Blocks, and a local page. */
const ALLOWED = [
  /^https:\/\/[a-z0-9-]+\.vscode-cdn\.net$/,
  /^vscode-webview:\/\/[a-z0-9-]+$/,
  /^https:\/\/dev\.emkay\.ai$/,
  /^https:\/\/blocks\.emkay\.ai$/,   // Emkay Blocks (#134)
  /^https:\/\/emkay-voice\.github\.io$/,
  // a page on this computer, also VS Code for the Web run locally (@vscode/test-web),
  // whose webviews are on <hash>.localhost
  /^http:\/\/(([a-z0-9-]+\.)?localhost|127\.0\.0\.1)(:\d+)?$/,
];

/**
 * Start the bridge.
 * @param {object} emkay
 * @param {(cmd: string, args?: object) => Promise<any>} emkay.call  worker.js commands
 * @param {Promise<void>} emkay.ready  resolves once OVOS is up
 * @param {(fn: (raw: string) => void) => void} emkay.onMessage  every bus message
 * @param {(kind: string, fn: (d: object) => void) => void} emkay.on  the brain's events
 */
export function startDev({ call, ready, onMessage, on }) {
  // Emkay's build (build.json, tools/build_site.py), for the extension to show
  let version = "";
  fetch("build.json", { cache: "no-cache" }).then((r) => r.json())
    .then((b) => { version = [b.version, b.commit && String(b.commit).slice(0, 7)].filter(Boolean).join(" "); })
    .catch(() => {});
  let parent = null;   // {source, origin} of the window that said hello
  let up = false;
  const send = (msg) => {
    if (!parent) return;
    try { parent.source.postMessage({ emkayDev: 1, ...msg }, parent.origin); } catch {}
  };

  document.documentElement.classList.add("emkay-dev");
  const badge = document.createElement("div");
  badge.className = "dev-badge";
  badge.textContent = "DEV";
  badge.title = "Emkay Dev: this Emkay runs the skill from your editor (dev.emkay.ai)";
  document.body.append(badge);

  onMessage((raw) => send({ op: "bus", raw }));
  on("devlog", (d) => send({ op: "log", record: JSON.parse(d.payload) }));

  ready.then(async () => {
    await call("dev_enable");
    up = true;
    send({ op: "hello", version, ready: true, lang: await call("dev_lang") });
  });

  const ops = {
    hello: async () => ({ version, ready: up, lang: up ? await call("dev_lang") : null }),
    // kind "plugin" (a PHAL plugin): entry is its opm.phal "module:Class"
    load: async ({ skillId, files, requirements, kind, entry }) => {
      await ready;
      const out = JSON.parse(await call("dev_load", { skillId, files, requirements, kind, entry }));
      badge.textContent = out.ok ? `DEV · ${skillId}` : "DEV · ✗";
      badge.classList.toggle("bad", !out.ok);
      return out;
    },
    unload: async ({ skillId }) => {
      await ready;
      const out = JSON.parse(await call("dev_unload", { skillId }));
      badge.textContent = "DEV";
      badge.classList.remove("bad");
      return out;
    },
    say: async ({ text }) => { await ready; await call("say", { text }); return { ok: true }; },
    test: async ({ row }) => { await ready; return JSON.parse(await call("dev_test", { row })); },
    skills: async () => { await ready; return JSON.parse(await call("dev_skills")); },
    lang: async () => { await ready; return await call("dev_lang"); },
    // Add language: {lang, files: {path in locale/en-US: text}} -> translate.py's answer
    translate: async ({ lang, files }) => { await ready; return JSON.parse(await call("dev_translate", { lang, files })); },
    // a line of Python in this Emkay's OVOS, for looking around while debugging
    python: async ({ code }) => { await ready; return await call("python_async", { code }); },
  };

  addEventListener("message", async (e) => {
    const data = e.data;
    if (!data || data.emkayDev !== 1 || typeof data.op !== "string") return;
    if (!ALLOWED.some((re) => re.test(e.origin))) {
      console.warn("[emkay dev] ignored a message from", e.origin);
      return;
    }
    if (!e.source) return;
    parent = { source: e.source, origin: e.origin };
    const op = ops[data.op];
    if (!op) return send({ op: "result", id: data.id, ok: false, error: `no op "${data.op}"` });
    try {
      const result = await op(data);
      if (data.op === "hello") send({ op: "hello", ...result });
      if (data.id !== undefined) send({ op: "result", id: data.id, ok: true, result });
    } catch (err) {
      send({ op: "result", id: data.id, ok: false, error: String(err?.message || err) });
    }
  });
  // Emkay cannot speak first: the parent's origin is unknown until it
  // writes. The parent sends "hello" until it gets an answer.
}
