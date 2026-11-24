// Emkay – a log on the screen (?log), for a device without a console at hand
// (a tablet, a phone): Emkay's own lines ("[emkay] ...") and every warning
// and error, from the page and from its workers (worker.js, speech-worker.js),
// with a button that copies them.
//
//   in a worker  capture((line) => self.postMessage({kind: "log", line}))
//   on the page  capture(screen.add) and, with ?log, the panel (show())

const MAX = 1000;

/** What a console call says, as one line. */
function text(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
}

/**
 * Hand `send` every "[emkay]" line, every warning and error, and what was
 * thrown and not caught, as "HH:MM:SS where level text". Cheap: only those.
 */
export function capture(send, where) {
  const stamp = () => new Date().toTimeString().slice(0, 8);
  for (const level of ["log", "info", "warn", "error"]) {
    const plain = console[level].bind(console);
    console[level] = (...args) => {
      plain(...args);
      const s = text(args);
      // OVOS' own INFO and DEBUG lines (Python's stderr is console.warn) are not news
      if (/ - (DEBUG|INFO) - /.test(s)) return;
      if (level === "warn" || level === "error" || s.startsWith("[emkay]")) {
        try { send(`${stamp()} ${where} ${level === "log" || level === "info" ? "" : level + " "}${s}`); } catch {}
      }
    };
  }
  self.addEventListener("error", (e) => {
    try { send(`${stamp()} ${where} uncaught ${e.message ?? e} ${e.filename ? `(${e.filename.split("/").pop()}:${e.lineno})` : ""}`); } catch {}
  });
  self.addEventListener("unhandledrejection", (e) => {
    try { send(`${stamp()} ${where} unhandled ${text([e.reason])}`); } catch {}
  });
}

/** The lines kept on the page, and the panel that shows them (?log). */
export const screen = {
  lines: [],
  el: null,
  add(line) {
    if (line.length > 500) line = line.slice(0, 500) + " …";
    screen.lines.push(line);
    if (screen.lines.length > MAX) screen.lines.shift();
    if (!screen.el) return;
    const div = document.createElement("div");
    div.textContent = line;
    if (/ (warn|error|uncaught|unhandled) /.test(line)) div.style.color = /warn/.test(line) ? "#fc6" : "#f88";
    const list = screen.el.querySelector(".lines");
    list.append(div);
    while (list.childElementCount > MAX) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
  },
  /** The panel: the lines so far and every new one, Copy and Hide. */
  show() {
    const el = document.createElement("div");
    el.id = "screen-log";
    el.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:30vh;z-index:99999;display:flex;" +
      "flex-direction:column;background:rgba(0,0,0,.88);color:#ddd;font:11px/1.35 monospace";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:8px;padding:4px 6px;background:#222";
    const button = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "font:12px sans-serif;padding:4px 10px";
      b.onclick = fn;
      bar.append(b);
      return b;
    };
    const copy = button("Copy", async () => {
      const all = `${navigator.userAgent}\nmemory ${navigator.deviceMemory ?? "?"} GB, ` +
        `${navigator.hardwareConcurrency ?? "?"} cores\n` + screen.lines.join("\n");
      try {
        await navigator.clipboard.writeText(all);
        copy.textContent = "Copied";
      } catch {
        // no clipboard (not allowed here): select the text to copy by hand
        const range = document.createRange();
        range.selectNodeContents(el.querySelector(".lines"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        copy.textContent = "Selected";
      }
      setTimeout(() => (copy.textContent = "Copy"), 2000);
    });
    const hide = button("Hide", () => {
      const list = el.querySelector(".lines");
      list.hidden = !list.hidden;
      el.style.height = list.hidden ? "auto" : "30vh";
      hide.textContent = list.hidden ? "Log" : "Hide";
    });
    const list = document.createElement("div");
    list.className = "lines";
    list.style.cssText = "flex:1;overflow:auto;padding:4px 6px;white-space:pre-wrap;word-break:break-word;user-select:text";
    el.append(bar, list);
    document.body.append(el);
    screen.el = el;
    for (const line of screen.lines.splice(0)) screen.add(line);
  },
};
