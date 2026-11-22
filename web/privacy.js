// Emkay – the privacy chip: where Emkay hears, speaks and thinks, in the
// corner by ⚙, with an Emkay-style icon (its eyes in the place they are):
//
//   on this device   the eyes in a phone/capsule   (Emkay's default)
//   in your home     the eyes in a house           (an Emkay Home, Home
//                                                   Assistant, or a server
//                                                   of your own on the LAN)
//   elsewhere        the eyes in a cloud, amber    (a server on the
//                                                   internet, or the browser's
//                                                   own speech service)
//
// At rest it is only the icon, faint: the place everything goes to, the
// "furthest" of the three. While Emkay listens (after the wake word) or
// speaks it opens up with a word on where that goes; when that is
// elsewhere it is amber and stays a moment longer. The wake word itself is
// always on the device and gets no marker of its own.
//
// A tap opens ⚙ → Settings, where the same three lines sit at the top above
// the settings that change them (where Emkay thinks, the control panel).
//
// Where things go comes from the brain: the local OVOS says which speech
// plugins it uses and their servers (py/emkay_mobile/privacy.py,
// `speech_route`), a house brain says it itself (`privacy` in its boot
// info). When the local speech falls back to its fallback plugin – a model
// on the device not downloaded yet – the chip shows that fallback until the
// model is ready (emkay.speech.interim, as the model status line does).

import { place } from "./activity.js";

const EYES = (cx, cy, r = 7, gap = 13) => `<g fill="none" stroke-width="4" stroke-linecap="round">
  <circle cx="${cx - gap}" cy="${cy}" r="${r}" stroke="#555"/><path d="M${cx - gap - r} ${cy}a${r} ${r} 0 0 1 ${2 * r} 0" stroke="currentColor"/>
  <circle cx="${cx + gap}" cy="${cy}" r="${r}" stroke="#555"/><path d="M${cx + gap - r} ${cy}a${r} ${r} 0 0 1 ${2 * r} 0" stroke="currentColor"/></g>`;

/** The three icons, 64×64, in the menu icons' style (white lines, Emkay's eyes). */
export const ICONS = {
  device: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="14" y="6" width="36" height="52" rx="12"
    fill="none" stroke="currentColor" stroke-width="4.5"/>${EYES(32, 30, 5.5, 8)}
    <path d="M27 44q5 3.5 10 0" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`,
  house: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 30 L32 9 L56 30 V55 H8 Z" fill="none"
    stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/>${EYES(32, 38, 5.5, 9)}</svg>`,
  external: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 50 H48 A12 12 0 0 0 48 26 A16 16 0 0 0 18 24
    A13 13 0 0 0 18 50 Z" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/>${EYES(33, 38, 5, 8)}</svg>`,
};

const RANK = { device: 0, house: 1, external: 2 };

/** A host name or URL → its host name ("" when there is none). */
function hostOf(s) {
  if (!s) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname; } catch { return ""; }
}

/** A host on the house's own network: a name without dots, .local and the
 * like, or a private address. */
export function isHomeHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (!h.includes(".") && !h.includes(":")) return true;
  if (/\.(local|lan|home|home\.arpa|internal|localdomain)$/.test(h) || h === "localhost") return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return /^(::1|f[cd][0-9a-f]{2}:|fe80:)/.test(h);
}

/**
 * One part ({what, host}) for a local speech plugin ({module, hosts}).
 * what: device | house | own | ha | browser | server | public
 */
export function speechPart(p) {
  if (!p?.module) return null;
  const kind = place(p.module);                     // activity.js: device, browser, server
  if (kind === "device") return { what: "device" };
  if (kind === "browser") return { what: "browser" };
  const hosts = (p.hosts || []).map(hostOf).filter(Boolean);
  if (!hosts.length) return { what: "public" };     // a server plugin on its own default (OVOS') servers
  // Emkay served from the house: its servers are the house
  const fromHouse = !/(^|\.)emkay\.ai$/.test(location.hostname) && hosts.every((h) => h === location.hostname);
  if (fromHouse) return { what: "house", host: hosts[0] };
  if (hosts.every(isHomeHost)) return { what: "own", host: hosts[0] };
  return { what: "server", host: hosts.find((h) => !isHomeHost(h)) };
}

/** device | house | external, for a part. */
export function whereOf(part) {
  if (!part || part.what === "device") return "device";
  return ["house", "own", "ha"].includes(part.what) ? "house" : "external";
}

/**
 * @param {object} o
 * @param {(key: string, vars?: object) => string} o.t
 * @param {(id: string) => HTMLElement} o.$
 * @param {() => void} o.openSettings   opens ⚙ → Settings
 */
export function createPrivacy({ t, $, openSettings }) {
  const chip = $("privacy-chip");
  const rows = $("privacy-rows");
  let parts = { hear: { what: "device" }, voice: { what: "device" }, think: { what: "device" } };
  let route = null;              // the local OVOS' speech_route
  const fallback = {};           // stt/tts -> the fallback part in use meanwhile
  let active = null;             // "hear" | "voice" while listening or speaking
  let closeTimer = null;
  let roomListeners = [];        // audio transformers listening to the room (on this device)

  const label = (part) => {
    switch (part?.what) {
      case "house": return t("privacy.house");
      case "ha": return t("privacy.ha");
      case "own": return t("privacy.own", { host: part.host });
      case "browser": return t("privacy.browser");
      case "public": return t("privacy.public");
      case "server": return t("privacy.external", { host: part.host });
      default: return t("privacy.device");
    }
  };

  /** What is in use now: the configured part, or its fallback meanwhile. */
  const now = (k) => (k === "hear" && fallback.stt) || (k === "voice" && fallback.tts) || parts[k];

  function render() {
    const all = ["hear", "voice", "think"].map(now);
    const shown = active ? now(active) : all.reduce((a, b) => (RANK[whereOf(b)] > RANK[whereOf(a)] ? b : a));
    const where = whereOf(shown);
    chip.innerHTML = `${ICONS[where]}<span class="privacy-label"></span>`;
    chip.querySelector(".privacy-label").textContent = label(shown);
    chip.className = `privacy-chip ${where}${active ? " open" : ""}`;
    chip.setAttribute("aria-label", `${t("privacy.chip")}: ${label(shown)}`);
    rows.replaceChildren(...["hear", "voice", "think"].map((k) => {
      const p = now(k), row = document.createElement("div");
      row.className = `privacy-row ${whereOf(p)}`;
      row.innerHTML = `${ICONS[whereOf(p)]}<span><b></b><small></small></span>`;
      row.querySelector("b").textContent = t(`privacy.${k}`);
      row.querySelector("small").textContent = label(p);
      return row;
    }), Object.assign(document.createElement("p"), { className: "small privacy-wake", textContent: t("privacy.wake") }),
    ...(roomListeners.length ? [Object.assign(document.createElement("p"), {
      className: "small privacy-room", textContent: t("privacy.room") })] : []));
    chip.classList.toggle("room", roomListeners.length > 0);
  }

  chip.onclick = () => openSettings();

  return {
    /** From the brain's boot info: `privacy` (a house brain) or `speech_route` (the local OVOS). */
    boot(info) {
      if (info.privacy) parts = { ...parts, ...info.privacy };
      if (info.speech_route) this.route(info.speech_route);
      else render();
      chip.hidden = false;
    },
    /** The local OVOS' speech settings, at boot and after a change in the panel. */
    route(r) {
      if (!r) return;
      route = r;
      delete fallback.stt; delete fallback.tts;
      parts = { ...parts, hear: speechPart(r.stt) || parts.hear, voice: speechPart(r.tts) || parts.voice };
      render();
    },
    /** The audio transformers listening to the room (listener.py), at boot and after a change. */
    room(names) {
      roomListeners = names || [];
      render();
    },
    /** emkay.speech.interim: a fallback plugin listens or speaks meanwhile. */
    interim({ what, using, module }) {
      if (!route || !module) return;
      // the fallback plugin, or the plugin from before a settings change
      const p = using === "fallback" ? route[`${what}_fallback`] : null;
      fallback[what] = speechPart(p?.module === module ? p : { module, hosts: [] });
      render();
    },
    /** A model on the device is ready: it takes over from the fallback. */
    ready(what) {
      if (!fallback[what]) return;
      delete fallback[what];
      render();
    },
    /** Listening ("hear") or speaking ("voice") starts (true) or ends (false). */
    active(kind, on) {
      clearTimeout(closeTimer);
      if (on) { active = kind; render(); return; }
      if (active !== kind) return;
      // elsewhere: open a moment longer, so it can't be missed
      closeTimer = setTimeout(() => { active = null; render(); },
        whereOf(now(kind)) === "external" ? 2500 : 800);
    },
    render,
  };
}
