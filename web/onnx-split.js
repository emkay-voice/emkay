// Emkay – an ONNX model's weights as external data, made in the browser.
//
// onnxruntime-web opens a one-file model by copying it into WebAssembly
// memory and parsing it there: while it opens, the weights are in that
// memory two to three times, and WebAssembly memory never shrinks. Røst at
// 8 bit (303 MB) left 635 MB taken, and a tablet with little memory closed
// the page and started over. With the weights as external data, onnxruntime
// reads each one straight into its tensor (Røst: 358 MB, whisper-base's
// encoder 218 -> 120 MB, a Piper voice 144 -> 83 MB; the same outputs).
//
// split() makes that from any one-file model, whoever published it: a small
// new graph whose tensors point into the original file (location, offset,
// length), and the original file itself as the data. The weights are not
// copied or even read: from a Blob (a cached download, which the browser
// keeps on disk) only the graph's own bytes are, in windows of a few MB.
//
//   const { graph, data } = await split(fileOrBytes, "model.onnx_data");
//   ort.InferenceSession.create(graph, { externalData: [{ path: "model.onnx_data", data }] });
//
// open() does that for onnxruntime-web directly (piper.js, mt.js, ortshim.js);
// whisper.js uses split() under transformers.js.
//
// Only the protobuf fields that can hold tensors are walked (onnx.proto3):
//   ModelProto     7 graph, 25 functions
//   GraphProto     1 node, 5 initializer
//   FunctionProto  7 node
//   NodeProto      5 attribute
//   AttributeProto 5 t, 6 g, 10 tensors, 11 graphs
//   TensorProto    9 raw_data -> 13 external_data + 14 data_location
// everything else is copied as it is.

/** Weights smaller than this stay in the graph (as onnx's own tools do). */
const MIN = 1024;
/** How much of a Blob is read at a time. */
const WINDOW = 8 << 20;

const MODEL = { 7: "graph", 25: "function" };
const KINDS = {
  graph: { 1: "node", 5: "tensor" },
  function: { 7: "node" },
  node: { 5: "attribute" },
  attribute: { 5: "tensor", 6: "graph", 10: "tensor", 11: "graph" },
};

/** Bytes of a Uint8Array, or of a Blob read a window at a time. */
class Reader {
  constructor(src) {
    this.blob = src instanceof Blob ? src : null;
    this.size = this.blob ? src.size : src.length;
    this.buf = this.blob ? new Uint8Array(0) : src;
    this.base = 0;                   // where buf starts in the file
  }
  /** Make bytes [pos, pos + n) readable. */
  async need(pos, n) {
    n = Math.min(n, this.size - pos);
    if (pos >= this.base && pos + n <= this.base + this.buf.length) return;
    this.base = pos;
    this.buf = new Uint8Array(await this.blob.slice(pos, pos + Math.max(n, WINDOW)).arrayBuffer());
  }
  at(pos) { return this.buf[pos - this.base]; }
  /** Bytes [pos, pos + n), after need(): a view for a Uint8Array, a copy for a Blob. */
  bytes(pos, n) {
    const v = this.buf.subarray(pos - this.base, pos - this.base + n);
    return this.blob ? v.slice() : v;
  }
  async varint(pos) {
    await this.need(pos, 10);
    let v = 0, mul = 1, b;
    do { b = this.at(pos++); v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return [v, pos];
  }
}

function putVarint(v) {
  const out = [];
  while (v > 127) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return Uint8Array.from(out);
}

const text = new TextEncoder();
const bytesField = (field, payload) => [putVarint(field * 8 + 2), putVarint(payload.length), payload];
/** One StringStringEntryProto {1: key, 2: value}, as field 13 of a TensorProto. */
const entry = (key, value) =>
  bytesField(13, concat([...bytesField(1, text.encode(key)), ...bytesField(2, text.encode(String(value)))]));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The message [start, end) of `kind`, rewritten: a list of byte pieces. */
async function message(r, start, end, kind, location, moved) {
  const fields = kind === "model" ? MODEL : KINDS[kind] || {};
  const pieces = [];
  let raw = null, external = false;
  let pos = start;
  while (pos < end) {
    const at = pos;
    let tag;
    [tag, pos] = await r.varint(pos);
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) pos = (await r.varint(pos))[1];
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let len;
      [len, pos] = await r.varint(pos);
      const body = pos;
      pos += len;
      if (kind === "tensor" && field === 9 && len >= MIN) { raw = [body, len]; continue; }   // not read
      if (kind === "tensor" && field === 13) external = true;
      const inner = fields[field];
      if (inner) {
        const sub = await message(r, body, pos, inner, location, moved);
        const size = sub.reduce((n, p) => n + p.length, 0);
        pieces.push(putVarint(tag), putVarint(size), ...sub);
        continue;
      }
    } else {
      throw new Error(`wire type ${wire} at byte ${at}: not an ONNX model`);
    }
    await r.need(at, pos - at);
    pieces.push(r.bytes(at, pos - at));
  }
  if (raw && external) throw new Error("a tensor with both raw_data and external_data");
  if (raw) {
    pieces.push(...entry("location", location), ...entry("offset", raw[0]), ...entry("length", raw[1]),
      putVarint(14 * 8), putVarint(1));          // data_location: EXTERNAL
    moved.count++; moved.bytes += raw[1];
  }
  return pieces;
}

/**
 * `src` (a one-file ONNX model: Uint8Array, ArrayBuffer or Blob) as a small
 * graph plus external data. `location` is the data's name in the graph,
 * given to onnxruntime as externalData's path. `data` is `src` itself (as a
 * Uint8Array or Blob): keep no other reference to it, so it can go once the
 * session is made. moved.count is 0 when there was nothing to move (a model
 * that is split already, or a tiny one): then open `data` as it is.
 */
export async function split(src, location = "model.onnx_data") {
  if (!(src instanceof Blob) && !(src instanceof Uint8Array)) {
    src = ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : new Uint8Array(src);
  }
  const r = new Reader(src);
  const moved = { count: 0, bytes: 0 };
  const graph = concat(await message(r, 0, r.size, "model", location, moved));
  return { graph, data: src, moved };
}

/** One opening at a time per onnxruntime: each one unmounts every external data file when done. */
const opening = new WeakMap();
let names = 0;

/**
 * ort.InferenceSession.create(bytes, options), with the weights as external
 * data (split()). A model with nothing to move is opened as it is; one
 * split() can't read, or onnxruntime won't open split, too: never worse
 * than before.
 */
export function open(ort, bytes, options = {}) {
  const turn = (opening.get(ort) ?? Promise.resolve()).then(async () => {
    const location = `emkay-split-${++names}.onnx_data`;
    let s;
    try {
      s = await split(bytes, location);
    } catch (e) {
      console.warn("[emkay] onnx-split:", e.message);
      return ort.InferenceSession.create(bytes, options);
    }
    bytes = null;                                // nothing here keeps the file once opened
    if (!s.moved.count) return ort.InferenceSession.create(s.data, options);
    return ort.InferenceSession.create(s.graph, { ...options, externalData: [{ path: location, data: s.data }] })
      .catch((e) => {
        console.warn("[emkay] onnx-split: opening it split failed, opening it whole:", e.message);
        return ort.InferenceSession.create(s.data, options);
      });
  });
  opening.set(ort, turn.catch(() => {}));
  return turn;
}
