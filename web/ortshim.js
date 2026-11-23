// Emkay – ONNX models for Python plugins, run in the speech worker.
//
// py/emkay_mobile/shims/onnxruntime stands in for onnxruntime in Pyodide
// (it has no WebAssembly build); each session lives here, in
// onnxruntime-web (the wake word's, in ort/), so a model run holds up
// neither the page nor Pyodide. Tensors cross as raw bytes with their type
// and shape.

import { open as openSplit } from "./onnx-split.js";

const BASE = new URL("./", import.meta.url).href;
const ARRAYS = {
  float32: Float32Array, float64: Float64Array, int64: BigInt64Array, int32: Int32Array,
  int16: Int16Array, int8: Int8Array, uint8: Uint8Array, bool: Uint8Array,
};

let lib = null;
const sessions = new Map();
let ids = 0;

function ort() {
  lib ??= import(BASE + "ort/ort.wasm.bundle.min.mjs").then((o) => {
    o.env.wasm.wasmPaths = BASE + "ort/";     // never a CDN
    o.env.wasm.numThreads = 1;
    return o;
  });
  return lib;
}

/** A session for the model's bytes: {id, inputs, outputs} (their names). */
export async function create(bytes) {
  const o = await ort();
  const s = await openSplit(o, bytes, { executionProviders: ["wasm"] });   // weights as external data
  sessions.set(++ids, s);
  return { id: ids, inputs: [...s.inputNames], outputs: [...s.outputNames] };
}

/** Run session `id`: feeds [{name, type, dims, data: bytes}] -> [{type, dims, data: bytes}]. */
export async function run(id, names, feeds) {
  const o = await ort();
  const s = sessions.get(id);
  if (!s) throw new Error(`no ONNX session ${id}`);
  const input = {};
  for (const { name, type, dims, data } of feeds) {
    const own = data.slice();                  // aligned, and ours
    input[name] = new o.Tensor(type, new ARRAYS[type](own.buffer), dims);
  }
  const out = await s.run(input, names);
  return names.map((n) => {
    const t = out[n];
    return { type: t.type, dims: [...t.dims], data: new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength).slice() };
  });
}
