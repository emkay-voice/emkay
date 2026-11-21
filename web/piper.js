// Emkay – Piper text-to-speech in the browser (issue #3).
//
// Piper (rhasspy) voices are VITS models in ONNX; a device runs them with
// onnxruntime and phonemizes the text with espeak-ng (piper-phonemize).
// Here both run in the Pyodide worker, as WebAssembly:
//   * piper-phonemize compiled to wasm (@diffusionstudio/piper-wasm, MIT;
//     it carries espeak-ng's data), served from piper/ on this site
//   * onnxruntime-web, which Emkay already ships for the wake word (ort/)
//   * the voice itself, from rhasspy's piper-voices on Hugging Face, only
//     when that voice is chosen, and kept in the Cache API afterwards
// The OVOS side is ovos-tts-plugin-piper-browser (its own package),
// which calls synth() through JSPI and gets a WAV back, as a device's
// ovos-tts-plugin-piper writes one.

import { LEAN, oneAtATime } from "./model-queue.js";

const BASE = new URL("./", import.meta.url).href;
const VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const CACHE = "emkay-piper-v1";

let ortReady = null;        // onnxruntime-web
let phonemizer = null;      // {create, wasm, data}
const sessions = new Map(); // voice -> Promise<{cfg, session}>
const loaded = new Set();    // voices whose session is ready

/** A model download's progress, for the page (worker.js emkayModelProgress). */
const modelProgress = (what, name, progress, state = "loading") =>
  globalThis.emkayModelProgress?.(what, name, progress, state);

/**
 * Bytes of `url`, from the Cache API when we have them. `onProgress(f)`, if
 * given, hears how much of a download has come (0..1); a cache hit is quiet.
 */
async function cached(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  let res = cache && (await cache.match(url));
  if (res) return new Uint8Array(await res.arrayBuffer());
  res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let bytes;
  if (onProgress && total && res.body) {
    bytes = new Uint8Array(total);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > bytes.length) {          // a wrong length: grow
        const more = new Uint8Array(got + value.length); more.set(bytes); bytes = more;
      }
      bytes.set(value, got);
      got += value.length;
      onProgress(Math.min(got / total, 1));
    }
    bytes = bytes.subarray(0, got);
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (cache) {
    await cache.put(url, new Response(bytes, { headers: res.headers })).catch(() => {});
  }
  return bytes;
}

function ort() {
  ortReady ??= import(BASE + "ort/ort.wasm.bundle.min.mjs").then((m) => {
    const o = m.default ?? m;
    o.env.wasm.numThreads = 1;              // no cross-origin isolation here
    o.env.wasm.wasmPaths = BASE + "ort/";
    return o;
  });
  return ortReady;
}

/** piper-phonemize: the Emscripten factory, its wasm and its espeak-ng data. */
async function loadPhonemizer() {
  if (!phonemizer) {
    phonemizer = (async () => {
      const [src, wasm, data] = await Promise.all([
        fetch(BASE + "piper/piper_phonemize.js").then((r) => r.text()),
        cached(BASE + "piper/piper_phonemize.wasm"),
        cached(BASE + "piper/piper_phonemize.data"),
      ]);
      // a classic script that defines createPiperPhonemize; this is a module worker
      const create = new Function(`${src}\nreturn createPiperPhonemize;`)();
      return { create, wasm, data };
    })();
  }
  return phonemizer;
}

/** Phoneme ids for each sentence of `text`, as piper-phonemize gives them. */
async function phonemeIds(text, espeakVoice) {
  const { create, wasm, data } = await loadPhonemizer();
  const lines = [];
  const mod = await create({
    noInitialRun: true,
    wasmBinary: wasm,
    // the espeak-ng data package, from our cache instead of a new download
    getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    locateFile: (name) => BASE + "piper/" + name,
    print: (line) => lines.push(line),
    printErr: (line) => console.warn("[piper] phonemize:", line),
  });
  mod.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]),
    "--espeak_data", "/espeak-ng-data"]);
  return lines.map((l) => JSON.parse(l).phoneme_ids).filter((ids) => ids?.length);
}

/** Where a voice lives in piper-voices: da_DK-talesyntese-medium -> da/da_DK/talesyntese/medium/... */
function voicePath(voice) {
  const parts = voice.split("-");
  const code = parts[0], quality = parts.at(-1), speaker = parts.slice(1, -1).join("-");
  return `${code.split("_")[0]}/${code}/${encodeURIComponent(speaker)}/${quality}/${encodeURIComponent(voice)}`;
}

/** The voice's ONNX session, made once, when no other model is being opened. */
function session(voice) {
  if (!sessions.has(voice)) {
    const p = oneAtATime(async () => {
      const o = await ort();
      const url = VOICES + voicePath(voice) + ".onnx";
      const [cfgBytes, model] = await Promise.all([
        cached(url + ".json"), cached(url, (f) => modelProgress("tts", voice, f))]);
      const cfg = JSON.parse(new TextDecoder().decode(cfgBytes));
      const s = await o.InferenceSession.create(model, { executionProviders: ["wasm"], ...LEAN });
      await loadPhonemizer();
      loaded.add(voice);
      modelProgress("tts", voice, 1, "ready");
      return { cfg, session: s };
    });
    p.catch(() => {                          // a failed download is tried again next time
      sessions.delete(voice);
      modelProgress("tts", voice, 0, "error");
    });
    sessions.set(voice, p);
  }
  return sessions.get(voice);
}

/**
 * Whether `voice` can speak right away. If not, its download starts (once)
 * and false is returned: the first download is tens of megabytes, and OVOS
 * should not stay silent meanwhile (the plugin then lets the fallback
 * TTS speak).
 */
export function ready(voice) {
  if (loaded.has(voice)) return true;
  session(voice).catch((e) => console.warn(`[piper] ${voice} could not be loaded:`, e));
  return false;
}

/** 16-bit mono WAV of float samples. */
function wav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true);
  out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, samples.length * 2, true);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 1 ? 1 / peak : 1;   // as piper: no clipping
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.round(s * gain * 32767), true));
  return new Uint8Array(out.buffer);
}

/**
 * Speak `text` with `voice` (a piper-voices name, e.g. "en_GB-alan-low").
 * Returns a WAV as a Uint8Array. The first call for a voice downloads it.
 */
export async function synth(text, voice, speaker = 0) {
  const t = performance.now();
  const [{ cfg, session: s }, o] = await Promise.all([session(voice), ort()]);
  const rate = cfg.audio.sample_rate;
  const { noise_scale, length_scale, noise_w } = cfg.inference;
  const pcm = [];
  const pause = new Float32Array(Math.round(rate * 0.2));   // between sentences
  for (const ids of await phonemeIds(text, cfg.espeak.voice)) {
    const feeds = {
      input: new o.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new o.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new o.Tensor("float32", Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
    };
    if (cfg.num_speakers > 1) feeds.sid = new o.Tensor("int64", BigInt64Array.from([BigInt(speaker)]), [1]);
    const { output } = await s.run(feeds);
    if (pcm.length) pcm.push(pause);
    pcm.push(output.data);
  }
  const all = new Float32Array(pcm.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of pcm) { all.set(p, off); off += p.length; }
  console.log(`[piper] ${voice}: ${(all.length / rate).toFixed(1)} s of speech in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  return wav(all, rate);
}
