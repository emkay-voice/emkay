// Emkay – Whisper speech-to-text in the browser (issue #23, offline).
//
// OpenAI's Whisper as ONNX (onnx-community on Hugging Face), or a language's
// own model where it does better (Danish: Røst, a wav2vec2 model), run with
// transformers.js (Apache-2.0) in the Pyodide worker: the audio never leaves
// the phone. transformers.js does what a device's whisper plugin does
// (log-mel features, the encoder, decoding with the tokenizer); its
// onnxruntime-web runs on WebGPU where the browser has it, else WebAssembly.
//
//   * transformers.js and its onnxruntime wasm: whisper/ on this site,
//     fetched the first time Whisper is used
//   * the model (whisper-base by default, ~77 MB at 8 bit), from Hugging
//     Face the first time, kept in the browser's cache afterwards
//
// The OVOS side is ovos-stt-plugin-whisper-browser (its own package), which
// calls transcribe() through JSPI, as ovos-tts-plugin-piper-browser calls
// web/piper.js.

import { LEAN, oneAtATime } from "./model-queue.js";
import { split } from "./onnx-split.js";

const BASE = new URL("./", import.meta.url).href;

/** A model download's progress, for the page (worker.js emkayModelProgress). */
const modelProgress = (what, name, progress, state = "loading") =>
  globalThis.emkayModelProgress?.(what, name, progress, state);

let lib = null;                    // the transformers.js module
const pipes = new Map();           // model -> Promise<pipeline>
const loaded = new Set();          // models whose pipeline is ready

async function transformers() {
  lib ??= import(BASE + "whisper/transformers.min.js").then(async (t) => {
    t.env.allowLocalModels = false;            // models come from the Hub
    t.env.useBrowserCache = true;              // ... once, then the Cache API
    t.env.useCustomCache = true;               // ... with the .onnx files split (below)
    const store = await caches.open(t.env.cacheKey);
    t.env.customCache = splitCache(store);
    t.env.fetch = splitFetch(store, t.env.fetch);
    const wasm = t.env.backends.onnx.wasm;
    wasm.wasmPaths = BASE + "whisper/";        // never a CDN
    wasm.numThreads = 1;                       // no cross-origin isolation here
    return t;
  });
  return lib;
}

// ------------------------------------- the models' weights as external data
// onnxruntime-web opens a one-file model with its weights two to three
// times in WebAssembly memory, which never shrinks (onnx-split.js): Røst
// left 635 MB taken, 358 MB split. transformers.js opens a model split when
// asked to (use_external_data_format), getting X.onnx and X.onnx_data. In
// the cache (the same Cache API cache it uses itself) a one-file X.onnx
// stays as it is and is the weights, and its small graph is kept beside it
// as X.onnx?graph (splitCached):
//   * fetch (a download): straight into the cache, never whole into memory,
//     then split there;
//   * match (transformers.js also asks it only to see what is there, so it
//     never downloads): a one-file model an earlier Emkay cached is split
//     the first time it is asked for.
// A model published split already (emkay-voice's Røst) is kept as it is.

/** The model being opened: (url, loaded, total) while a file downloads (pipe()). */
let onDownload = null;
const busy = new Map();          // "get URL" / "split URL" -> Promise, while it runs

/** `job` once at a time per key: who asks meanwhile waits for the same one. */
function once(key, job) {
  if (!busy.has(key)) {
    const p = job();
    busy.set(key, p);
    p.finally(() => busy.delete(key)).catch(() => {});
  }
  return busy.get(key);
}

/** `url` downloaded into the cache (unless it is there); false: not on the server. */
function download(store, net, url) {
  return once(`get ${url}`, async () => {
    if (await store.match(url)) return true;
    const res = await net(url);
    if (!res.ok) return false;
    const total = Number(res.headers.get("content-length")) || 0;
    let loaded = 0;
    const counted = res.body.pipeThrough(new TransformStream({
      transform(chunk, out) { loaded += chunk.length; onDownload?.(url, loaded, total); out.enqueue(chunk); },
    }));
    await store.put(url, new Response(counted, { headers: res.headers }));
    return true;
  });
}

/** Where the graph of a one-file X.onnx split here is kept: X.onnx itself stays as it is. */
const GRAPH = "?graph";

/**
 * A cached one-file X.onnx split: its small graph kept as X.onnx?graph, and
 * X.onnx itself, whole and untouched, is then the weights (X.onnx_data).
 * Nothing in the cache is overwritten or copied: overwriting X.onnx while
 * its Blob was open failed on Windows ("Failed to execute 'put' on 'Cache':
 * Unexpected error"), and the copy took the model's size on disk again.
 * When it can't be split the model is opened whole, as before.
 */
function splitCached(store, url) {
  return once(`split ${url}`, async () => {
    try {
      if (await store.match(url + GRAPH)) return;
      const res = await store.match(url);
      if (!res) return;
      const blob = await res.blob();             // on disk: only the graph's own bytes are read
      const s = await split(blob, url.split("/").pop() + "_data");
      if (!s.moved.count) return;                // published split already, or nothing to move
      await store.put(url + GRAPH, new Response(s.graph, { headers: { "content-length": String(s.graph.length) } }));
      // an earlier Emkay's copy of the weights (whisper.js before this), no longer read
      await store.delete(url + "_data").catch(() => {});
      console.log(`[emkay] ${url.split("/resolve/")[0].split("/").slice(-2).join("/")}: ` +
        `${s.moved.count} weights moved out of ${url.split("/").pop()}`);
    } catch (e) {
      console.warn(`[emkay] ${url.split("/").pop()} not split, opened whole:`, e);
    }
  });
}

const hub = (url) => /^https?:\/\//.test(url);   // not the local path transformers.js tries first
const core = (url) => url.slice(0, -"_data".length);

/** The graph for X.onnx: the one split here, else X.onnx as it is. */
async function graphOf(store, url) {
  return (await store.match(url + GRAPH)) ?? store.match(url);
}

/** The weights for X.onnx_data: X.onnx itself when it was split here, else the file of that name. */
async function dataOf(store, url) {
  return (await store.match(core(url) + GRAPH)) ? store.match(core(url)) : store.match(url);
}

/** transformers.js' cache (match, put): .onnx files split, never downloaded here. */
function splitCache(store) {
  return {
    async match(key) {
      const url = String(key?.url ?? key);
      if (hub(url) && url.endsWith(".onnx")) {
        await splitCached(store, url);
        return graphOf(store, url);
      }
      if (hub(url) && url.endsWith(".onnx_data")) {
        await splitCached(store, core(url));
        return dataOf(store, url);
      }
      return store.match(key);
    },
    put: (key, response) => store.put(key, response),
  };
}

/** transformers.js' fetch: an .onnx file downloaded into the cache and split there. */
function splitFetch(store, net) {
  return async (url, init) => {
    url = String(url);
    const plain = (!init?.method || init.method === "GET") && !new Headers(init?.headers).has("range");
    if (!plain || !hub(url) || !/\.onnx(_data)?$/.test(url)) return net(url, init);
    try {
      if (url.endsWith(".onnx")) {
        if (!(await download(store, net, url))) return net(url, init);   // its own error
        await splitCached(store, url);
        return graphOf(store, url);
      }
      // X.onnx_data: X.onnx first (asked for at the same time), split or not
      if (await download(store, net, core(url))) await splitCached(store, core(url));
      if (await store.match(core(url) + GRAPH)) return dataOf(store, url);
      if (await download(store, net, url)) return store.match(url);
    } catch (e) {
      // the cache would not take it (full, or a browser's error): as before,
      // straight from the network, the model opened whole
      console.warn(`[emkay] ${url.split("/").pop()} not kept split:`, e);
      if (url.endsWith(".onnx")) return net(url, init);
    }
    // a model with nothing to move has no data: an empty file, unused
    return new Response(new Uint8Array(0), { status: 200, headers: { "content-length": "0" } });
  };
}

/**
 * Whether `model` is already in the browser (transformers.js' Cache API):
 * then it is read from the phone, not fetched, and the page says so.
 */
async function inCache(model) {
  try {
    const cache = await caches.open(lib ? (await lib).env.cacheKey : "transformers-cache");
    return (await cache.keys()).some((r) => r.url.includes(`/${model}/`));
  } catch {
    return false;
  }
}

/** The ASR pipeline for `model`, made once, when no other model is being opened. */
function pipe(model) {
  if (!pipes.has(model)) {
    const p = oneAtATime(async () => {
      const t = await transformers();
      const device = "gpu" in navigator && (await navigator.gpu.requestAdapter().catch(() => null))
        ? "webgpu" : "wasm";
      // Whisper: the encoder loses too much at 8 bit ("What? I'm a bit" for
      // "what time is it"); the decoder does not. A CTC model (wav2vec2, like
      // Røst for Danish) is one file, "model", used at 8 bit.
      const options = { device, dtype: { encoder_model: "fp32", decoder_model_merged: "q8", model: "q8" },
        session_options: LEAN, use_external_data_format: true };   // splitCache()
      if (device === "webgpu") options.dtype.decoder_model_merged = "q4";
      // the download, for the page's status line (app.js onModel): one
      // model is several files; transformers.js reports each one
      const files = new Map();
      const state = (await inCache(model)) ? "reading" : "loading";   // from the phone, or fetched
      // downloads (splitCache) and then reading them from the cache both
      // report: the line only moves forward
      let shown = 0;
      options.progress_callback = (p) => {
        if (p.status !== "progress" || !p.total) return;
        files.set(p.file, [p.loaded, p.total]);
        let loaded = 0, total = 0;
        for (const [l, t] of files.values()) { loaded += l; total += t; }
        shown = Math.max(shown, loaded / total);
        modelProgress("stt", model, shown, state);
      };
      onDownload = (url, l, total) =>
        options.progress_callback({ status: "progress", file: `download ${url}`, loaded: l, total });
      modelProgress("stt", model, 0, state);
      const asr = await t.pipeline("automatic-speech-recognition", model, options)
        .finally(() => { onDownload = null; });
      modelProgress("stt", model, 1, "ready");
      loaded.add(model);
      console.log(`[emkay] whisper ${model} ready on ${device}`);
      return asr;
    });
    p.catch((e) => {
      pipes.delete(model);
      modelProgress("stt", model, 0, "error");
      console.warn("[emkay] whisper", e);
    });
    pipes.set(model, p);
  }
  return pipes.get(model);
}

/**
 * True when `model` is loaded; otherwise starts loading it and answers
 * false at once, so OVOS uses its fallback STT meanwhile.
 */
export async function ready(model) {
  if (loaded.has(model)) return true;
  pipe(model);
  return false;
}

/** 16-bit mono PCM at `rate` -> Float32 at 16 kHz, as Whisper wants. */
function toFloat16k(pcm16, rate) {
  const src = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength >> 1);
  const out = new Float32Array(Math.floor(src.length * 16000 / rate));
  const step = rate / 16000;
  for (let i = 0; i < out.length; i++) {
    const x = i * step, j = Math.floor(x), f = x - j;
    const a = src[j] ?? 0, b = src[j + 1] ?? a;
    out[i] = (a + (b - a) * f) / 32768;
  }
  return out;
}

/**
 * Transcribe `pcm16` (Uint8Array of 16-bit mono samples at `rate` Hz) in
 * `lang` ("da-DK" or "da"); returns the text.
 */
export async function transcribe(pcm16, rate, lang, model) {
  // before anything awaits: the bytes may be a view into Pyodide's memory,
  // which can move or be reused while we wait for the model
  const audio = toFloat16k(pcm16.slice(), rate);
  const asr = await pipe(model);
  const t0 = performance.now();
  const language = String(lang || "en").split("-")[0].toLowerCase();
  // Whisper is told the language; an English-only Whisper (*.en) and a
  // one-language CTC model (wav2vec2) have none to choose
  const whisper = asr.model.config.model_type === "whisper";
  const options = whisper && !/\.en$/.test(model) ? { language, task: "transcribe" } : {};
  let text = "";
  try {
    const out = await asr(audio, options);
    text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? "";
  } catch (e) {
    // transformers.js throws "token_ids must be a non-empty array" when
    // Whisper hears nothing at all; that is an empty transcript, not an error
    if (!/non-empty array/.test(e.message)) throw e;
  }
  console.log(`[emkay] whisper ${((performance.now() - t0) / 1000).toFixed(1)}s for ` +
              `${(audio.length / 16000).toFixed(1)}s: ${JSON.stringify(text)}`);
  return text.trim();
}
