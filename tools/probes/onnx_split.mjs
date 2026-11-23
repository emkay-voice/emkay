// web/onnx-split.js on a real model: WebAssembly memory and outputs, one
// file vs. split in the browser.
//
//   node tools/probes/onnx_split.mjs MODEL.onnx           both, compared
//   node tools/probes/onnx_split.mjs MODEL.onnx one|split|blob   one way (a run of its own)
//
// Each way runs in a process of its own (WebAssembly memory never shrinks).
// Inputs are made from the model's input metadata, the same every time.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [file, how] = process.argv.slice(2);
if (!how) {
  const me = new URL(import.meta.url).pathname;
  const out = {};
  for (const way of ["one", "split", "blob"]) {
    out[way] = JSON.parse(execFileSync(process.execPath, [me, file, way], { maxBuffer: 1 << 30 }).toString());
    console.log(`${way.padEnd(6)} wasm ${String(out[way].wasm).padStart(5)} MB  open ${out[way].ms} ms` +
      (out[way].moved ? `  (${out[way].moved} weights moved out, graph ${out[way].graph} KB)` : ""));
  }
  const same = JSON.stringify(out.one.outputs) === JSON.stringify(out.split.outputs)
    && JSON.stringify(out.one.outputs) === JSON.stringify(out.blob.outputs);
  console.log(out.one.outputs === null ? "no run (inputs not made)" : same ? "outputs: identical" : "outputs: DIFFERENT");
  process.exit(same ? 0 : 1);
}

let heap = null;
const Memory = WebAssembly.Memory;
WebAssembly.Memory = new Proxy(Memory, { construct(T, a) { return (heap = new T(...a)); } });
const ort = await import("onnxruntime-web");
const { split } = await import("../../web/onnx-split.js");
ort.env.wasm.numThreads = 1;

const b = readFileSync(file);
let bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const options = { executionProviders: ["wasm"], enableCpuMemArena: false, enableMemPattern: false };
const result = {};
const t0 = performance.now();
if (how !== "one") {
  const s = await split(how === "blob" ? new Blob([bytes]) : bytes, "model.onnx_data");
  options.externalData = [{ path: "model.onnx_data", data: s.data }];
  bytes = s.graph;
  Object.assign(result, { moved: s.moved.count, graph: Math.round(s.graph.length / 1024) });
}
const session = await ort.InferenceSession.create(bytes, options);
result.ms = Math.round(performance.now() - t0);
result.wasm = Math.round(heap.buffer.byteLength / 1048576);

// deterministic inputs from the metadata: symbolic sizes small, ids small
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function input(meta) {
  const shape = (meta.shape || []).map((d) => (typeof d === "number" && d > 0 ? d : 1));
  if (meta.name === "input" && meta.type === "int64") shape[shape.length - 1] = 40;   // Piper: phoneme ids
  if (/input_values/.test(meta.name)) shape[shape.length - 1] = 16000;
  if (meta.name === "input_features") shape.splice(0, 3, 1, 80, 3000);         // Whisper: 30 s of mel
  if (meta.name === "encoder_hidden_states") shape.splice(0, 3, 1, 1500, 512); // whisper-base's
  if (/past_key_values/.test(meta.name)) shape[2] = 0;
  const n = shape.reduce((a, d) => a * d, 1);
  switch (meta.type) {
    case "float32": return new ort.Tensor("float32", Float32Array.from({ length: n }, () => rnd() - 0.5), shape);
    case "int64": return new ort.Tensor("int64", BigInt64Array.from({ length: n }, () => BigInt(Math.floor(rnd() * 50) + 1)), shape);
    case "bool": return new ort.Tensor("bool", new Uint8Array(n), shape);
    default: throw new Error(`no input for ${meta.name} (${meta.type})`);
  }
}
try {
  const feeds = {};
  for (const meta of session.inputMetadata) feeds[meta.name] = input(meta);
  if (feeds.input_lengths) feeds.input_lengths = new ort.Tensor("int64", BigInt64Array.of(40n), [1]);
  // Piper adds random noise (RandomNormalLike) scaled by these: none, to compare
  if (feeds.scales) feeds.scales = new ort.Tensor("float32", Float32Array.of(0, 1, 0), [3]);
  const out = await session.run(feeds);
  result.outputs = Object.fromEntries(Object.entries(out).map(([k, v]) => {
    let h = 0;                                   // a checksum of the bytes: identical or not
    const u8 = new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength);
    for (let i = 0; i < u8.length; i++) h = (h * 31 + u8[i]) >>> 0;
    return [k, [v.dims, h]];
  }));
  result.wasm_after_run = Math.round(heap.buffer.byteLength / 1048576);
} catch (e) {
  result.outputs = null;
  result.error = String(e.message || e).slice(0, 200);
}
console.log(JSON.stringify(result));
