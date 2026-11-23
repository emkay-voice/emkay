// Emkay – machine translation in the browser, for Emkay Dev's "Add language"
// (emkay-voice/vscode-emkay#2).
//
// The same models OVOS' ovos-localize translates skills with (through
// linguonnx): Marian (OPUS-MT) models in ONNX, int8, from TigreGotico on
// Hugging Face – one English → <language> model per Emkay language. They run
// here, in the Pyodide worker, with onnxruntime-web (ort/, which Emkay ships
// for the wake word and Piper), so a skill's text never leaves the device.
// A model is downloaded the first time its language is asked for (100–300 MB)
// and kept in the Cache API.
//
// This file only runs the model on token ids (greedy decoding). Python does
// the rest (py/emkay_mobile/translate.py): SentencePiece in and out, and
// ovos-localize's own masking of {slots} and (a|b) alternatives.

import { oneAtATime } from "./model-queue.js";
import { open as openSplit } from "./onnx-split.js";

const BASE = new URL("./", import.meta.url).href;
const HF = "https://huggingface.co/";
const CACHE = "emkay-mt-v1";

/**
 * English → <language>: the linguonnx model for it (its model index,
 * model_index/translate.json: the smallest permissive int8 model). target:
 * the token a multi-target model needs in front of the sentence.
 */
export const MODELS = {
  da: { repo: "TigreGotico/opus-mt-en-da-onnx", id: "opus-mt-en-da-int8", mb: 106 },
  de: { repo: "TigreGotico/opus-mt-en-de-onnx", id: "opus-mt-en-de-int8", mb: 106 },
  nl: { repo: "TigreGotico/opus-mt-en-nl-onnx", id: "opus-mt-en-nl-int8", mb: 115 },
  fr: { repo: "TigreGotico/opus-mt-en-fr-onnx", id: "opus-mt-en-fr-int8", mb: 107 },
  es: { repo: "TigreGotico/opus-mt-en-es-onnx", id: "opus-mt-en-es-int8", mb: 113 },
  it: { repo: "TigreGotico/opus-mt-en-it-onnx", id: "opus-mt-en-it-int8", mb: 129 },
  pt: { repo: "TigreGotico/opus-mt-en-pt-onnx", id: "opus-mt-en-pt-int8", mb: 292, target: ">>por<<" },
  ca: { repo: "TigreGotico/opus-mt-en-ca-onnx", id: "opus-mt-en-ca-int8", mb: 103 },
  gl: { repo: "TigreGotico/opus-mt-en-gl-onnx", id: "opus-mt-en-gl-int8", mb: 103 },
  eu: { repo: "TigreGotico/mt-hitz-en-eu-onnx", id: "mt-hitz-en-eu-int8", mb: 58 },
};
const SIDE = ["config.json", "vocab.json", "source.spm", "target.spm"];
const GRAPHS = ["encoder_model.onnx", "decoder_model.onnx"];

let ortReady = null;
const loading = new Map();   // lang -> Promise<{enc, dec, cfg}>

const progress = (name, f, state = "loading") => globalThis.emkayModelProgress?.("mt", name, f, state);

function ort() {
  ortReady ??= import(BASE + "ort/ort.wasm.bundle.min.mjs").then((m) => {
    const o = m.default ?? m;
    o.env.wasm.numThreads = 1;
    o.env.wasm.wasmPaths = BASE + "ort/";
    return o;
  });
  return ortReady;
}

const url = (m, file) => `${HF}${m.repo}/resolve/main/int8/${file}`;

/** Bytes of a model file, from the Cache API when we have it. */
async function cached(u, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  let res = cache && (await cache.match(u));
  if (res) return new Uint8Array(await res.arrayBuffer());
  res = await fetch(u);
  if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let bytes;
  if (onProgress && total && res.body) {
    bytes = new Uint8Array(total);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > bytes.length) { const more = new Uint8Array(got + value.length); more.set(bytes); bytes = more; }
      bytes.set(value, got);
      got += value.length;
      onProgress(got / total);
    }
    bytes = bytes.subarray(0, got);
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (cache) await cache.put(u, new Response(bytes)).catch(() => {});
  return bytes;
}

function model(lang) {
  const m = MODELS[lang.split("-")[0].toLowerCase()];
  if (!m) throw new Error(`no translation model for ${lang}`);
  return m;
}

/** The model's small files for Python: {config, vocab: text, source_spm, target_spm: bytes}. */
export async function side(lang) {
  const m = model(lang);
  const [config, vocab, source, target] = await Promise.all(SIDE.map((f) => cached(url(m, f))));
  const dec = new TextDecoder();
  return { id: m.id, repo: m.repo, target: m.target || "", config: dec.decode(config), vocab: dec.decode(vocab),
           source_spm: source, target_spm: target };
}

/** The ONNX sessions for a language, downloaded (once) and opened. */
function load(lang) {
  const m = model(lang);
  if (!loading.has(m.id)) {
    loading.set(m.id, (async () => {
      const o = await ort();
      const parts = [0, 0];
      const bytes = await Promise.all(GRAPHS.map((f, i) => cached(url(m, f), (p) => {
        parts[i] = p;
        progress(m.id, (parts[0] + parts[1]) / 2);
      })));
      progress(m.id, 1, "reading");
      const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      // one after the other, with the weights as external data (onnx-split.js)
      const [enc, dec] = await oneAtATime(() => Promise.all(bytes.splice(0).map((b) => openSplit(o, b, opts))));
      const cfg = JSON.parse(new TextDecoder().decode(await cached(url(m, "config.json"))));
      progress(m.id, 1, "ready");
      return { o, enc, dec, cfg };
    })().catch((e) => { loading.delete(m.id); progress(m.id, 0, "error"); throw e; }));
  }
  return loading.get(m.id);
}

/** Start downloading a language's model now (not awaited by the caller). */
export function ready(lang) { return load(lang).then(() => true); }

/**
 * Greedy decoding: the target token ids for source ids (which end in </s>),
 * without the decoder's start token and without </s>.
 */
export async function generate(lang, ids, maxLen = 96) {
  const { o, enc, dec, cfg } = await load(lang);
  const n = ids.length;
  const input = new o.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, n]);
  const mask = new o.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]);
  const h = Object.values(await enc.run({ input_ids: input, attention_mask: mask }))[0];   // last_hidden_state
  const eos = cfg.eos_token_id, pad = cfg.pad_token_id;
  const out = [cfg.decoder_start_token_id ?? pad];
  for (let step = 0; step < Math.min(maxLen, n * 3 + 10); step++) {
    const d = new o.Tensor("int64", BigInt64Array.from(out, BigInt), [1, out.length]);
    const logits = (await dec.run({ input_ids: d, encoder_hidden_states: h, encoder_attention_mask: mask })).logits;
    const V = logits.dims[2], row = logits.data.subarray((out.length - 1) * V, out.length * V);
    let best = -1, bestV = -Infinity;
    for (let i = 0; i < V; i++) {
      if (i !== pad && row[i] > bestV) { bestV = row[i]; best = i; }
    }
    if (best === eos) break;
    out.push(best);
  }
  return out.slice(1);
}
