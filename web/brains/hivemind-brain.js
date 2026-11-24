// Emkay – the HiveMind brain (issue #11): Emkay as a satellite of an
// OpenVoiceOS in the house. The phone keeps the body – face, wake word,
// microphone, speaker – and the questions go to a hivemind-core over
// web/brains/hivemind.js. Nothing heavy loads: no Pyodide, no OVOS here.
//
// Like hivemind-voice-sat: wake word and speech recognition on the phone
// (whisper.js, or the browser's own recognition), only the text goes to
// the house; `speak` comes back and the phone makes the voice (piper.js).
//
// app.js talks to a brain through the worker's commands (call(cmd)); this
// brain answers the ones a satellite has – heard, say, record_begin,
// playback_* … – and quietly declines the rest (the control panel, the
// skill store and the network log belong to the local brain).
//
// Speech in the house (emkay-voice/emkay-home#13, #39): an Emkay Home on a
// strong machine can hear and speak for its Emkays (Whisper, Piper). Then
// the recording goes to the house's STT and the answer is spoken with its
// TTS; the wake word stays here. The house says where in the pairing link
// (`speech: {stt, tts}`) and at /api/house-info, asked at every start; the
// key is the HiveMind key. If the house doesn't answer, the phone does it
// itself, as before – Emkay never goes quiet because the house is busy.
// `houseSpeech: false` in the settings keeps speech on the phone.
//
// Settings live in localStorage ("emkay-hivemind"): host, port, ssl, key,
// password, lang, stt ("whisper" | "browser"), speech, houseSpeech – and
// after a Noise handshake (hivemind-core 5, #120) the keys that go with the
// house: psk, pskNode, noiseKey, serverKey, noise (hivemind.js). A pairing
// link may carry `psk`, so the device never derives it. They can be handed over once
// in the address, after "#hivemind=" as base64 JSON – a fragment never
// leaves the browser – e.g. from a QR code; Emkay saves them and drops the
// fragment from the address.

import { HiveMindClient } from "./hivemind.js";
import { t } from "../i18n.js";
import { setBrain } from "./saved.js";

const KEY = "emkay-hivemind";
const BROWSER_STT = "ovos-stt-plugin-browser";
const WHISPER_STT = "ovos-stt-plugin-whisper-browser";

/** As ovos-tts-plugin-piper-browser's VOICES and ovos-stt-plugin-whisper-browser's MODELS. */
const VOICES = {
  "en-us": "en_GB-alan-low", "en-gb": "en_GB-alan-low", "da-dk": "da_DK-talesyntese-medium",
  "de-de": "de_DE-thorsten-medium", "es-es": "es_ES-davefx-medium", "fr-fr": "fr_FR-siwis-medium",
  "it-it": "it_IT-paola-medium", "nl-nl": "nl_NL-pim-medium", "pt-pt": "pt_PT-tugão-medium",
  "pt-br": "pt_BR-faber-medium", "ca-es": "ca_ES-upc_ona-medium", "eu-es": "eu_ES-antton-medium",
};
export const voiceFor = (lang) => VOICES[lang.toLowerCase()]
  || Object.entries(VOICES).find(([k]) => k.split("-")[0] === lang.split("-")[0].toLowerCase())?.[1];
const STT_MODELS = { en: "onnx-community/whisper-base.en", da: "emkay-voice/roest-wav2vec2-315m-onnx" };
// as ovos-stt-plugin-whisper-browser's LIGHT_MODELS, for a device with little
// memory: under 8 GB as the browser reports it, or nothing reported (boot.py
// _small_device); Røst closed the page on a 4 GB tablet
const LIGHT_STT_MODELS = { da: "emkay-voice/alvenir-wav2vec2-base-da-onnx" };
const small = () => !(Number(self.navigator?.deviceMemory) >= 8);
export const sttModelFor = (lang) => {
  const base = lang.split("-")[0].toLowerCase();
  return (small() && LIGHT_STT_MODELS[base]) || STT_MODELS[base] || "onnx-community/whisper-base";
};

/**
 * The mouth: visemes from the text, spread evenly over the audio – as
 * py/emkay_mobile/speech.py text_visemes does for a TTS without phonemes.
 * [[code, end seconds], …], the form enclosure.mouth.viseme_list carries.
 */
const VISEME_OF = [[/[bpm]/, "4"], [/[fv]/, "5"], [/[ouw]/, "2"], [/[aei]/, "0"], [/[a-z]/, "3"]];
export function textVisemes(text, seconds) {
  const letters = [...String(text).toLowerCase()].filter((c) => /\p{L}/u.test(c) || " ,.!?".includes(c));
  if (!letters.length || seconds <= 0) return [];
  const step = seconds / letters.length, out = [];
  let t = 0;
  for (const c of letters) {
    t += step;
    const code = VISEME_OF.find(([re]) => re.test(c))?.[1] ?? "4";
    if (out.length && out.at(-1)[0] === code) out.at(-1)[1] = +t.toFixed(3);
    else out.push([code, +t.toFixed(3)]);
  }
  return out;
}

/** Seconds of a 16-bit PCM WAV (piper.js', or the house's, which may carry
 * more chunks before "data"). */
export function wavSeconds(wav) {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const byteRate = v.getUint32(28, true);
  let at = 12;
  while (at + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
    const size = v.getUint32(at + 4, true);
    if (id === "data") return byteRate ? Math.min(size, v.byteLength - at - 8) / byteRate : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}

/** Whether to use the house's speech, and where it is; null: the phone's. */
export function houseSpeechOf(s) {
  return s?.speech?.stt && s?.speech?.tts && s.houseSpeech !== false ? s.speech : null;
}

/** How long the house may take before the phone does it itself. */
const HOUSE_TIMEOUT = 20000;

/** Settings from the address (once) or localStorage; null when there are none. */
export function hivemindSettings() {
  const m = location.hash.match(/[#&]hivemind=([^&]+)/);
  if (m) {
    try {
      const s = JSON.parse(atob(decodeURIComponent(m[1])));
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) { console.warn("[emkay] #hivemind= could not be read", e); }
    history.replaceState(null, "", location.pathname + location.search);
  }
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}

export function saveHivemindSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

/** The Noise keys that belong to one house (hivemind.js' "keys" event). */
const HOUSE_KEYS = ["psk", "pskNode", "noiseKey", "serverKey", "noise"];

/** `s` without the keys of the house it was paired with: another house
 * (or the same one paired again) starts from nothing. */
export function withoutHouseKeys(s) {
  const out = { ...s };
  for (const k of HOUSE_KEYS) delete out[k];
  return out;
}

/**
 * Ask for the connection (host, port, wss, key, password) in a small form
 * over the boot screen; resolves with the settings when "Connect" is
 * pressed. `back`: a Back button, which resolves null. `local`: a "use
 * Emkay on this device instead" button, which switches to the local brain –
 * so a house that can't be reached never locks Emkay out.
 */
export function askHivemindSettings(prev = {}, error = "", { back = false, local = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById("hivemind-setup")?.parentElement.remove();
    // the same card as the menu and "Where should Emkay think?"
    const box = document.createElement("div");
    box.className = "menu setup";
    const form = document.createElement("form");
    form.id = "hivemind-setup";
    form.className = "menu-card setup-card";
    box.append(form);
    const field = (name, type, value, extra = "") =>
      `<label>${t(`hivemind.${name}`)}<input name="${name}" type="${type}" value="${value ?? ""}" ${extra}></label>`;
    form.innerHTML = `
      <h2 class="with-icon"><img src="menu/brain.svg" alt="">${t("hivemind.title")}</h2>
      <p>${t("hivemind.hint")}</p>
      ${error ? `<p class="error"></p>` : ""}
      ${field("host", "text", prev.host, 'required autocapitalize="off" spellcheck="false"')}
      ${field("port", "number", prev.port ?? 5678, 'required min="1" max="65535"')}
      <label class="check"><input name="ssl" type="checkbox" ${prev.ssl ?? location.protocol === "https:" ? "checked" : ""}> ${t("hivemind.ssl")}</label>
      ${field("key", "text", prev.key, 'required autocapitalize="off" spellcheck="false"')}
      ${field("password", "password", prev.password, "required")}
      <button type="submit">${t("hivemind.connect")}</button>
      ${back ? `<button type="button" class="secondary" data-act="back">${t("hivemind.back")}</button>` : ""}
      ${local ? `<button type="button" class="secondary" data-act="local">${t("hivemind.use_local")}</button>` : ""}`;
    if (error) form.querySelector(".error").textContent = error;   // text, not HTML
    form.querySelector('[data-act="back"]')?.addEventListener("click", () => { box.remove(); resolve(null); });
    form.querySelector('[data-act="local"]')?.addEventListener("click", () => {
      setBrain("local");
      location.replace(location.pathname);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(form);
      box.remove();
      const next = { host: f.get("host").trim(), port: +f.get("port"), ssl: f.has("ssl"),
                     key: f.get("key").trim(), password: f.get("password") };
      // another house, key or password: the old house's keys don't apply
      const same = ["host", "port", "key", "password"].every((k) => String(prev[k] ?? "") === String(next[k]))
        && !prev.forgetKeys;
      const s = { ...(same ? prev : withoutHouseKeys(prev)), ...next };
      delete s.forgetKeys;
      resolve(s);
    };
    document.body.append(box);
  });
}

/**
 * @param {object} [opts]
 * @param {(s: object, error: string) => Promise<object>} [opts.ask]  how to ask for settings
 * @returns {import("./brain.js").Brain}
 */
export function createHiveMindBrain({ ask = askHivemindSettings } = {}) {
  const handlers = new Map();
  const busListeners = new Set();
  const fire = (kind, data) => { for (const fn of handlers.get(kind) || []) fn(data); };
  /** A bus message to the page: the visage (core) and app.js' onBus (bus). */
  const local = (type, data = {}, context = {}) => {
    const raw = JSON.stringify({ type, data, context });
    for (const fn of busListeners) fn(raw);
    fire("bus", { payload: raw });
  };
  globalThis.emkayModelProgress = (what, name, progress, state = "loading") =>
    fire("model", { payload: { what, name, progress, state } });

  let client = null;
  let settings = null;
  let lang = "en-US";
  let nextIdent = 1;

  // --- speech in the house ---------------------------------------------------

  /** A request to the house, with the HiveMind key; throws when it can't answer in time. */
  async function house(url, opts = {}, ms = HOUSE_TIMEOUT) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, cache: "no-store", signal: ac.signal,
                                   headers: { ...(opts.headers || {}), Authorization: `Bearer ${settings.key}` } });
      if (!r.ok) throw new Error(`the house answered ${r.status}`);
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the house offers now – speech, its control panel (an Emkay Home;
   * any other HiveMind says nothing). */
  async function refreshHouse() {
    if (!settings.ssl) return;
    const port = settings.port && +settings.port !== 443 ? `:${settings.port}` : "";
    try {
      const r = await house(`https://${settings.host}${port}/api/house-info`, {}, 5000);
      const { speech = null, panel = null } = await r.json();
      if (JSON.stringify([speech, panel]) !== JSON.stringify([settings.speech || null, settings.panel || null])) {
        settings = { ...settings, speech, panel };
        saveHivemindSettings(settings);
      }
    } catch { /* not an Emkay Home, or it can't say: keep what we know */ }
  }

  /** The house hears: the recording (16-bit PCM) to its STT. */
  async function houseHear(sp, pcm, rate) {
    const q = new URLSearchParams({ lang: lang.toLowerCase(), sample_rate: rate, sample_width: 2 });
    const t0 = performance.now();
    const r = await house(`${sp.stt}?${q}`, { method: "POST", body: pcm,
                                             headers: { "Content-Type": "application/octet-stream" } });
    const text = (await r.text()).trim();
    console.log(`[emkay] the house heard in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(text)}`);
    return text;
  }

  /** The house speaks: a WAV from its TTS – with the same Piper voice as
   * the phone's (the house's Piper otherwise keeps the house's own voice and
   * only changes its accent). */
  /** The voice for `l`: the house's own, when it has chosen one for its
   * language (emkay-home: one voice for the whole house), else Emkay's. */
  const voiceOf = (sp, l) => (sp?.voice && sp.lang && sp.lang.split("-")[0] === l.split("-")[0].toLowerCase()
    ? sp.voice : null) || voiceFor(l) || voiceFor(lang);

  async function houseVoice(sp, text, l) {
    const voice = voiceOf(sp, l);
    const q = new URLSearchParams({ utterance: text, lang: l.toLowerCase(), ...(voice ? { voice } : {}) });
    const r = await house(`${sp.tts}/v2/synthesize?${q}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function connect() {
    settings = hivemindSettings();
    let error = "";
    for (;;) {
      if (!settings?.host || !settings?.key || !settings?.password) settings = await ask(settings || {}, error, { local: true });
      fire("status", { key: "hivemind.connecting", vars: { host: settings.host } });
      lang = settings.lang || navigator.language || "en-US";
      client = newClient();
      try {
        await client.connect();
        saveHivemindSettings(settings);
        break;
      } catch (e) {
        console.warn("[emkay] hivemind", e);
        // in the page's language where we know the error, else as it came
        error = e.code ? t(`hivemind.err.${e.code}`, { host: settings.host }) : (e.message || String(e));
        if (location.protocol === "https:" && !settings.ssl) error += ` – ${t("hivemind.needs_wss")}`;
        settings = { ...settings, password: "" };   // ask again, with what was typed
        // the house's key changed: whoever connects again pairs it again
        if (e.code === "server_key") settings.forgetKeys = true;
      }
    }
    client.addEventListener("message", (e) => fromHive(e.message));
    client.addEventListener("close", () => {
      fire("status", { key: "hivemind.lost", vars: { host: settings.host } });
      setTimeout(() => reconnect(), 3000);
    });
  }

  /** A client for the house; the keys a Noise handshake leaves are saved
   * with it, so the next connect skips argon2id and the hub knows us. */
  function newClient() {
    const c = new HiveMindClient({ ...settings, lang, siteId: settings.siteId || "emkay" });
    c.addEventListener("keys", (e) => {
      settings = { ...settings, ...e.keys };
      saveHivemindSettings(settings);
    });
    return c;
  }

  async function reconnect() {
    try {
      client = newClient();
      await client.connect();
      client.addEventListener("message", (e) => fromHive(e.message));
      client.addEventListener("close", () => setTimeout(() => reconnect(), 3000));
      fire("status", { key: "hivemind.connected", progress: 1, vars: { node: client.nodeName } });
      tellState();
    } catch {
      setTimeout(() => reconnect(), 10000);
    }
  }

  /** What the house says. */
  async function fromHive(msg) {
    if (asDevice(msg)) return;
    const raw = JSON.stringify(msg);
    for (const fn of busListeners) fn(raw);
    fire("bus", { payload: raw });
    // hivemind-core 5 / ovos-core say it as ovos.utterance.speak (OVOS-PIPELINE-1 §9.6)
    if ((msg.type === "speak" || msg.type === "ovos.utterance.speak") && msg.data?.utterance) {
      speak(msg.data.utterance, msg.data.lang || lang);
    }
  }

  // ------------------------------------------------- this Emkay as a device
  // The house (or Home Assistant through it, andlo/ha-ovos-integration#12)
  // asks for the volume and the microphone in OVOS' words; answered as an
  // OVOS would. Emkay Home lets these answers onto its bus.
  const level = { volume: 0.75, muted: false };
  let micMuted = false;
  try { Object.assign(level, JSON.parse(localStorage.getItem("emkay-hm-volume") || "{}")); } catch {}

  function toHouse(type, data) {
    client?.emit(type, data).catch(() => {});
  }

  /** Right after connecting: the house learns this Emkay is here, and how it is set. */
  function tellState() {
    fire("phal", { payload: JSON.stringify({ volume: level.volume, muted: level.muted }) });
    toHouse("mycroft.volume.get.response", { percent: level.volume, muted: level.muted });
    toHouse("mycroft.mic.get_status.response", { muted: micMuted });
  }

  function setLevel(next) {
    Object.assign(level, next);
    level.volume = Math.max(0, Math.min(1, level.volume));
    try { localStorage.setItem("emkay-hm-volume", JSON.stringify(level)); } catch {}
    fire("phal", { payload: JSON.stringify({ volume: level.volume, muted: level.muted }) });
    toHouse("mycroft.volume.get.response", { percent: level.volume, muted: level.muted });
  }

  /** Returns true when the message was for this Emkay as a device. */
  function asDevice(msg) {
    const d = msg.data || {};
    switch (msg.type) {
      case "mycroft.volume.get":
        toHouse("mycroft.volume.get.response", { percent: level.volume, muted: level.muted });
        return true;
      case "mycroft.volume.set":
        setLevel({ volume: Number(d.percent ?? level.volume) });
        return true;
      case "mycroft.volume.increase":
        setLevel({ volume: level.volume + Number(d.percent ?? 0.1) });
        return true;
      case "mycroft.volume.decrease":
        setLevel({ volume: level.volume + Number(d.percent ?? -0.1) });
        return true;
      case "mycroft.volume.mute":
      case "mycroft.volume.unmute":
        setLevel({ muted: msg.type.endsWith(".mute") });
        return true;
      case "mycroft.mic.get_status":
        toHouse("mycroft.mic.get_status.response", { muted: micMuted });
        return true;
      case "mycroft.mic.mute":
      case "mycroft.mic.unmute":
        micMuted = msg.type.endsWith(".mute");
        local(msg.type);                   // app.js' mic follows it
        toHouse("mycroft.mic.get_status.response", { muted: micMuted });
        return true;
    }
    return false;
  }

  /** The voice: the house's when it has one, else the phone's (piper.js); the page plays it. */
  async function speak(text, l) {
    const sp = houseSpeechOf(settings);
    let wav = null;
    if (sp) {
      try { wav = await houseVoice(sp, text, l); } catch (e) { console.warn("[emkay] the house's voice – the phone's instead", e); }
    }
    // the house's voice here too, when the house couldn't answer
    const voice = voiceOf(houseSpeechOf(settings), l);
    if (!wav && !voice) return console.warn(`[emkay] no Piper voice for ${l}`);
    try {
      if (!wav) wav = await (await import("../piper.js")).synth(text, voice);
      const visemes = textVisemes(text, wavSeconds(wav));
      fire("audio", { payload: { ident: `hm-${nextIdent++}`, utterance: text, visemes }, data: wav.buffer });
    } catch (e) {
      console.warn("[emkay] speak", e);
    }
  }

  /** A question for the house. */
  async function ask_(text) {
    await client.emit("recognizer_loop:utterance", { utterances: [text], lang });
    return true;
  }

  const commands = {
    async boot() {
      fire("status", { key: "boot.loading" });
      await connect();
      await refreshHouse();
      fire("status", { key: "hivemind.connected", progress: 1, vars: { node: client.nodeName } });
      tellState();
      const build = await fetch("build.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({}));
      const precise = build.precise_models || {};
      const heyMycroft = Object.keys(precise).find((u) => /hey_mycroft/.test(u));
      // Emkay's own "hey M K" where the site has it, as the local brain
      // (boot.py EMKAY_WAKE_WORD, defaults v13); "hey mycroft" otherwise;
      // settings.wakeWord picks another of the site's wake words
      const wakeWords = build.wake_words || [];
      const wakeWord = (settings.wakeWord && wakeWords.includes(settings.wakeWord) && settings.wakeWord)
        || (wakeWords.includes("hey_emkay") ? "hey_emkay" : "hey_mycroft");
      const hotword = wakeWord === "hey_mycroft" && heyMycroft
        ? { module: "ovos-ww-plugin-precise-onnx", model: heyMycroft }
        : { module: "ovos-ww-plugin-openwakeword", threshold: wakeWord === "hey_emkay" ? 0.8 : 0.5 };
      const sp = houseSpeechOf(settings);
      // with speech in the house the recording goes there, as Whisper's does here
      const stt = settings.stt === "browser" && !sp ? BROWSER_STT : WHISPER_STT;
      // the phone's own models are only fetched when the phone does speech
      // (with the house, they load the first time the house can't answer)
      if (stt === WHISPER_STT && !sp) import("../whisper.js").then((w) => w.ready(sttModelFor(lang))).catch(() => {});
      const voice = voiceFor(lang);
      if (voice && !sp) import("../piper.js").then((p) => p.ready(voice)).catch(() => {});
      return {
        brain: "hivemind", node: client.nodeName, lang, skills: [], stt_module: stt,
        wake_word: wakeWord, hotword,
        precise_models: precise, wake_words: wakeWords,
        site_langs: [lang], intent_langs: [lang], listener: {}, confirm_listening: false,
        speech: sp ? "house" : "phone",
        // for the privacy chip (privacy.js): the house thinks; it also hears
        // and speaks when it has speech, else this device does (the browser's
        // own recognition, when chosen, goes to the browser's maker)
        privacy: {
          think: { what: "house", host: settings.host },
          hear: sp ? { what: "house", host: settings.host } : { what: stt === BROWSER_STT ? "browser" : "device" },
          voice: sp ? { what: "house", host: settings.host } : { what: "device" },
        },
        // the house's own control panel (Emkay Home), for ⚙ → Control panel
        house_panel: settings.panel || null,
      };
    },
    async heard({ pcm, rate }) {
      const sp = houseSpeechOf(settings);
      let text = null;
      if (sp) {
        try { text = await houseHear(sp, pcm, rate); } catch (e) { console.warn("[emkay] the house didn't hear – the phone instead", e); }
      }
      if (text === null) {
        const whisper = await import("../whisper.js");
        text = await whisper.transcribe(new Uint8Array(pcm), rate, lang, sttModelFor(lang));
      }
      local("recognizer_loop:record_end");
      if (text) await ask_(text);
      return text;
    },
    heard_text: ({ text }) => { local("recognizer_loop:record_end"); return ask_(text); },
    say: ({ text }) => ask_(text),
    record_begin: () => local("recognizer_loop:record_begin"),
    wakeword: ({ name }) => local("recognizer_loop:wakeword", { hotword: name }),
    playback_started: ({ visemes }) => {
      local("recognizer_loop:audio_output_start");
      // the face's mouth, as the local OVOS does it (speech.py playback_started)
      if (visemes?.length) local("enclosure.mouth.viseme_list", { start: Date.now() / 1000, visemes });
    },
    playback_ended: () => local("recognizer_loop:audio_output_end"),
    // the visage's bus socket: what it says goes to the house
    core_open: () => null,
    core_send: ({ raw }) => { const m = JSON.parse(raw); return client?.emit(m.type, m.data, m.context); },
    gui_message: () => null,
    gui_sync: () => null,
    sound_bytes: () => null,
    res_file: () => null,
    phal_event: () => null,
    phal_position: () => null,
    sync: () => null,
    python: () => "",
    net_log: () => [],
    net_clear: () => null,
  };

  return {
    kind: "hivemind",
    can: { panel: false, store: false, install: false, netlog: false, gui: false },
    async call(cmd, args = {}) {
      const f = commands[cmd];
      if (!f) throw new Error(`"${cmd}" is not there with a HiveMind brain`);
      return f(args);
    },
    on(kind, fn) {
      if (!handlers.has(kind)) handlers.set(kind, new Set());
      handlers.get(kind).add(fn);
    },
    emit: (type, data = {}, context = {}) => client?.emit(type, data, context),
    onMessage(fn) { busListeners.add(fn); },
    offMessage(fn) { busListeners.delete(fn); },
    stop() { client?.close(); },
  };
}
