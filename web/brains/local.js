// Emkay – the local brain: OpenVoiceOS in this browser, in a Web Worker
// (worker.js + Pyodide). Today's Emkay, moved behind the brain interface
// (brains/brain.js, issue #28) without changing what it does.
//
// The worker posts two kinds of messages:
//   {id, result|error}   the answer to a call()
//   {kind, payload, …}   something happening: status, gui, core, audio,
//                        phal, model, bus – handed to on(kind, fn)

/**
 * Start the worker now (it begins loading Pyodide at once, as before).
 * @returns {import("./brain.js").Brain}
 */
export function createLocalBrain() {
  // a Worker's URL is resolved against the page, so this is web/worker.js
  const worker = new Worker("worker.js", { type: "module" });
  let nextId = 1;
  const waiting = new Map();
  const handlers = new Map();   // kind -> Set of fn(data)
  const busListeners = new Set();   // fn(raw bus message, a JSON string)

  worker.onmessage = ({ data }) => {
    if (data.id) {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      return data.error ? w.reject(new Error(data.error)) : w.resolve(data.result);
    }
    if (data.kind === "core") for (const fn of busListeners) fn(data.payload);
    for (const fn of handlers.get(data.kind) || []) fn(data);
  };
  // OVOS' worker itself gone (out of memory, say): the page's log says so (screenlog.js)
  worker.onerror = (e) => {
    const line = `${new Date().toTimeString().slice(0, 8)} ovos uncaught ${e.message || "the worker stopped (out of memory?)"}`;
    for (const fn of handlers.get("log") || []) fn({ kind: "log", line });
  };

  /**
   * Ask the worker to run a command; resolves with its result.
   * @param {string} cmd one of worker.js `commands`
   * @param {object} args the command's arguments
   * @param {Transferable[]} transfer buffers to move instead of copy
   */
  function call(cmd, args = {}, transfer = []) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, ...args }, transfer);
    });
  }

  return {
    kind: "local",
    can: { panel: true, store: true, install: true, netlog: true, gui: true },
    call,
    on(kind, fn) {
      if (!handlers.has(kind)) handlers.set(kind, new Set());
      handlers.get(kind).add(fn);
    },
    emit(type, data = {}, context = {}) {
      return call("core_send", { raw: JSON.stringify({ type, data, context }) });
    },
    onMessage(fn) { busListeners.add(fn); },
    offMessage(fn) { busListeners.delete(fn); },
    stop() { worker.terminate(); },
  };
}
