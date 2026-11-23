// SPDX-License-Identifier: Apache-2.0
/**
 * The page side of ovos-audio-plugin-browser: music, radio and podcasts.
 *
 * ovos-audio's AudioService runs in the worker, unchanged, with the
 * browser backend (ovos-audio-plugin-browser) as its player. The backend
 * sends ovos.audio.browser.{play,pause,resume,stop,seek,volume}; this
 * module plays them in one <audio> element and answers with
 * ovos.audio.browser.state: playing, paused, ended or error, with the
 * position and length in milliseconds. The protocol is in the plugin's
 * README, so another page (or a browser on a real OVOS device) can do the
 * same.
 *
 * Why <audio> and not the AudioContext the speech uses: <audio> plays a
 * stream from another site without that site's permission (CORS); routing
 * it through Web Audio would make such a stream silent. So the volume is
 * set on the element instead: the PHAL plugin's level (the "mixer"), times
 * the backend's duck factor while OVOS speaks or listens.
 *
 * What it cannot play: an http:// stream, because the page is https
 * (browsers block such "mixed content"). That is reported as an error with
 * a plain reason, and OCP goes on with the next result.
 */

const PREFIX = "ovos.audio.browser.";
// your own music (web/localmedia.js): played from the folder, not Pyodide's files
const LOCAL = "file:///emkay-local/";
const POSITION_EVERY = 5000;   // ms between position reports while playing

/**
 * @param {(type: string, data: object) => void} send - put a message on the bus
 * @param {{resolve?: (uri: string) => Promise<Blob|null>}} [opts] - resolve: the
 *   file for a file:///emkay-local/ track (your own music, web/localmedia.js)
 * @returns {{onBus(msg): boolean, setLevel(level): void}}
 */
export function createMediaPlayer(send, { resolve } = {}) {
  const audio = new Audio();
  audio.preload = "auto";
  let level = { volume: 0.75, muted: false };
  let factor = 1;          // ducking, from the backend
  let uri = null;          // what the backend asked for; null when stopped
  let blobUrl = null;      // a file:// track's bytes, as the page can play them
  let lastReport = 0;

  const ms = (s) => (Number.isFinite(s) ? Math.round(s * 1000) : 0);
  const applyVolume = () => {
    audio.volume = level.muted ? 0 : Math.max(0, Math.min(1, level.volume * factor));
  };
  const report = (state, extra = {}) => {
    if (!uri) return;      // stopped: nothing to tell
    lastReport = Date.now();
    send(PREFIX + "state", {
      uri, state,
      position_ms: ms(audio.currentTime),
      length_ms: ms(audio.duration),   // 0 for a live stream (Infinity)
      ...extra,
    });
  };
  const why = () => {
    if (uri?.startsWith("http:") && location.protocol === "https:")
      return "an https page cannot play an http:// stream (mixed content)";
    const code = audio.error?.code;
    return ({ 1: "aborted", 2: "network error", 3: "could not decode",
              4: "format not supported or not found" })[code] || audio.error?.message || "unknown";
  };

  audio.addEventListener("playing", () => report("playing"));
  audio.addEventListener("pause", () => { if (uri && !audio.ended) report("paused"); });
  audio.addEventListener("ended", () => { report("ended"); uri = null; });
  audio.addEventListener("error", () => { if (uri && audio.getAttribute("src")) { report("error", { error: why() }); uri = null; } });
  audio.addEventListener("timeupdate", () => {
    if (!audio.paused && Date.now() - lastReport > POSITION_EVERY) report("playing");
  });

  const dropBlob = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; };
  const MIME = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg",
                 opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4" };

  /** `bytes`: a file:// track's content, read for us in the worker. */
  function play({ uri: next, position_ms = 0 }, bytes) {
    uri = next;
    dropBlob();
    if (next?.startsWith(LOCAL) && resolve) {
      // your own music: the file from the folder, played where it is
      resolve(next).then((file) => {
        if (uri !== next) return;           // a newer play or a stop came first
        if (!file) { report("error", { error: "the song's folder is not open: allow the music folder" }); uri = null; return; }
        blobUrl = URL.createObjectURL(file);
        begin(next, position_ms);
      }).catch((e) => { if (uri === next) { report("error", { error: e.message || e.name }); uri = null; } });
      return;
    }
    if (bytes) {
      const ext = next.split("?")[0].split(".").pop().toLowerCase();
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || "" }));
    }
    begin(next, position_ms);
  }
  function begin(next, position_ms) {
    audio.src = blobUrl || next;
    if (position_ms) audio.currentTime = position_ms / 1000;
    audio.play().catch((e) => {
      // NotAllowedError: the browser wants a tap first; AbortError: a newer
      // play or stop came first (nothing to report then)
      if (e.name !== "AbortError" && uri === next) { report("error", { error: e.message || e.name }); uri = null; }
    });
  }
  function stop() {
    uri = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();          // drops the stream's connection
    dropBlob();
  }

  return {
    /** Handle an ovos.audio.browser.* message (`data`: a file:// track's
     * bytes, if the worker read them); true when it was one. */
    onBus(msg, data) {
      if (!msg.type?.startsWith(PREFIX) || msg.type === PREFIX + "state") return false;
      const d = msg.data || {};
      switch (msg.type.slice(PREFIX.length)) {
        case "play": play(d, data); break;
        case "pause": audio.pause(); break;
        case "resume": if (uri) audio.play().catch(() => {}); break;
        case "stop": stop(); break;
        case "seek": if (uri) audio.currentTime = (d.position_ms || 0) / 1000; break;
        case "volume": factor = d.ducked ? (d.factor ?? 0.3) : 1; applyVolume(); break;
        default: return false;
      }
      return true;
    },
    /** The PHAL plugin's {volume: 0..1, muted}, the same as for speech. */
    setLevel(l) { level = l; applyVolume(); },
    /** What is playing, for debugging and the browser tests. */
    state: () => ({ uri, paused: audio.paused, ended: audio.ended,
                    volume: audio.volume, position_ms: ms(audio.currentTime) }),
  };
}
