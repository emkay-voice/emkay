// Emkay – the speech models in a worker of their own.
//
// Piper (piper.js), Whisper (whisper.js), the translation models (mt.js)
// and the ONNX models of Python plugins (ortshim.js)
// run ONNX Runtime Web, and opening a model or running it is seconds of CPU.
// In worker.js that time was taken from Pyodide and OVOS: a question asked
// while a voice was being opened waited for it (#4). onnxruntime-web's own
// proxy worker is only made on a page, never in a worker, so worker.js
// starts this one and calls the three modules here:
//
//   worker.js -> here   {id, mod, fn, args, caller}     call mod.fn(...args)
//                       {kind: "local-only", on}         netlog.setLocalOnly
//   here -> worker.js   {id, result} | {id, error, name}
//                       {kind: "model", args}             emkayModelProgress
//                       {kind: "net", entry}              a network log entry

import * as netlog from "./netlog.js";
import { capture } from "./screenlog.js";

// its warnings and errors, for the page's log (?log, screenlog.js)
capture((line) => self.postMessage({ kind: "log", line }), "speech");

// the downloads made here go into worker.js's network log
netlog.install({ sink: (entry) => self.postMessage({ kind: "net", entry }) });

globalThis.emkayModelProgress = (...args) => self.postMessage({ kind: "model", args });

const MODULES = { piper: "./piper.js", whisper: "./whisper.js", mt: "./mt.js", ort: "./ortshim.js" };

self.onmessage = async ({ data }) => {
  if (data.kind === "local-only") { netlog.setLocalOnly(data.on); return; }
  const { id, mod, fn, args, caller } = data;
  try {
    globalThis.emkayNetCaller = caller ?? null;     // who the downloads are for
    const m = await import(MODULES[mod]);
    const result = await m[fn](...args);
    const whole = result instanceof Uint8Array && result.byteOffset === 0
      && result.byteLength === result.buffer.byteLength;
    const transfer = whole ? [result.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e), name: e?.name || "Error" });
  }
};
