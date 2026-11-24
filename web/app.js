// Emkay – the page side: screen, microphone and speaker.
//
// OVOS itself runs in worker.js, behind the brain (brains/brain.js, #28),
// so another OVOS can later stand in for it. ovos-gui-visage (Mike's Flutter GUI) draws
// the screen, in a frame (visage2/); its websockets are web/visage2-shim.js,
// which talks to OVOS through window.emkayVisage2 below.
//
// URL options: ?kiosk  full screen + portrait lock on start (the installed
// app opens with it, see manifest.webmanifest).

import { t, apply, setLang, onLangChange, matchLang } from "./i18n.js";
import { onRequest as deviceRequest, startDevice } from "./device.js";
import { createMediaPlayer } from "./media.js";
import { createLocalMedia } from "./localmedia.js";
import { createBrain, chosenBrain } from "./brains/brain.js";
import { haLinkWanted, startHaDevice } from "./ha-device.js";
import { chooseBrain, brainHint } from "./brains/choose.js";
import { createActivity } from "./activity.js";
import { createPrivacy } from "./privacy.js";
import { capture, screen } from "./screenlog.js";

// the page's warnings and errors, and its workers' (brain.on("log")), kept
// for a log on the screen: ?log shows it (a tablet has no console at hand)
capture(screen.add, "page");

const $ = (id) => document.getElementById(id);
apply();                    // the phone's language until OVOS is up
$("boot-text").textContent = t("boot.loading");   // bootStatus' own line from here on
onLangChange(() => { apply(); bootStatus(lastStatus.key, undefined, lastStatus.vars); });
/** The privacy chip by ⚙ (privacy.js); a tap opens ⚙ at its three lines, on top. */
const privacy = createPrivacy({ t, $, openSettings: () => {
  $("menu").hidden = false;
  $("privacy").classList.remove("flash");
  void $("privacy").offsetWidth;           // restart the animation
  $("privacy").classList.add("flash");
} });
onLangChange(() => privacy.render());
const params = new URLSearchParams(location.search);
let kiosk = params.has("kiosk");

/** A phone or a small tablet: it is the device, so it goes full screen on start. */
const phoneScreen = matchMedia("(max-width: 700px), (pointer: coarse) and (max-width: 1100px)");

// ------------------------------------------- one Emkay per browser
// The store's "Get" opens app.emkay.ai/?install=<package> in a new tab. If
// Emkay already runs in another tab of this browser, that one should get
// the skill: a second OVOS would boot on the same saved data. So a new tab
// with ?install first asks on a BroadcastChannel (this origin's tabs only)
// whether an Emkay is running; if one answers, the package goes to it, this
// tab says so and stops here, before its own OVOS starts.
const STORE_ORIGIN = "https://store.emkay.ai";
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// ?install=github:owner/repo[@ref]: a skill straight from GitHub (below, #49)
const GITHUB_SPEC = /^github:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:@([A-Za-z0-9._\/-]{1,200}))?$/;
const installable = (p) => PACKAGE_NAME.test(p) || GITHUB_SPEC.test(p);
/** {owner, repo, ref} from github:owner/repo[@ref] or a github.com link, else null. */
function ghSpec(text) {
  const s = String(text || "").trim();
  const m = s.match(GITHUB_SPEC) ||
    s.replace(/^git\+/, "").match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/tree\/([A-Za-z0-9._\/-]{1,200}))?(?:@([A-Za-z0-9._\/-]{1,200}))?\/?$/);
  if (!m) return null;
  const [, owner, repo, a, b] = m;
  return { owner, repo, ref: a || b || "" };
}
/** The pip requirement for it, as ovos-core's installer gets it. */
const ghPip = ({ owner, repo, ref }) => `git+https://github.com/${owner}/${repo}${ref ? `@${ref}` : ""}`;
let pendingInstall = null;   // a package handed over before OVOS was up
if (params.get("install")) {
  const probe = new BroadcastChannel("emkay-tabs");
  const answered = await new Promise((resolve) => {
    probe.onmessage = ({ data }) => { if (data?.pong) resolve(true); };
    probe.postMessage({ ping: true });
    setTimeout(() => resolve(false), 800);
  });
  if (answered) {
    probe.postMessage({ install: params.get("install") });
    probe.close();
    $("boot-text").textContent = t("install.handed", { pkg: params.get("install") });
    $("boot-bar").parentElement.hidden = true;
    await new Promise(() => {});   // this tab stays a note; Emkay runs in the other one
  }
  probe.close();
}
// from here on this tab is the running Emkay: it answers the next tab's ping
// (the channel is made after the probe, so a tab never answers itself)
const tabs = new BroadcastChannel("emkay-tabs");
tabs.onmessage = ({ data }) => {
  if (data?.ping) tabs.postMessage({ pong: true });
  if (data?.install && installable(data.install)) receiveInstall(data.install);
};

// ----------------------------------------------------------------- brain
// Where Emkay thinks (brains/brain.js, #28). Only the local brain (OVOS in
// worker.js) exists so far; its worker starts loading right away, as before.
// Emkay Dev (?dev, web/dev.js): always the OVOS in this browser – the skill
// you are writing runs in it
const devMode = params.has("dev");
const brain = createBrain(devMode ? "local" : chosenBrain(params));
const call = brain.call;   // worker.js commands (local brain)
brain.on("log", (d) => screen.add(d.line));
if (params.has("log")) screen.show();
// … or from the menu, also after the fact: the lines are kept from the start
$("menu-log").onclick = () => { $("menu").hidden = true; if (!screen.el) screen.show(); };

const guiSockets = new Set();
brain.on("status", (d) => bootStatus(d.key, d.progress, d.vars));
brain.on("gui", (d) => { for (const s of guiSockets) s.deliver(d.payload); });
brain.onMessage((raw) => { for (const f of coreListeners) f(raw); });
brain.on("audio", (d) => d.payload.sound ? speaker.playSound(d.data) : speaker.enqueue(d.data, d.payload));
brain.on("phal", (d) => onPhal(JSON.parse(d.payload)));
brain.on("model", (d) => modelStatus.show(d.payload));   // whisper.js / piper.js downloads
brain.on("bus", (d) => onBus(JSON.parse(d.payload), d.data));
// the menu shows what this brain has: the control panel, the skill store and
// the network log belong to the OVOS in this browser
$("menu-panel").hidden = !brain.can.panel;
$("menu-store").hidden = !brain.can.store;
$("menu-network").hidden = !brain.can.netlog;
$("storage-state").hidden = !brain.can.panel;   // "take a backup (Settings → Backup)" is the panel's
// full screen is the kiosk page of Emkay's own panel (and "go full screen"
// by voice); a satellite's panel is the house's, which can't reach this
// screen, so it keeps the entry in the menu
$("menu-kiosk").hidden = brain.can.panel;
// "Where should Emkay think?" – on top of the menu, in every brain
const showBrainHint = () => { $("menu-brain-hint").textContent = brainHint(brain.kind); };
showBrainHint();
onLangChange(showBrainHint);
$("menu-brain").onclick = () => { $("menu").hidden = true; chooseBrain(brain.kind, () => { $("menu").hidden = false; }); };

let ovosReady;
const ready = new Promise((r) => (ovosReady = r));

if (devMode) {
  import("./dev.js").then(({ startDev }) => startDev({
    call, ready,
    onMessage: (fn) => brain.onMessage(fn), on: (k, fn) => brain.on(k, fn),
  }));
}

// ---------------------------------------------------------------- the screen
/**
 * ovos-gui-visage, the Flutter GUI (issue #22), runs in a frame
 * (visage2/index.html). Its websockets are web/visage2-shim.js in that
 * frame, which talks to OVOS through this: `core` gets every bus message
 * (worker_main.core_open), `gui` ovos-gui's GUI stream (gui.py).
 */
const coreListeners = new Set();
const guiListeners = new Map();   // listener -> its guiSockets entry
window.emkayVisage2 = {
  ready,
  call,
  /** A tap on the visage (visage2-shim.js): listen; the whole screen is the talk button. */
  tap: () => mic.listen(),
  subscribe(route, fn) {
    if (route === "core") return void coreListeners.add(fn);
    const entry = { deliver: fn };
    guiListeners.set(fn, entry);
    guiSockets.add(entry);
  },
  unsubscribe(route, fn) {
    coreListeners.delete(fn);
    guiSockets.delete(guiListeners.get(fn));
    guiListeners.delete(fn);
  },
};

/**
 * Put the visage's frame on the page, under Emkay's own layer (boot, menu,
 * mic). It fills the window on any screen: Flutter lays out for the size.
 * `?lang=` is OVOS' language, so the clock and dates the visage draws itself
 * speak it too (ovos-gui-visage date_locale.dart); a new language restarts
 * Emkay (languageChanged), and with it the frame.
 */
function showVisage() {
  const frame = document.createElement("iframe");
  frame.id = "visage2";
  frame.className = "visage2";
  frame.src = `visage2/index.html?lang=${encodeURIComponent(ovosLang)}`;
  frame.title = "OVOS Visage";
  frame.allow = "autoplay";
  document.body.prepend(frame);
}

// ------------------------------------------------------------------ boot
let lastStatus = { key: "boot.loading" };

/** Show boot progress on the start screen; `key` is a text in i18n.js. */
function bootStatus(key, progress, vars) {
  lastStatus = { key, vars };
  $("boot-text").textContent = t(key, vars);
  bootBar.step(key, progress, vars);
}

/**
 * The start screen's bar shows the whole start, not one step at a time.
 *
 * Each step of the local brain's boot (worker.js, boot.py) has its own
 * stretch of the bar, as long as that step took the last time Emkay started
 * on this device (kept in localStorage; BOOT_GUESS the first time), so the
 * bar moves at an even pace and never goes back. A step that reports how far
 * it is (a download, skills loaded) fills its stretch by that; one that
 * can't (Python starting, the intent service) creeps towards its end at the
 * pace it took last time, slowing down near the end instead of stopping.
 * Other brains' steps (HiveMind, Home Assistant) set the bar as they say.
 */
const BOOT_STEPS = ["boot.loading", "boot.python", "boot.packages", "boot.ovos", "boot.intents",
  "boot.m2v", "boot.unpack", "boot.start", "boot.settings", "boot.findskills", "boot.engines",
  "boot.loadskills", "boot.services"];
/** First start on this device: about how long each step takes, in ms. */
const BOOT_GUESS = {
  "boot.loading": 800, "boot.python": 3000, "boot.packages": 6000, "boot.ovos": 4000,
  "boot.intents": 1500, "boot.m2v": 2000, "boot.unpack": 2500, "boot.start": 3000,
  "boot.settings": 5000, "boot.findskills": 7000, "boot.engines": 10000,
  "boot.loadskills": 18000, "boot.services": 3000,
};
const BOOT_TIMES = "emkay.bootTimes";   // localStorage: {step: ms} from the last start
const bootBar = (() => {
  let learned = {};
  try { learned = JSON.parse(localStorage.getItem(BOOT_TIMES)) || {}; } catch {}
  // ms per step as expected this time; a step that took no time last time
  // (its download was on the phone already) still gets a sliver
  const expect = Object.fromEntries(BOOT_STEPS.map((s) =>
    [s, Math.max(learned[s] ?? BOOT_GUESS[s], 150)]));
  const total = BOOT_STEPS.reduce((sum, s) => sum + expect[s], 0);
  const startOf = {};
  BOOT_STEPS.reduce((at, s) => { startOf[s] = at; return at + expect[s]; }, 0);
  // ms each step took this time; a step that did not come (its download was
  // on the phone already) took 0, so next time it gets only a sliver
  const took = Object.fromEntries(BOOT_STEPS.map((s) => [s, 0]));
  let current = "boot.loading", since = performance.now(), reported, next, shown = 0;
  let timer = null, done = false;

  const draw = (fraction) => {
    shown = Math.max(shown, Math.min(fraction, 1));   // never back
    $("boot-bar").style.width = `${(shown * 100).toFixed(1)}%`;
  };
  /** How far into the current step, 0..1: reported, else by the clock. */
  const within = () => {
    const x = (performance.now() - since) / expect[current];
    const creep = x < 0.9 ? x : 0.9 + 0.09 * (1 - Math.exp(-(x - 0.9) * 3));
    if (reported === undefined) return creep;
    // between two reports (one skill loading), creep towards the next one
    return Math.max(reported, Math.min(creep, next ?? reported));
  };
  const tick = () => draw((startOf[current] + expect[current] * within()) / total);
  const finish = () => {
    done = true;
    clearInterval(timer);
    draw(1);
    took[current] = (took[current] || 0) + performance.now() - since;
    try { localStorage.setItem(BOOT_TIMES, JSON.stringify(took)); } catch {}
  };
  timer = setInterval(tick, 100);

  return {
    step(key, progress, vars) {
      if (done) return;
      if (key === "boot.ready" || key === "boot.skills") return finish();
      if (!BOOT_STEPS.includes(key)) {   // another brain, or an error
        clearInterval(timer);
        if (progress !== undefined) draw(progress);
        return;
      }
      if (key !== current) {
        took[current] = (took[current] || 0) + performance.now() - since;
        since = performance.now();
        current = key;
        reported = next = undefined;
      }
      if (progress !== undefined) {
        reported = progress;
        next = vars?.n ? Math.min((vars.i + 1) / vars.n, 1) : undefined;
      }
      tick();
    },
  };
})();

let audioCtx = null;

/**
 * The first tap. Browsers only allow sound, the microphone and full screen
 * after the user did something, so all of it is switched on here.
 */
async function start() {
  $("start").hidden = true;
  $("first").hidden = true;
  // iOS: Web Audio follows the ringer switch unless the page says what its
  // sound is (Safari 17+ audioSession). Emkay plays speech and keeps the
  // microphone open for the wake word: "play-and-record", which iOS does
  // not silence.
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch {}
  audioCtx = new AudioContext();
  speaker.attach(audioCtx);
  await audioCtx.resume();
  // iOS suspends ("interrupted") the context after a call, Siri, the lock
  // screen or another app's sound, and does not resume it by itself
  audioCtx.onstatechange = () => {
    if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioCtx.state !== "running") audioCtx.resume().catch(() => {});
  });
  // a phone is the device itself: full screen from the first tap (browsers
  // allow it only after one; the installed app opens full screen anyway)
  if (kiosk || phoneScreen.matches) enterKiosk();
  keepAwake();
  wake.start(bootInfo?.wake_word).catch((e) => { wake.state = `error: ${e.message || e}`; });
  warmingWatch();
  if (bootInfo?.confirm_listening && bootInfo.start_listening_sound) {
    call("sound_bytes", { uri: bootInfo.start_listening_sound })
      .then((bytes) => audioCtx.decodeAudioData(bytes.buffer))
      .then((buf) => { mic.startSound = buf; })
      .catch((e) => console.warn("[emkay] start listening sound", e));
  }
  $("boot").hidden = true;
  for (const id of ["mic", "keyboard", "menu-button"]) $(id).hidden = false;
  started = true;
  // installing as an app is offered once, a little after the face is up
  setTimeout(offerInstall, 20000);
  // a browser that can't run Emkay's own ears and voice (no JSPI) is told so
  // now, not the first time someone speaks to an Emkay that can't hear
  for (const what of bootInfo?.speech_blocked || []) speechWait.show({ what, reason: "browser" });
  installFromStore();
  if (pendingInstall) { installFromStore(pendingInstall); pendingInstall = null; }
}

const WELCOMED = "emkay-welcomed";

/**
 * The first time Emkay starts in this browser: start on the defaults (the
 * big button: Emkay always works without setup), or set up. Setting up
 * asks first where Emkay should think; on this device it goes on to the
 * control panel's own guide (/setup), with the steps Emkay chose for it
 * (boot.py, DISTRIBUTION); the house or Home Assistant start Emkay again
 * there. Either choice is remembered; the guide stays in the control panel.
 */
function offerSetup() {
  let first = false;
  try { first = !localStorage.getItem(WELCOMED); } catch {}
  if (devMode) first = false;   // a dev Emkay starts on the defaults, every time
  const remember = () => { try { localStorage.setItem(WELCOMED, "1"); } catch {} };
  $("start").onclick = () => { remember(); start(); };
  if (!first || brain.kind !== "local") return;   // elsewhere the brain was chosen already
  $("start").dataset.i18n = "start.defaults";
  apply();
  $("first").hidden = false;
  $("first-setup").hidden = false;
  $("first-setup").onclick = () => {
    remember();
    // "here on this device" (or closing) goes on to the guide
    chooseBrain(brain.kind, async () => {
      await start();
      if (brain.can.panel) openPanel("setup");
    });
  };
}

/** Full screen and portrait, like a device on the shelf. */
function enterKiosk() {
  document.documentElement.requestFullscreen?.().catch(() => {});
  screen.orientation?.lock?.("portrait").catch(() => {});
}

/** Keep the screen on while the page is visible (Screen Wake Lock API);
 * on by default, "let the screen sleep" (ovos-skill-kiosk) turns it off. */
let wakeLockOn = true;
let wakeSentinel = null;
async function keepAwake() {
  const take = async () => {
    if (!wakeLockOn || document.visibilityState !== "visible") return;
    try { wakeSentinel = await navigator.wakeLock?.request("screen"); } catch {}
  };
  if (!keepAwake.watching) {
    keepAwake.watching = true;
    document.addEventListener("visibilitychange", take);
  }
  await take();
}
function letSleep() {
  wakeLockOn = false;
  wakeSentinel?.release?.().catch(() => {});
  wakeSentinel = null;
}

/**
 * Ask the browser to keep this site's storage (settings, downloads) even
 * when the phone runs low on space. Browsers grant it to installed apps
 * and to sites used often; the answer is shown in the menu.
 */
async function keepStorage() {
  try {
    const kept = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.());
    $("storage-state").dataset.i18n = kept ? "storage.kept" : "storage.loose";
    apply();
  } catch {
    $("storage-state").textContent = "";
  }
}

/** The house's control panel, when this Emkay is a satellite of an Emkay Home
 * served from the house (shown in the same place as the local panel). */
let housePanel = null;

// ------------------------------------------- a start that closed the page
/**
 * A browser closes a tab that takes more memory than it allows; on a small
 * device that happened while the ears (the STT model) opened, and the page
 * started over and closed again. A mark is left in localStorage from the
 * start until the ears are ready, and taken away when the page is left
 * (reload, another page, closed); one still there at the next start means
 * the last start ended with the page closed by the browser. boot.py then
 * uses the light STT model, and the page says so (info.light_after_crash).
 */
const opening = {
  KEY: "emkay.opening",
  /** Whether the last start ended without the page being left. */
  crashed: (() => { try { return !!localStorage.getItem("emkay.opening"); } catch { return false; } })(),
  start() {
    try { localStorage.setItem(this.KEY, String(Date.now())); } catch {}
    addEventListener("pagehide", () => this.done());
  },
  done() { try { localStorage.removeItem(this.KEY); } catch {} },
};
opening.start();

(async () => {
  try {
    keepStorage();
    const info = await call("boot", { userConfig: null, crashed: opening.crashed });
    // no ears on the device to wait for (a server, another brain): nothing can close the page there
    if (!/whisper-browser/.test(info.stt_module || "")) opening.done();
    console.log("[emkay] OVOS up", info);
    setLang(info.lang);   // from here on Emkay's texts follow OVOS' language
    if (info.light_after_crash) caption(t("light.after_crash"), null, 9000);
    bootInfo = info;
    ovosLang = info.lang || ovosLang;
    sttModule = info.stt_module;
    privacy.boot(info);
    privacy.room(info.room_listeners || []);
    if (brain.kind === "local") localMedia.start().catch((e) => console.warn("[emkay] local media", e));
    ovosReady();
    showVisage();
    if (brain.kind === "local") bootStatus("boot.skills", 1, { n: info.skills.length });
    // a satellite of an Emkay Home: ⚙ → Control panel is the house's control panel,
    // shown the same way as the local OVOS' own – over the face, with × –
    // when Emkay comes from the house itself (the house lets only its own
    // Emkay frame it); from elsewhere (app.emkay.ai) in a window of its own
    if (!brain.can.panel && info.house_panel) {
      $("menu-panel").hidden = false;
      housePanel = new URL(info.house_panel).hostname === location.hostname ? info.house_panel : null;
      if (!housePanel) $("menu-panel").onclick = () => { $("menu").hidden = true; window.open(info.house_panel, "_blank", "noopener"); };
    }
    offerSetup();
    startDevice(call);   // the phone's sensors and connectivity, for PHAL
    // Emkay with its own OVOS, connected to Home Assistant (ha-device.js)
    if (brain.kind === "local" && haLinkWanted()) {
      startHaDevice(brain, { lang: info.lang, version: info.version,
                             onStatus: (key, vars) => console.log(`[emkay] ${t(key, vars)}`) });
    }
    $("start").hidden = false;
  } catch (e) {
    bootStatus("boot.error", undefined, { msg: e.message });
    console.error(e);
  }
})();

// ------------------------------------------------------------ microphone
/**
 * Tap-to-talk. The whole screen is the button, like tapping a Mark II.
 * A simple energy VAD ends the recording; the STT plugin runs in the worker.
 */
const mic = {
  busy: false,
  muted: false,   // the listener was muted (mycroft.mic.mute), e.g. from the panel
  /** Follow the listener's mute state; a muted mic shows as such. */
  setMuted(muted) {
    this.muted = muted;
    $("mic").classList.toggle("muted", muted);
  },
  async listen() {
    if (this.busy || this.muted || !audioCtx) return;
    this.busy = true;
    questionsAsked++;
    privacy.active("hear", true);
    $("mic").className = "mic listening";
    caption(t("mic.listening"), 0);
    // OVOS' confirm-listening sound, before the recording (so it is not in it)
    if (bootInfo?.confirm_listening && this.startSound) await speaker.playSound(this.startSound);
    call("record_begin");
    try {
      if (sttModule === BROWSER_STT && SpeechRecognitionAPI) {
        // the browser's recognition wants the microphone to itself: an open
        // stream of ours makes it fail ("audio-capture") on some devices
        releaseMic();
        const text = await browserSTT();
        wake.attach().catch(() => {});
        $("mic").className = "mic thinking";
        if (!text) caption(t("mic.nothing"), null, 4000);
        else {
          caption(`“${text}”`, null, 6000);
          const before = speaker.spoken, handled = utterancesHandled;
          if (await call("heard_text", { text })) unanswered(before, handled);
        }
        return;
      }
      const l = bootInfo?.listener || {};
      const pcm = await record({
        level: (v) => caption(t("mic.listening"), v),
        silenceMs: (l.silence_end ?? 0.7) * 1000,
        maxSeconds: l.recording_timeout ?? 10,
        noSpeechMs: (l.recording_timeout_with_silence ?? 3) * 1000,
      });
      $("mic").className = "mic thinking";
      if (!pcm) {
        caption(t("mic.nothing"), null, 4000);
      } else {
        caption(t("mic.thinking"));
        const before = speaker.spoken, handled = utterancesHandled;
        const text = await call("heard", { pcm: pcm.buffer, rate: 16000 }, [pcm.buffer]);
        // nothing heard because the device's ears aren't there yet (speechWait): say that
        caption(text ? `“${text}”` : t(speechWait.has("stt") ? "wait.stt.short" : "mic.unclear"),
          null, text ? 6000 : 4000);
        if (text) unanswered(before, handled);
      }
    } catch (e) {
      console.warn("[emkay] mic", e);
      caption(t("mic.error", { msg: e.message || String(e) }), null, 6000);
    } finally {
      $("mic").className = this.muted ? "mic muted" : "mic";
      privacy.active("hear", false);
      this.busy = false;
    }
  },
};

/**
 * The listener's recording mode (recognizer_loop:state.set "recording", as in
 * ovos-dinkum-listener): a skill wants the microphone's sound itself, not
 * words - ovos-skill-jamband, a hummed melody. Recorded like an utterance,
 * but longer, with longer pauses allowed, and never through the browser's
 * speech recognition; the worker writes it to the listener's recordings
 * folder and says recognizer_loop:record_end. recognizer_loop:record_stop
 * ends it early.
 */
const recording = {
  stop: false,
  async start(name) {
    if (mic.busy || mic.muted || !audioCtx) {
      call("recorded", { pcm: new ArrayBuffer(0), rate: 16000, name });   // nothing, but the skill hears it ended
      return;
    }
    mic.busy = true;
    this.stop = false;
    privacy.active("hear", true);
    $("mic").className = "mic listening";
    caption("♪ " + t("mic.listening"), 0);
    call("record_begin");
    let pcm = null;
    try {
      pcm = await record({ level: (v) => caption("♪ " + t("mic.listening"), v), silenceMs: 1600,
                           maxSeconds: 15, noSpeechMs: 6000, stop: () => this.stop });
    } catch (e) {
      console.warn("[emkay] recording", e);
    } finally {
      $("mic").className = mic.muted ? "mic muted" : "mic";
      $("caption").hidden = true;
      privacy.active("hear", false);
      mic.busy = false;
    }
    const buf = pcm ? pcm.buffer : new ArrayBuffer(0);
    await call("recorded", { pcm: buf, rate: 16000, name }, [buf]);
  },
};

let stream = null;
let captionTimer = null;
let questionsAsked = 0;   // typed or spoken; ends the warm-up note
let utterancesHandled = 0;   // ovos.utterance.handled seen (unanswered() waits for one)

/**
 * A question was handled and nothing was said: a skill or fallback that
 * failed quietly, often because its service cannot be reached from a
 * browser (issue #6). Instead of silence: OVOS' error sound (sounds.error,
 * as the listener plays it) and a line under the face. `before` is
 * speaker.spoken when the question went in. The question is done when
 * OVOS says so (ovos.utterance.handled; the worker may hand the question
 * over and return before that, JSPI #20), and speech may follow by a moment,
 * so it waits for both.
 */
async function unanswered(before, handledBefore = utterancesHandled - 1) {
  for (let i = 0; i < 1200 && utterancesHandled <= handledBefore; i++) {
    await new Promise((r) => setTimeout(r, 100));   // at most 2 minutes
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (speaker.spoken !== before || speaker.playing) return;
  // answered, but as text: the voice isn't on the device yet (speechWait)
  if (speechWait.shownAt && Date.now() - speechWait.shownAt < 30000) return;
  caption(t("noanswer"), null, 6000);
  if (!mic.errorSound && bootInfo?.error_sound) {
    try {
      mic.errorSound = await audioCtx.decodeAudioData((await call("sound_bytes", { uri: bootInfo.error_sound })).buffer);
    } catch { mic.errorSound = null; }
  }
  if (mic.errorSound) speaker.playSound(mic.errorSound);
}

/**
 * Right after start OVOS still prepares its intent matching in the
 * background (padatious' padaos compiles its regexes: half a minute or more
 * in WebAssembly). A question asked meanwhile is answered when that is
 * done; until then the caption says "Warming up…", so silence is not
 * mistaken for not listening. The worker is pinged for the first minutes;
 * a slow answer means it is still busy.
 */
async function warmingWatch(seconds = 150) {
  const end = performance.now() + seconds * 1000;
  const asked = () => speaker.spoken > 0 || mic.busy || questionsAsked > 0;
  let shown = false, wasSlow = false;
  // hide the warm-up line only if it is still the one shown (an answer shown
  // as text meanwhile – speechWait – must not be written over)
  const hideWarming = () => { if ($("caption-text").textContent === t("warming")) $("caption").hidden = true; };
  while (performance.now() < end && !asked()) {
    const slow = setTimeout(() => {
      wasSlow = true;
      if (!asked() && $("caption").hidden) { caption(t("warming")); shown = true; }
    }, 700);
    const t0 = performance.now();
    await call("python", { code: "1" }).catch(() => {});
    clearTimeout(slow);
    const fast = performance.now() - t0 < 300;
    if (shown && fast) { hideWarming(); shown = false; }
    if (wasSlow && fast) return;   // the warm-up is over
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (shown) hideWarming();
}

// ovos-stt-plugin-browser: the browser's own speech recognition, chosen as
// OVOS' STT plugin (stt.module). Kept up to date from boot and config changes.
const BROWSER_STT = "ovos-stt-plugin-browser";
const SpeechRecognitionAPI = self.SpeechRecognition || self.webkitSpeechRecognition;
let sttModule = null;
let ovosLang = "en-US";

/**
 * One utterance with the browser's recognition, in OVOS' language. The
 * words show in the caption as they come; resolves with the final text
 * ("" when nothing was said). Times out after 12 s like a recording.
 */
function browserSTT() {
  return new Promise((resolve) => {
    const r = new SpeechRecognitionAPI();
    r.lang = ovosLang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let final = "", done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(final.trim()); } };
    const timer = setTimeout(() => { try { r.stop(); } catch {} }, 12000);
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      caption(final + interim || t("mic.listening"), 0.3);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") caption(t("mic.error", { msg: e.error }), null, 6000);
    };
    r.onend = finish;
    try { r.start(); } catch (e) { caption(t("mic.error", { msg: e.message }), null, 6000); finish(); }
  });
}

/** Let the microphone go (the browser's own recognition needs it); the
 * next micStream() opens it again. */
function releaseMic() {
  wake.detach();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

/**
 * The microphone, opened once (the first tap) and kept. Echo cancellation
 * stays on, so Emkay does not hear itself; the browser's noise suppression
 * and automatic gain are off: they distort speech (the gain clips it) and
 * the wake word model is trained on plain audio, as STT servers expect it.
 */
async function micStream() {
  stream ??= await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  return stream;
}

/**
 * The wake word: OVOS' `listener.wake_word` ("hey_mycroft" by default),
 * heard by openWakeWord in its own worker (wakeword.js). The microphone
 * stays open while Emkay is on screen; what it hears is passed on in 80 ms
 * chunks of 16 kHz audio, except while Emkay records, speaks or is muted.
 * Hearing it does what ovos-dinkum-listener does: tell OVOS
 * (recognizer_loop:wakeword) and listen for the question.
 *
 * The same audio goes to OVOS' audio transformers (py/emkay_mobile/listener.py,
 * dinkum's feed_audio), only while one wants it (bootInfo.room_listeners), in
 * 0.32 s pieces; when the worker is still busy with the last piece, the next
 * is dropped rather than queued, as dinkum's transformers drop what they can't keep up with.
 */
const wake = {
  worker: null,
  state: "off",   // for diagnostics: off (and why), loading, listening, error: ...
  chunks: 0,      // 80 ms chunks passed on, and the best score seen (diagnostics)
  best: 0,
  /**
   * The engine for OVOS' wake word, from its own settings (hotwords.<name>),
   * as ovos-dinkum-listener picks the plugin: Precise for
   * ovos-ww-plugin-precise-onnx (OVOS' default for "hey mycroft") when the
   * site has its model; openWakeWord for ovos-ww-plugin-openwakeword, or
   * when the site has an openWakeWord model of that name and no Precise one.
   */
  engine(name) {
    const hw = bootInfo?.hotword || {};
    const precise = (bootInfo?.precise_models || {})[hw.model];
    if (hw.module === "ovos-ww-plugin-precise-onnx" && precise) {
      return { engine: "precise", model: precise, sensitivity: hw.sensitivity ?? 0.5,
        trigger_level: hw.trigger_level ?? 3 };
    }
    if ((bootInfo?.wake_words || []).includes(name)) {
      return { engine: "oww", model: `${name}_v0.1.onnx`, threshold: hw.threshold ?? 0.5 };
    }
    return null;
  },
  async start(name) {
    if (!name) { this.state = "off: no listener.wake_word"; return; }
    const engine = this.engine(name);
    if (!engine) { this.state = `off: no model for ${name}`; return; }
    this.state = "loading";
    this.engineName = engine.engine;
    this.worker = new Worker("wakeword.js", { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.error) { this.state = `error: ${data.error}`; console.warn("[emkay] wake word:", data.error); }
      if (data.ready) { this.state = "listening"; $("mic").classList.add("wake"); }
      if (data.score) this.best = Math.max(this.best, data.score);
      if (data.detected && this.active()) this.heard(name);
    };
    this.worker.postMessage({ cmd: "start", ...engine });
    // to 16 kHz Int16 by averaging (as toPcm16), 1280 samples at a time
    const ratio = audioCtx.sampleRate / 16000;
    const chunk = new Int16Array(1280);
    let fill = 0, acc = 0, n = 0, due = ratio;
    const proc = audioCtx.createScriptProcessor(4096, 1, 1);
    // The engine keeps the last ~1.3 s it heard. After a pause (recording,
    // speaking, muted, hidden) that is the wake word itself or the end of
    // the answer, which scored with the first new audio would wake Emkay
    // again by itself: so it starts afresh each time listening resumes.
    let listening = false;
    proc.onaudioprocess = (e) => {
      if (!this.active()) { fill = 0; listening = false; return; }
      if (!listening) { this.worker.postMessage({ cmd: "reset" }); listening = true; }
      const x = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < x.length; i++) {
        acc += x[i]; n++;
        if (n >= due) {
          const v = Math.max(-1, Math.min(1, acc / n));
          chunk[fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
          acc = 0; due += ratio - n; n = 0;
          if (fill === chunk.length) {
            this.worker.postMessage({ cmd: "audio", pcm: chunk.slice() });
            this.chunks++;
            fill = 0;
            if (bootInfo?.room_listeners?.length) room.add(chunk);
          }
        }
      }
    };
    proc.connect(audioCtx.destination);   // a ScriptProcessor runs only when connected; it outputs silence
    this.proc = proc;
    await this.attach();
  },
  /** Stop listening for the wake word and let its engine go. */
  stop() {
    this.detach();
    this.proc?.disconnect();
    this.proc = null;
    this.worker?.terminate();
    this.worker = null;
    this.state = "off";
    $("mic").classList.remove("wake");
  },
  /**
   * A new wake word from the settings (worker_main settings_changed): the
   * same as at boot, without a restart. The status line shows it loading.
   */
  async restart(name, hotword) {
    if (bootInfo) { bootInfo.wake_word = name; bootInfo.hotword = hotword || {}; }
    this.stop();
    if (!audioCtx) return;            // before the first tap: start() picks it up
    const label = String(name || "").replace(/_/g, " ");
    modelStatus.show({ what: "ww", name: label, progress: null, state: "loading" });
    await this.start(name);
    const ready = await new Promise((done) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const s = this.state;
        if (s === "listening" || s.startsWith("error") || s.startsWith("off") || Date.now() - t0 > 30000) {
          clearInterval(poll);
          done(s === "listening");
        }
      }, 200);
    });
    modelStatus.show({ what: "ww", name: label, progress: 1, state: ready ? "ready" : "error" });
  },
  /** Feed the microphone in (again, after the browser's recognition had it). */
  async attach() {
    if (!this.proc || this.source) return;
    this.source = audioCtx.createMediaStreamSource(await micStream());
    this.source.connect(this.proc);
  },
  detach() {
    this.source?.disconnect();
    this.source = null;
  },
  /** Listening for the wake word now? Not while recording, speaking, muted or hidden. */
  active() {
    return !mic.busy && !mic.muted && !speaker.playing && document.visibilityState === "visible";
  },
  heard(name) {
    call("wakeword", { name });
    mic.listen();
  },
};

/** Room audio for the audio transformers: 4 wake word chunks at a time (0.32 s). */
const room = {
  buf: new Int16Array(1280 * 4),
  fill: 0,
  busy: false,
  sent: 0,      // pieces sent, and dropped while the worker was busy (diagnostics)
  dropped: 0,
  add(chunk) {
    this.buf.set(chunk, this.fill);
    this.fill += chunk.length;
    if (this.fill < this.buf.length) return;
    this.fill = 0;
    if (this.busy) { this.dropped++; return; }   // behind: drop this piece
    this.busy = true;
    this.sent++;
    const pcm = new Uint8Array(this.buf.buffer.slice(0));
    Promise.resolve(call("room_audio", { pcm: pcm.buffer }, [pcm.buffer]))
      .catch((e) => console.warn("[emkay] room audio", e))
      .finally(() => { this.busy = false; });
  },
};

/**
 * The line under the face: what the microphone is doing and what it heard,
 * so a question that gets no answer shows where it stopped.
 * @param {string} text
 * @param {number|null} level  0..1 for the level bar while listening
 * @param {number} hideAfter   ms until the line goes, 0 = stays
 */
function caption(text, level = null, hideAfter = 0) {
  const el = $("caption");
  el.hidden = false;
  $("caption-text").textContent = text;
  $("caption-level").hidden = level === null;
  if (level !== null) $("caption-level").firstChild.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
  clearTimeout(captionTimer);
  if (hideAfter) captionTimer = setTimeout(() => (el.hidden = true), hideAfter);
}

/**
 * Record one utterance from the microphone.
 * Starts at once; stops after `silenceMs` of quiet once speech was heard,
 * after `noSpeechMs` with no speech at all, or after `maxSeconds`.
 * @returns {Promise<Uint8Array|null>} 16 kHz mono 16-bit PCM, or null if
 *   nothing was said
 */
async function record({ maxSeconds = 10, silenceMs = 700, noSpeechMs = 3000, level, stop } = {}) {
  const source = audioCtx.createMediaStreamSource(await micStream());
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  // Speech is what stands out from the room. The room is measured in the
  // first 300 ms by its *quietest* blocks, so speaking right away does not
  // raise the bar; phones turn the level down (noise suppression, gain
  // control), so the bar itself is low.
  let spoke = false, lastLoud = performance.now(), floor = Infinity;
  const t0 = performance.now();
  await new Promise((done) => {
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(x));
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      const now = performance.now();
      if (now - t0 < 300) floor = Math.min(floor, rms);           // room noise
      const bar = Math.max(0.006, Math.min(0.03, (floor === Infinity ? 0 : floor) * 3));
      if (now - t0 >= 150 && rms > bar) { spoke = true; lastLoud = now; }
      level?.(Math.sqrt(rms / 0.1));                                 // for the eye only
      if ((spoke && now - lastLoud > silenceMs) || (!spoke && now - t0 > noSpeechMs) || now - t0 > maxSeconds * 1000
          || stop?.()) done();
    };
    source.connect(proc);
    proc.connect(audioCtx.destination);
  });
  proc.disconnect();
  source.disconnect();
  if (!spoke) return null;
  return toPcm16(chunks, audioCtx.sampleRate, 16000);
}

/** Float32 chunks at `from` Hz -> one 16-bit PCM buffer at `to` Hz. */
function toPcm16(chunks, from, to) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = from / to, out = new Int16Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}


// --------------------------------------------------------------- speaker
/**
 * Plays the WAVs the TTS plugin makes, one after another, and tells OVOS
 * when each starts and ends (that is what moves the face's mouth).
 *
 * Everything goes through one gain node: the "mixer" of the browser PHAL
 * plugin (ovos-phal-plugin-browser), which answers OVOS' mycroft.volume.*
 * messages and sends the level here.
 */
const speaker = {
  queue: [],
  playing: false,
  level: { volume: 0.75, muted: false },
  gain: null,
  /** Create the output gain once the AudioContext exists. */
  attach(ctx) {
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.setVolume(this.level);
  },
  /** Apply {volume: 0..1, muted} from the PHAL plugin. */
  setVolume(level) {
    this.level = level;
    if (this.gain) this.gain.gain.value = level.muted ? 0 : level.volume;
  },
  spoken: 0,   // answers queued so far (unanswered() compares)
  enqueue(wav, meta) { this.spoken++; this.queue.push({ wav, meta }); if (!this.playing) this.next(); },
  /**
   * A sound (ovos-audio's play_sound): played at once, over speech, through
   * the same volume. Resolves when it has finished.
   */
  async playSound(data) {
    if (!audioCtx) return;
    try {
      const buf = data instanceof AudioBuffer ? data : await audioCtx.decodeAudioData(data);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain || audioCtx.destination);
      await new Promise((ok) => { src.onended = ok; src.start(); });
    } catch (e) {
      console.warn("[emkay] sound", e);
    }
  },
  async next() {
    const item = this.queue.shift();
    if (!item) { this.playing = false; privacy.active("voice", false); return; }
    if (!audioCtx) {
      // nothing may sound before the first tap (browser rule): skip it, but
      // tell OVOS it is done, so its speech state does not hang
      call("playback_ended", { ident: item.meta.ident });
      return this.next();
    }
    this.playing = true;
    privacy.active("voice", true);
    try {
      const buf = await audioCtx.decodeAudioData(item.wav);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain || audioCtx.destination);
      src.onended = () => { call("playback_ended", { ident: item.meta.ident }); this.next(); };
      src.start();
      call("playback_started", { ident: item.meta.ident, visemes: item.meta.visemes });
    } catch (e) {
      console.warn("[emkay] playback", e);
      call("playback_ended", { ident: item.meta.ident });
      this.next();
    }
  },
};

// ------------------------------------------------------------ midi synth
/**
 * ovos-phal-plugin-midi's sound. In a browser its synth (in the worker)
 * sends what it plays as ovos.midi.pcm: {seq, sample_rate, at (wall-clock
 * seconds of the first sample), pcm (base64 s16le mono)}. Each piece is
 * played at its time, through the speaker's volume, so the music is
 * seamless and on the beat the skill asked for. A piece that comes too late
 * is played at once, after the one before it.
 */
const midiOut = {
  until: 0,   // audioCtx time the last piece ends
  play({ sample_rate: rate, at, pcm }) {
    if (!audioCtx || !pcm) return;
    const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
    const ints = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const buf = audioCtx.createBuffer(1, ints.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ints.length; i++) ch[i] = ints[i] / 32768;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(speaker.gain || audioCtx.destination);
    let when = audioCtx.currentTime + (at - Date.now() / 1000);
    if (Math.abs(when - this.until) < 0.03) when = this.until;      // back to back: no gap, no click
    when = Math.max(when, audioCtx.currentTime + 0.01);
    src.start(when);
    this.until = when + buf.duration;
  },
};

// ------------------------------------------------------- model downloads
/**
 * The status line at the top while a speech model or wake word is fetched
 * after a settings change, and what speaks or listens meanwhile.
 *
 * show({what, name, progress, state}): what is "stt", "tts" or "ww"; state
 * "loading" (progress 0..1, or null when unknown), "ready" or "error".
 * Downloads come from whisper.js and piper.js (worker kind "model"), the
 * wake word from wake.restart(). A model that loads from the cache in under
 * 0.6 s never shows: only a real wait does.
 * interim({what, using, module}) comes from speech.py (emkay.speech.interim):
 * "previous" (the plugin from before the change) or "fallback" (`module`).
 */
const modelStatus = {
  shown: new Set(),       // what:name keys on screen
  pending: new Map(),     // what:name -> timer before showing
  hideTimer: null,
  show({ what, name, progress, state, detail = "" }) {
    const key = `${what}:${name}`;
    if (state === "loading" || state === "reading") {
      if (!this.shown.has(key)) {
        if (progress !== null && !this.pending.has(key)) {
          this.pending.set(key, setTimeout(() => {
            this.pending.delete(key);
            this.shown.add(key);
            this.render(what, name, this.last?.[key] ?? progress, state);
          }, 600));
        } else if (progress === null) {
          this.shown.add(key);
        }
        this.last = { ...this.last, [key]: progress };
        if (!this.shown.has(key)) return;
      }
      return this.render(what, name, progress, state);
    }
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
    if (state === "ready") {   // the new one takes over now
      $("model-status-interim").hidden = true;
      privacy.ready(what);
      speechWait.ready(what);
      if (what === "stt") opening.done();   // the ears opened: this start did not end there
    }
    if (state === "error") speechWait.fail(what, detail);
    if (state === "error" && what === "stt") opening.done();   // it failed, the page did not close
    if (!this.shown.has(key) && state === "ready") return;   // came from the cache: nothing to say
    this.shown.delete(key);
    this.render(what, name, 1, state, detail);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.shown.size) $("model-status").hidden = true;
      $("model-status-interim").hidden = true;
    }, state === "error" ? (detail ? 20000 : 6000) : 3000);   // why it failed takes reading
  },
  render(what, name, progress, state, detail = "") {
    clearTimeout(this.hideTimer);
    const pct = progress === null || progress === undefined ? "" : `${Math.round(progress * 100)} %`;
    $("model-status-text").textContent = t(`model.${state}.${what}`, { name, pct }) + (detail ? `: ${detail}` : "");
    $("model-bar").hidden = !(state === "loading" || state === "reading") || progress === null;
    if (progress !== null) $("model-bar").firstChild.style.width = `${Math.round(progress * 100)}%`;
    $("model-status").hidden = false;
  },
  interim({ what, using, module }) {
    const kind = using === "previous" ? "previous" : /server/.test(module || "") ? "server" : "fallback";
    $("model-status-interim").textContent = t(`model.interim.${kind}.${what}`, { module: module || "" });
    $("model-status-interim").hidden = false;
    if ($("model-status").hidden) {           // nothing downloading on screen: show it briefly
      $("model-status-text").textContent = "";
      $("model-bar").hidden = true;
      $("model-status").hidden = false;
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => { if (!this.shown.size) $("model-status").hidden = true; }, 5000);
    }
  },
};

// ------------------------------------------- the device's speech not ready
/**
 * Emkay's speech runs on the device, and no server stands in by itself
 * (defaults v15). Until its models are there – the first start, a new
 * language, a failed download – speech.py says so (emkay.speech.waiting)
 * instead of sending anything out: the ears (stt) or the voice (tts). This
 * note says it in words, opens the keyboard when Emkay can't hear yet,
 * shows an answer it couldn't speak as text, and offers OpenVoiceOS' servers
 * until then – chosen, for this start only (speech.py servers_meanwhile);
 * the privacy chip turns amber when they are used.
 */
const speechWait = {
  waiting: new Set(),   // "stt", "tts"
  dismissed: false,     // "Not now": the note stays away this start; captions still say it
  has(what) { return this.waiting.has(what); },
  remember: "",         // "stt"/"tts": no model for this language on the device – the choice is kept
  failed: new Set(),    // "stt"/"tts" whose model download failed (modelStatus)
  why: {},              // what -> why it failed, when the model said (whisper.js, worker.js)
  failedText(what) { return t(`wait.${what}.failed`) + (this.why[what] ? ` (${this.why[what]})` : ""); },
  /** A model download failed (modelStatus): an open note says so, and why. */
  fail(what, detail = "") {
    this.failed.add(what);
    this.why[what] = detail;
    if (this.waiting.has(what) && !$("speech-wait").hidden && !this.remember) {
      $("speech-wait-text").textContent = this.failedText(what);
    }
  },
  show({ what, utterance, reason }) {
    this.waiting.add(what);
    if (what === "tts" && utterance) this.shownAt = Date.now();
    if (what === "tts" && utterance) caption(`“${utterance}”`, null, Math.max(6000, utterance.length * 90));
    if (what === "stt") { $("type").hidden = false; }
    if (this.dismissed) return;
    // a browser that can't run Emkay's ears and voice on the device at all
    // (no JSPI: Safari before 27, say): say so plainly, with what it takes;
    // the servers, if chosen, are kept for both in this browser – and the
    // note says what that means for privacy before anyone taps it
    if (reason === "browser") {
      this.remember = "stt,tts";
      $("speech-wait-text").textContent = t("wait.browser");
      $("speech-wait-servers").textContent = t("wait.servers.browser");
      $("speech-wait").hidden = false;
      return;
    }
    // a language Emkay has no voice (or ears) for on the device: say so plainly,
    // and the servers, if chosen, are kept for it
    this.remember = reason === "language" ? what : "";
    const both = this.waiting.has("stt") && this.waiting.has("tts");
    // the download failed (modelStatus "error"): not "on its way"
    $("speech-wait-text").textContent = t(this.remember ? `wait.${what}.language`
      : both ? "wait.both" : `wait.${what}`);
    if (!this.remember && this.failed.has(what)) $("speech-wait-text").textContent = this.failedText(what);
    $("speech-wait-servers").textContent = t(this.remember ? "wait.servers.always" : "wait.servers");
    $("speech-wait").hidden = false;
  },
  /** A model on the device is ready (modelStatus). */
  ready(what) {
    this.failed.delete(what);
    if (!this.waiting.delete(what)) return;
    if (!this.waiting.size) $("speech-wait").hidden = true;
    else $("speech-wait-text").textContent = t(`wait.${[...this.waiting][0]}`);
  },
};
$("speech-wait-servers").onclick = async () => {
  $("speech-wait").hidden = true;
  speechWait.dismissed = true;
  try {
    await call("servers_meanwhile", { remember: speechWait.remember });
    caption(t(speechWait.remember ? "wait.servers.kept" : "wait.servers.on"), null, 5000);
  } catch (e) {
    console.warn("[emkay] servers meanwhile", e);
  }
};
$("speech-wait-close").onclick = () => { $("speech-wait").hidden = true; speechWait.dismissed = true; };

// ------------------------------------------------------------ PHAL plugin
/**
 * A message from the browser PHAL plugin (ovos-phal-plugin-browser), which
 * answers OVOS' hardware messages: a volume level to apply, or a request
 * for something only the page can reach.
 */
function onPhal(msg) {
  if (msg.request === "location") return locate();
  if (msg.request === "kiosk") return onKiosk(msg.message);   // ovos-skill-kiosk
  if (msg.request === "local_only") { $("offline-shield").hidden = !msg.enabled; return; }
  if (deviceRequest(msg)) return;   // power, camera (device.js)
  speaker.setVolume(msg);
  media.setLevel(msg);               // music follows the same volume
}

// ------------------------------------------------------------------ media
/** Music, radio and podcasts: ovos-audio's AudioService plays them here,
 * through ovos-audio-plugin-browser (media.js has the details). */
// your own music from a folder on the device (#108): it owns the files; the
// local OVOS searches them (py/emkay_local_media), the player plays them
const localMedia = createLocalMedia({
  call: (cmd, args, transfer) => call(cmd, args, transfer),
  askTap: (on) => musicTip(on),
});
const media = createMediaPlayer((type, data) => brain.emit(type, data),
  { resolve: (uri) => localMedia.file(uri) });

/**
 * The phone's position for OVOS' location (the plugin turns it into city,
 * country and time zone). The browser asks the user first; a "no" leaves
 * OVOS on the browser's time zone.
 */
function locate() {
  const answer = (args) => call("phal_position", args);
  if (!navigator.geolocation) return answer({ error: "geolocation unsupported" });
  navigator.geolocation.getCurrentPosition(
    (p) => answer({ lat: p.coords.latitude, lon: p.coords.longitude }),
    (e) => answer({ error: e.message || `code ${e.code}` }),
    { maximumAge: 3600e3, timeout: 60e3 },
  );
}

// ------------------------------------------------------------- bus events
/**
 * A status event for the visage alone, not put on OVOS' bus. While Emkay
 * sings (ovos-skill-karaoke) the face is told it speaks, so it shows and
 * moves its mouth with the song's visemes (enclosure.mouth.viseme_list);
 * OVOS itself must not hear that, or the listener would stop listening
 * (mute_during_output) and "stop" could not end the song. The visage takes
 * its status from the GUI socket, as ovos-gui forwards it there: an event
 * in the "system" namespace.
 */
let singing = false;
function toVisage(type, data = {}) {
  const raw = JSON.stringify({ type: "mycroft.events.triggered", namespace: "system", event_name: type, data });
  for (const s of guiSockets) s.deliver(raw);
}

/** React to the few bus events the page itself cares about (`data`: bytes
 * that came with it, e.g. a file:// track for media.js). */
function onBus(msg, data) {
  if (media.onBus(msg, data)) return;
  if (localMedia.onBus(msg)) return;
  if (msg.type === "ovos.midi.pcm") return midiOut.play(msg.data);
  // ovos-skill-karaoke: while Emkay sings, the words go under the face (in
  // karaoke mode the skill's own screen shows them)
  if (msg.type === "ovos.karaoke.lyrics") {
    if (msg.data.mode === "sing") {
      caption(`♪ ${msg.data.line}`);
      if (!singing) { singing = true; toVisage("ovos.audio.output.started"); }
    }
    return;
  }
  if (msg.type === "ovos.karaoke.ended") {
    if ($("caption-text").textContent.startsWith("♪")) $("caption").hidden = true;
    if (singing) { singing = false; toVisage("ovos.audio.output.ended"); }
    return;
  }
  if (msg.type === "emkay.speech.interim") { privacy.interim(msg.data); return modelStatus.interim(msg.data); }
  if (msg.type === "emkay.speech.waiting") return speechWait.show(msg.data);
  if (msg.type === "emkay.room") {      // other audio transformers in the settings
    if (bootInfo) bootInfo.room_listeners = msg.data?.names || [];
    privacy.room(bootInfo?.room_listeners || []);
    return;
  }
  if (msg.type === "emkay.wakeword") {   // a new wake word in the settings
    wake.restart(msg.data.wake_word, msg.data.hotword).catch((e) => { wake.state = `error: ${e.message || e}`; });
    return;
  }
  if (msg.type === "mycroft.mic.listen") setTimeout(() => mic.listen(), 150);  // a skill asked a question
  if (msg.type === "recognizer_loop:state.set" && msg.data?.state === "recording") {
    recording.start(msg.data.recording_name || String(Date.now()));
    return;
  }
  if (msg.type === "recognizer_loop:record_stop") { recording.stop = true; return; }
  if (msg.type === "ovos.utterance.handled") utterancesHandled++;
  if (msg.type === "mycroft.mic.mute") mic.setMuted(true);
  if (msg.type === "emkay.lang") {   // a config change, e.g. in the panel
    languageChanged(msg.data.lang);
    ovosLang = msg.data.lang || ovosLang;
    sttModule = msg.data.stt_module ?? sttModule;
    privacy.route(msg.data.speech_route);
  }
  if (msg.type === "mycroft.mic.unmute") mic.setMuted(false);
}

// ---------------------------------------------------------------- typing
$("keyboard").onclick = () => {
  $("type").hidden = !$("type").hidden;
  if (!$("type").hidden) $("type-text").focus();
};
$("type").onsubmit = (e) => {
  e.preventDefault();
  const text = $("type-text").value.trim();
  if (text) {
    const before = speaker.spoken, handled = utterancesHandled;
    questionsAsked++;
    call("say", { text }).then(() => unanswered(before, handled));
  }
  $("type-text").value = "";
};

// -------------------------------------------------------- settings panel
// The stock ovos-control-panel runs in the worker (py/emkay_mobile/panel.py).
// sw.js catches the requests its pages make and hands each one here, with
// a port for the answer; the worker's panel app produces the response.

/**
 * The panel's cookies. Once an access token is set, the panel signs a
 * browser in with a cookie (ovos_webui_token). A response a Service Worker
 * builds may not set cookies (the browser drops Set-Cookie), so this page
 * keeps them, as a browser would, and sends them with each panel request.
 * They live as long as this page (and OVOS) does; after a reload the panel
 * asks for the token again.
 */
const panelCookies = new Map();

/** The request's headers with the kept cookies. */
function withCookies(headers) {
  const out = headers.filter(([k]) => k.toLowerCase() !== "cookie");
  if (panelCookies.size) out.push(["cookie", [...panelCookies].map(([k, v]) => `${k}=${v}`).join("; ")]);
  return out;
}

/** Keep, replace or drop cookies from a response's Set-Cookie headers. */
function keepCookies(headers) {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== "set-cookie") continue;
    const [pair, ...attrs] = v.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, "");
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a))
      || attrs.some((a) => { const m = a.match(/^\s*expires\s*=(.*)$/i); return m && Date.parse(m[1]) < Date.now(); });
    if (!value || expired) panelCookies.delete(name);
    else panelCookies.set(name, value);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("[emkay] service worker", e));
  navigator.serviceWorker.onmessage = async (event) => {
    const port = event.ports[0];
    const resPath = event.data?.resRequest;   // the visage's res/, res-abs/
    if (resPath && port) {
      await ready;
      const bytes = await call("res_file", { path: resPath }).catch(() => null);
      return port.postMessage(bytes ? { body: bytes } : {}, bytes ? [bytes.buffer] : []);
    }
    const req = event.data?.panelRequest;
    if (!req || !port) return;
    try {
      await ready;   // OVOS (and so the panel) is up
      req.headers = withCookies(req.headers);
      const res = await call("panel_request", req, req.body ? [req.body] : []);
      keepCookies(res.headers);
      port.postMessage(res, [res.body.buffer]);
    } catch (e) {
      const body = new TextEncoder().encode(String(e));
      port.postMessage({ status: 502, headers: [["content-type", "text/plain"]], body }, [body.buffer]);
    }
  };
}

let bootInfo = null;   // what boot() returned

/**
 * OVOS' language changed (the control panel). Emkay's texts follow at once.
 * The pre-trained intents for a language are fetched when OVOS starts, as
 * a device loads a new language when its services restart; so if this
 * boot has none for the new one, a button offers that restart.
 */
function languageChanged(lang) {
  setLang(lang);
  const want = matchLang(lang, bootInfo?.site_langs || []);
  const missing = Boolean(want) && !(bootInfo?.intent_langs || []).includes(want);
  const el = $("restart-lang");
  el.hidden = !missing;
  if (missing) {
    el.textContent = t("restart.lang", { lang: want });
    el.onclick = async () => { await call("sync").catch(() => {}); location.reload(); };
  }
}

/**
 * What the menu opened over the face (settings, store, Guardian, about):
 * closing it goes back to the menu, as in an app. Opened another way (the
 * setup on first start, a skill), closing just closes.
 */
const fromMenu = new Set();
function openFromMenu(id, open) {
  fromMenu.add(id);
  open();
}
function closeView(id) {
  $(id).hidden = true;
  if (fromMenu.delete(id)) $("menu").hidden = false;
}

/**
 * A skill handed over by the store (store.emkay.ai "Get" opens
 * app.emkay.ai/?install=<package>): open the control panel's Plugins page
 * searched for that package, where the panel's own Install button (and its
 * own "are you sure?") installs it with ovos-core's installer. Emkay itself
 * installs nothing on a link's say-so.
 */
function installFromStore(pkg = params.get("install")) {
  if (params.get("install")) {
    const url = new URL(location);
    url.searchParams.delete("install");   // a reload must not ask again
    history.replaceState(null, "", url);
    params.delete("install");
  }
  if (pkg && GITHUB_SPEC.test(pkg)) {     // a skill from GitHub: its own card (below)
    $("store").hidden = true;
    $("gh-install").hidden = false;
    openGithub(ghSpec(pkg));
    return;
  }
  if (!pkg || !PACKAGE_NAME.test(pkg)) return;
  $("store").hidden = true;
  if (fromMenu.delete("store")) fromMenu.add("panel");   // closing the panel goes back to the menu
  const frame = $("panel-frame");
  frame.addEventListener("load", () => {
    try {
      const doc = frame.contentDocument;
      doc.getElementById("q").value = pkg;
      doc.getElementById("go").click();
    } catch (e) {
      console.warn("[emkay] store install", e);
    }
  }, { once: true });
  openPanel("plugins");
}

let started = false;   // the first tap has been made (start())

/**
 * A package from the store, by another tab (?install, above) or by the
 * store shown inside Emkay (a message from its frame): offered in the
 * panel once Emkay is started, as for ?install.
 */
function receiveInstall(pkg) {
  if (started) installFromStore(pkg);
  else pendingInstall = pkg;
}

// The store inside Emkay (menu → Skill store): its "Get" posts the package
// here instead of opening a new tab. Only the store's own origin is heard.
addEventListener("message", (e) => {
  if (e.origin !== STORE_ORIGIN) return;
  if (e.data?.emkayClose) { closeView("store"); return; }   // its "Back to Emkay"
  const pkg = e.data?.emkayInstall;
  if (typeof pkg === "string" && PACKAGE_NAME.test(pkg)) receiveInstall(pkg);
});

/** Show the skill store over the face, in a frame, so "Get" stays in this Emkay. */
function openStore() {
  $("menu").hidden = true;
  const frame = $("store-frame");
  if (!frame.getAttribute("src")) frame.src = `${STORE_ORIGIN}/?in=emkay&lang=${encodeURIComponent(ovosLang || "")}`;
  $("store").hidden = false;
}
$("menu-store").onclick = (e) => { e.preventDefault(); openFromMenu("store", openStore); };

/**
 * Show the OpenVoiceOS settings over the face.
 * @param {string} page  a panel page to open, e.g. "setup"; "" keeps the
 *   page that was open last (the dashboard the first time)
 */
function openPanel(page = "") {
  $("menu").hidden = true;
  if (housePanel) {
    const frame = $("panel-frame");
    if (!frame.getAttribute("src")) frame.src = housePanel;
    $("panel").hidden = false;
    return;
  }
  // the panel's menu starts with only the everyday pages; its advanced
  // groups are folded until opened (ovos-control-panel 0.0.1a58)
  const frame = $("panel-frame");
  if (page || !frame.getAttribute("src")) frame.src = `panel/${page}`;
  $("panel").hidden = false;
}
$("panel-close").onclick = () => closeView("panel");

// ------------------------------------------------------------------ menu
$("menu-panel").onclick = () => openFromMenu("panel", () => openPanel());
$("menu-button").onclick = () => { $("menu").hidden = !$("menu").hidden; };
$("menu-close").onclick = () => { $("menu").hidden = true; };
$("menu-kiosk").onclick = () => { kiosk = true; enterKiosk(); $("menu").hidden = true; };

// ------------------------------------------------------- install as an app
// Chrome, Edge and Android offer installing a site with a manifest
// (manifest.webmanifest: full screen, the face's icon) and fire
// beforeinstallprompt; Emkay then offers it once, in a small tip by ⚙,
// which asks the browser to show its own install dialog. iOS has no such
// event: Safari installs from Share → "Add to Home Screen", so the tip says
// that. Not now is remembered; "install yourself as an app" by voice
// (ovos-skill-kiosk) still works. Once Emkay runs as an installed app,
// nothing shows.
const installed = () => matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches
  || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const INSTALL_TIP = "emkay-install-tip";
let installPrompt = null;
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
}
/** The browser asks again for the kept music folder: a tap on this note. */
function musicTip(on) {
  const tip = $("music-tip");
  if (!tip) return;
  tip.hidden = !on;
  if (!on) return;
  apply(tip);
  $("music-tip-yes").onclick = () => { tip.hidden = true; localMedia.allow(); };
  $("music-tip-no").onclick = () => { tip.hidden = true; };
}
function offerInstall() {
  let seen = false;
  try { seen = !!localStorage.getItem(INSTALL_TIP); } catch {}
  if (seen || installed() || devMode || !started || !(installPrompt || isIOS)) return;
  const tip = $("install-tip");
  const close = () => { tip.hidden = true; try { localStorage.setItem(INSTALL_TIP, "1"); } catch {} };
  $("install-tip-text").dataset.i18n = isIOS && !installPrompt ? "install.ios" : "menu.install.hint";
  apply(tip);
  $("install-tip-yes").hidden = !installPrompt;
  $("install-tip-yes").onclick = async () => { close(); await installApp(); };
  $("install-tip-no").onclick = close;
  tip.hidden = false;
}
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();          // no mini-infobar: Emkay offers it in its tip
  installPrompt = e;
  offerInstall();
});
addEventListener("appinstalled", () => { installPrompt = null; $("install-tip").hidden = true; });

// --------------------------------------------------------------- version
/**
 * What this site is, to refer to in a bug report: Emkay's version, the CI
 * build number and the commit (build.json, tools/build_site.py). Shown
 * under the boot screen's progress bar and in About.
 */
const release = fetch("build.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({}));
const releaseLine = (b) => b.version ? `Emkay ${b.version} · build ${b.build} · ${b.commit}` : "";
release.then((b) => { $("boot-version").textContent = releaseLine(b); });

/** About: who made Emkay and what it stands on; version, build and date. */
$("menu-about").onclick = async () => {
  fromMenu.add("about");
  $("menu").hidden = true;
  $("about").hidden = false;
  const b = await release;
  const link = $("about-release");
  link.textContent = releaseLine(b);
  // the release notes of the version; a local build points at its commit
  link.href = b.build === "local" || !b.version
    ? `https://github.com/emkay-voice/emkay/commit/${b.commit || ""}`
    : `https://github.com/emkay-voice/emkay/releases/tag/v${b.version}`;
  $("about-version").textContent = b.built
    ? t("about.version", { date: new Date(b.built).toLocaleDateString() }) : "";
};
$("about-close").onclick = () => closeView("about");

// ---------------------------------------------------------- kiosk by voice
/**
 * ovos.kiosk.* (ovos-skill-kiosk): full screen, keeping the screen on and
 * installing as an app, asked for by voice. A browser allows full screen
 * and installing only after a tap, so for those one big button shows; the
 * answer (<type>.response) says what the screen is and whether a tap is
 * needed, and <type>.done follows once it is done.
 */
const busSend = (type, data) => brain.emit(type, data);
const kioskState = () => ({ fullscreen: !!document.fullscreenElement, keep_awake: wakeLockOn,
  installed: installed(), can_install: !!installPrompt,
  supported: !!document.documentElement.requestFullscreen, ios: isIOS });

function tapToDo(label, action) {
  const button = $("tap-action");
  button.textContent = label;
  button.hidden = false;
  button.onclick = async () => { button.hidden = true; await action(); };
  clearTimeout(tapToDo.timer);
  tapToDo.timer = setTimeout(() => { button.hidden = true; }, 30000);
}

function onKiosk(msg) {
  const reply = (extra = {}) => busSend(`${msg.type}.response`, { ...kioskState(), ...extra });
  const done = () => setTimeout(() => busSend(`${msg.type}.done`, kioskState()), 600);
  const on = msg.data?.enabled !== false;
  switch (msg.type) {
    case "ovos.kiosk.fullscreen":
      if (!on) {
        kiosk = false;
        document.exitFullscreen?.().catch(() => {});
        return reply();
      }
      if (document.fullscreenElement) return reply();
      tapToDo(t("kiosk.tap.fullscreen"), () => { kiosk = true; enterKiosk(); done(); });
      return reply({ needs_tap: true });
    case "ovos.kiosk.keep_awake":
      if (on) { wakeLockOn = true; keepAwake(); } else letSleep();
      return reply();
    case "ovos.kiosk.install":
      if (installed()) return reply();
      if (installPrompt) {
        tapToDo(t("kiosk.tap.install"), async () => { await installApp(); done(); });
        return reply({ needs_tap: true });
      }
      return reply({ supported: false });
    case "ovos.kiosk.status":
      return reply();
  }
}

// --------------------------------------------------------------- network
/**
 * The network log (netlog.js in the worker): everything Emkay contacted in
 * the last days, by day, then by service, then each request, every level
 * folded with <details>. Nothing but host, method, status, size and who
 * asked is kept, so nothing here says what was asked.
 */
const kB = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB`
  : `${(n / 1048576).toFixed(1)} MB`);
const sum = (list) => list.reduce((a, e) => a + (e.bytes || 0), 0);
const groupBy = (list, key) => list.reduce((m, e) => m.set(key(e), [...(m.get(key(e)) || []), e]), new Map());

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  node.append(...children);
  return node;
}

/** A service's name in the menu's language: network.kind.<kind>, else the log's words. */
const serviceName = (e) => (e.kind && e.kind !== "other" && t(`network.kind.${e.kind}`) !== `network.kind.${e.kind}`
  ? t(`network.kind.${e.kind}`) : e.service || e.host);

function renderNetwork(entries) {
  const list = $("network-list");
  list.replaceChildren();
  const today = new Date().toDateString();
  // what went out today; requests refused in local only are counted apart
  const todays = entries.filter((e) => new Date(e.t).toDateString() === today);
  const sent = todays.filter((e) => !e.blocked), refused = todays.length - sent.length;
  $("network-summary").textContent = t("network.summary", {
    services: new Set(sent.map(serviceName)).size, calls: sent.length, size: kB(sum(sent)) || "0 B" })
    + (refused ? ` · ${t("network.summary.blocked", { count: refused })}` : "");
  if (!entries.length) { list.append(el("p", { className: "small", textContent: t("network.empty") })); return; }
  const days = groupBy([...entries].reverse(), (e) => new Date(e.t).toDateString());
  let first = true;
  for (const [day, dayEntries] of days) {
    const dayBox = el("details", { open: first },
      el("summary", {}, new Date(dayEntries[0].t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
        el("span", { className: "count", textContent: `${dayEntries.length} · ${kB(sum(dayEntries))}` })));
    first = false;
    const services = [...groupBy(dayEntries, serviceName)].sort((a, b) => b[1].length - a[1].length);
    for (const [name, calls] of services) {
      const hosts = [...new Set(calls.map((e) => e.host))].join(", ");
      const who = [...new Set(calls.map((e) => e.who))].join(", ");
      const stopped = calls.filter((e) => e.blocked).length;
      const count = `${calls.length - stopped} · ${kB(sum(calls))}` + (stopped ? ` · 🛡 ${stopped}` : "");
      const box = el("details", {},
        el("summary", { title: hosts }, name, el("span", { className: "count", textContent: count })),
        el("p", { className: "small", textContent: `${hosts} – ${t("network.who")}: ${who}` }));
      const table = el("table");
      for (const e of calls.slice(0, 200)) {
        table.append(el("tr", {},
          el("td", { textContent: new Date(e.t).toLocaleTimeString() }),
          el("td", { textContent: e.who }),
          e.blocked   // refused in local only: never sent
            ? el("td", { textContent: `${e.method} 🛡 ${t("network.blocked")}`, className: "blocked" })
            : el("td", { textContent: `${e.method} ${e.status || "–"}`, className: e.status && e.status < 400 ? "" : "fail" }),
          el("td", { textContent: kB(e.bytes) })));
      }
      box.append(table);
      dayBox.append(box);
    }
    list.append(dayBox);
  }
}

function download(name, type, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

let networkEntries = [];
$("menu-network").onclick = async () => {
  fromMenu.add("network");
  $("menu").hidden = true;
  $("network").hidden = false;
  guardianButton();
  networkEntries = await call("net_log").catch(() => []);
  renderNetwork(networkEntries);
};
$("network-json").onclick = () => download("emkay-network.json", "application/json",
  JSON.stringify(networkEntries, null, 1));
$("network-csv").onclick = () => download("emkay-network.csv", "text/csv",
  ["time,host,kind,service,who,method,status,bytes",
   ...networkEntries.map((e) => [new Date(e.t).toISOString(), e.host, e.kind ?? "", e.service, e.who, e.method, e.status, e.bytes ?? ""]
     .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n"));
// two taps to clear: the first asks, the second clears (no dialogs here)
$("network-clear").onclick = async () => {
  const button = $("network-clear");
  if (!button.dataset.armed) {
    button.dataset.armed = "1";
    button.textContent = t("network.clear.sure");
    setTimeout(() => { delete button.dataset.armed; button.textContent = t("network.clear"); }, 4000);
    return;
  }
  delete button.dataset.armed;
  button.textContent = t("network.clear");
  await call("net_clear");
  networkEntries = [];
  renderNetwork(networkEntries);
};
$("network-close").onclick = () => closeView("network");

/**
 * The offline switch in Guardian: the same bus message as "go offline" by
 * voice (ovos-skill-guardian), answered by the PHAL plugin, which shows the
 * shield; the button follows the shield.
 */
function guardianButton() {
  const on = !$("offline-shield").hidden;
  $("guardian-offline").textContent = t(on ? "guardian.go_online" : "guardian.go_offline");
  $("guardian-offline").classList.toggle("on", on);
}
$("guardian-offline").onclick = () => {
  busSend("ovos.local_only", { enabled: $("offline-shield").hidden });
};
new MutationObserver(guardianButton).observe($("offline-shield"), { attributes: true });

// ------------------------------------------------------- skills from GitHub
/**
 * A skill straight from its GitHub repo (emkay-voice/emkay#49): a link or QR
 * code (Emkay Dev's "Send to my Emkay", dev.emkay.ai's gallery) opens
 * app.emkay.ai/?install=github:owner/repo[@ref]. Nothing installs on the
 * link's say-so: this card shows the repo and says plainly that the store has
 * not tested it, and only the Install button installs it, through ovos-core's
 * installer like a store skill (`git+https://github.com/...`, which the
 * browser's pip builds itself, github.py). The same card lists what came from
 * GitHub, to update (the newest commit) or remove.
 */
let ghOffered = null;
async function openGithub(offer = null) {
  $("menu").hidden = true;
  $("github").hidden = false;
  $("gh-offer").hidden = !offer;
  $("gh-status").hidden = true;
  $("gh-note").hidden = true;
  $("gh-detail").hidden = true;
  $("gh-install").disabled = false;
  ghOffered = offer;
  if (offer) {
    const name = `${offer.owner}/${offer.repo}${offer.ref ? ` @ ${offer.ref}` : ""}`;
    $("gh-repo").textContent = name;
    $("gh-repo").href = `https://github.com/${offer.owner}/${offer.repo}`;
    $("gh-about").textContent = "";
    $("gh-facts").textContent = t("gh.by", { owner: offer.owner });
    const info = await call("gh_info", { owner: offer.owner, repo: offer.repo }).catch(() => ({ error: 0 }));
    if (ghOffered !== offer) return;
    if (info.error) {
      $("gh-about").textContent = t(info.error === 404 ? "gh.notfound" : "gh.unreachable");
      $("gh-install").disabled = info.error === 404;
    } else {
      $("gh-about").textContent = info.about;
      const when = info.pushed ? new Date(info.pushed).toLocaleDateString(document.documentElement.lang || undefined,
        { day: "numeric", month: "long", year: "numeric" }) : "";
      const license = info.license && info.license !== "NOASSERTION" ? info.license : "";
      $("gh-facts").textContent = [t("gh.by", { owner: info.owner }), when && t("gh.updated", { when }),
        info.stars ? `★ ${info.stars}` : "", license].filter(Boolean).join(" · ");
    }
  }
  await renderGithubList();
}

async function renderGithubList() {
  const list = $("gh-list");
  const items = await call("gh_installed").catch(() => []);
  list.replaceChildren();
  if (!items.length) {
    if (!ghOffered) list.append(el("p", { className: "small", textContent: t("gh.empty") }));
    return;
  }
  list.append(el("p", { className: "small", textContent: t("menu.github.hint") }));
  for (const d of items) {
    const where = d.url.replace(/^https:\/\/github\.com\//, "");
    const update = el("button", { className: "secondary", textContent: t("gh.update") });
    const remove = el("button", { className: "secondary", textContent: t("gh.remove") });
    const note = $("gh-note");
    // a repository can go away (deleted, made private) or be archived by its
    // owner – e.g. a skill from dev.emkay.ai's gallery: the copy here keeps
    // working, and this says so instead of a bare "failed"
    update.onclick = () => ghRun(update, note, async () => {
      const [owner, repo] = where.split("/");
      const info = await call("gh_info", { owner, repo }).catch(() => ({ error: 0 }));
      if (info.error === 404) return { ok: false, gone: true };
      const r = await call("gh_install", { spec: ghPip({ ...ghSpec(d.url), ref: d.ref || "" }) });
      return { ...r, archived: !!info.archived };
    }, async (r) => {
        const now = (await call("gh_installed").catch(() => [])).find((x) => x.name === d.name);
        const said = now && now.commit === d.commit ? t("gh.uptodate") : t("gh.updated_ok");
        return r.archived ? `${said} ${t("gh.archived")}` : said;
      });
    // two taps to remove, as the network log's Clear (no dialogs here)
    remove.onclick = () => {
      if (!remove.dataset.armed) {
        remove.dataset.armed = "1";
        remove.textContent = t("gh.remove.sure");
        setTimeout(() => { delete remove.dataset.armed; remove.textContent = t("gh.remove"); }, 4000);
        return;
      }
      ghRun(remove, note, () => call("gh_remove", { name: d.name }), () => t("gh.removed"));
    };
    const link = el("a", { href: d.url, target: "_blank", rel: "noopener", textContent: where });
    list.append(el("div", { className: "gh-item" },
      el("b", { textContent: d.skills?.[0] || d.name }),
      el("span", { className: "small" }, link, ` · ${(d.commit || "").slice(0, 7)}`),
      el("div", { className: "row" }, update, remove)));
  }
}

/** Run an install/update/removal from a button, saying how it went. */
async function ghRun(button, note, run, okText) {
  const buttons = $("github").querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  note.hidden = false;
  note.className = "gh-status";
  note.textContent = t("gh.working");
  let r;
  try { r = await run(); } catch (e) { r = { ok: false, error: String(e), detail: "" }; }
  buttons.forEach((b) => { b.disabled = false; });
  const said = r.ok ? await okText(r) : r.gone ? t("gh.gone") : `${t("gh.failed")} ${r.error || ""}`.trim();
  note.textContent = said;
  note.className = `gh-status ${r.ok ? "ok" : "fail"}`;
  if (!r.ok && r.detail) {
    $("gh-detail").hidden = false;
    $("gh-detail").querySelector("pre").textContent = r.detail;
  }
  if (r.ok) await renderGithubList();
  return r;
}

$("gh-install").onclick = async () => {
  if (!ghOffered) return;
  const r = await ghRun($("gh-install"), $("gh-status"), () => call("gh_install", { spec: ghPip(ghOffered) }), () => t("gh.done"));
  if (r.ok) $("gh-install").hidden = true;
};
$("gh-link").onsubmit = (e) => {
  e.preventDefault();
  const spec = ghSpec($("gh-link-text").value);
  if (!spec) { $("gh-link-text").setCustomValidity(t("gh.bad_link")); $("gh-link-text").reportValidity(); return; }
  $("gh-link-text").setCustomValidity("");
  $("gh-link-text").value = "";
  $("gh-install").hidden = false;
  openGithub(spec);
};
$("gh-link-text").oninput = () => $("gh-link-text").setCustomValidity("");
// for developers (Emkay Dev mostly sends skills this way): skills are
// installed from the store, so this is under About
$("menu-dev").hidden = !brain.can.install;
$("menu-github").onclick = () => {
  $("about").hidden = true;
  fromMenu.delete("about");
  fromMenu.add("github");
  $("gh-install").hidden = false;
  openGithub();
};
$("github-close").onclick = () => { ghOffered = null; closeView("github"); };

// ------------------------------------------------------- what's happening
// What Emkay heard, understood, answered and sent, live (activity.js, #50);
// it follows the bus from the start, so the last questions are there
const activity = createActivity({ on: (k, fn) => brain.on(k, fn), call, t, $, el });
$("menu-activity").hidden = !brain.can.netlog;   // the OVOS in this browser
// opened from Guardian's card, it goes back there
$("menu-activity").onclick = () => {
  $("network").hidden = true;
  $("menu").hidden = true;
  $("activity").hidden = false;
  activity.show();
};
$("activity-close").onclick = () => {
  activity.hide();
  $("activity").hidden = true;
  $("network").hidden = false;
};

window.emkay = { call, mic, speaker, media, localMedia, wake, room, activity, privacy, releaseMic, stt: () => sttModule };
