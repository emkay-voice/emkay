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

const BASE = new URL("./", import.meta.url).href;

/** A model download's progress, for the page (worker.js emkayModelProgress). */
const modelProgress = (what, name, progress, state = "loading") =>
  globalThis.emkayModelProgress?.(what, name, progress, state);

let lib = null;                    // the transformers.js module
const pipes = new Map();           // model -> Promise<pipeline>
const loaded = new Set();          // models whose pipeline is ready

async function transformers() {
  lib ??= import(BASE + "whisper/transformers.min.js").then((t) => {
    t.env.allowLocalModels = false;            // models come from the Hub
    t.env.useBrowserCache = true;              // ... once, then the Cache API
    const wasm = t.env.backends.onnx.wasm;
    wasm.wasmPaths = BASE + "whisper/";        // never a CDN
    wasm.numThreads = 1;                       // no cross-origin isolation here
    return t;
  });
  return lib;
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
        session_options: LEAN };
      if (device === "webgpu") options.dtype.decoder_model_merged = "q4";
      // the download, for the page's status line (app.js onModel): one
      // model is several files; transformers.js reports each one
      const files = new Map();
      const state = (await inCache(model)) ? "reading" : "loading";   // from the phone, or fetched
      options.progress_callback = (p) => {
        if (p.status !== "progress" || !p.total) return;
        files.set(p.file, [p.loaded, p.total]);
        let loaded = 0, total = 0;
        for (const [l, t] of files.values()) { loaded += l; total += t; }
        modelProgress("stt", model, loaded / total, state);
      };
      modelProgress("stt", model, 0, state);
      const asr = await t.pipeline("automatic-speech-recognition", model, options);
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
