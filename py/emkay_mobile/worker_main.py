"""The Python end of the page's Web Worker.

The worker owns everything OVOS: the bus, ovos-core and its skills, ovos-gui,
the small listener/audio halves (speech.py) and the PHAL plugin for the
phone's "hardware" (ovos-phal-plugin-browser). The page owns what only a browser tab can
reach: the screen, the microphone and the speaker.

They talk through postMessage. worker.js calls the functions below; Python
answers through the `js_post(kind, payload, data=None)` callable given to
`start()`. The kinds are:

  "gui"    one GUI-protocol message (JSON) for the visage
  "audio"  speech to play: payload is JSON metadata, data the WAV bytes
  "bus"    one of the few bus events the page reacts to itself
  "phal"   from the browser PHAL plugin: a volume level, or a request
           such as {"request": "location"}
"""
import json
import time

# Emkay's own modules first: importing boot runs browser.install(), which
# puts the stand-ins for native packages (shims/: pexpect, psutil, ...) on
# the path; ovos-utils' security module imports pexpect
from . import boot, browser, gui, listener, local_media, netlog, panel, privacy, speech

import ovos_phal_plugin_browser as phal   # the browser tab as the device

_js_post = None   # set by start(): post(kind, payload[, data])


def _post(kind: str, payload: str, data: bytes = None):
    """Hand something to the page. `data`, if given, arrives as a Uint8Array."""
    if _js_post is None:
        return
    if data is not None:
        from pyodide.ffi import to_js
        _js_post(kind, payload, to_js(data))   # copied into a Uint8Array
    else:
        _js_post(kind, payload)


def _boot_status(key: str, progress: float = None, **variables):
    """A boot step for the start screen (worker.js emkayBootStatus).

    Posted at once, also while Python is busy loading skills: the page is
    another thread, so its bar moves while this one works.
    """
    try:
        import js
        from pyodide.ffi import to_js
        js.emkayBootStatus(key, progress, to_js(variables, dict_converter=js.Object.fromEntries))
    except Exception:   # outside the browser (tests), or an older worker.js
        pass


def start(js_post, user_config=None) -> str:
    """Boot OVOS and wire it to the page; return a JSON summary of the boot."""
    global _js_post
    _js_post = js_post
    try:
        import pyodide_http
        pyodide_http.patch_all()   # requests/urllib through the browser's fetch
        browser.raise_http_errors()  # ... with urllib's HTTPError, as on a device
        browser.mediawiki_cors()     # ... and Wikipedia's API readable from a page
        netlog.install()             # ... each request naming its skill (network log)
    except ImportError:
        pass
    boot.report = _boot_status   # the start screen's bar follows the skills loading
    t = time.time()
    info = boot.start(user_config=user_config)
    print(f"[emkay] core up in {time.time() - t:.1f}s")
    bus = boot.bus()
    boot.report("boot.services", 0)
    t = time.time()
    gui.start(bus, lambda raw: _post("gui", raw))
    print(f"[emkay] gui up in {time.time() - t:.1f}s")
    boot.report("boot.services", 0.3)
    speech.start(bus, lambda wav, meta: _post("audio", json.dumps(meta), wav))
    # the audio transformers (listener.py) load a moment after the start;
    # then the page is told which want the room audio (emkay.room)
    listener.start(bus, lambda names: _post("bus", json.dumps(
        {"type": "emkay.room", "data": {"names": names}})))
    info["room_listeners"] = []
    # your own music from a folder on the device (local_media.py, web/localmedia.js)
    local_media.start(bus, lambda payload: _post("bus", json.dumps(payload)))
    _start_audio_service(bus)
    boot.report("boot.services", 0.6)
    # the phone's "hardware", also kiosk and local only (#23): the skills
    # send hardware-neutral bus messages, the plugin does the browser part
    phal.start(bus, lambda raw: _post("phal", raw), reload_speech=speech.reload)
    from . import phal_extra   # PHAL plugins the user installed (phal_extra.py)
    phal_extra.start(bus)
    boot.report("boot.services", 0.85)
    _report_status(bus)
    remember_speech_settings()   # later changes apply without a restart (_settings_changed)
    # a local STT/TTS (Whisper, Røst, Piper) starts loading its model now, from
    # the phone's cache, so the first question does not wait for it; for
    # server plugins this does nothing
    speech.prewarm()
    info["speech_blocked"] = speech.blocked_parts()   # no JSPI: app.js says so at once
    bus.on("message", _watch)
    # a pipeline plugin installed in the panel is placed in the pipeline
    # and loaded at once (pipeline_place.py)
    from . import pipeline_place
    bus.on("ovos.pip.install.complete", pipeline_place.on_installed)
    pipeline_place.reload_media_providers()   # notes the providers OCP loaded at boot
    info["skipped_waits"] = browser.SKIPPED_WAITS[:]
    return json.dumps(info)


_audio_service = None


def _start_audio_service(bus):
    """ovos-audio's classic AudioService, unchanged: music, radio, podcasts.

    On a device ovos-audio runs it next to speech; here speech is speech.py,
    so only the AudioService is started. Its player is
    ovos-audio-plugin-browser, which plays in the page's <audio> element
    (web/media.js). OCP plays through it (ovos-ocp-pipeline-plugin with
    "legacy": true, boot.py), as do skills that use AudioServiceInterface;
    it ducks the music while OVOS speaks or listens. The classic OCP
    backend (ovos-plugin-common-play) is not installed, so it is off.
    """
    global _audio_service
    t = time.time()
    try:
        from ovos_audio.audio import AudioService
        _audio_service = AudioService(bus, disable_ocp=True)
        names = [s.name for s in _audio_service.service]
        print(f"[emkay] audio service up in {time.time() - t:.1f}s: {names}")
        from . import now_playing   # OCP's "now playing" page (now_playing.py)
        now_playing.start(bus)
    except Exception as e:   # music is a feature; speech must not depend on it
        print(f"[emkay] audio service not started: {e!r}")


#: The device services whose job a part of Emkay does, so they answer the
#: same status questions (ProcessStatus) the services answer on a device:
#: audio and voice (speech.py: playback, listener), gui_service (gui.py),
#: PHAL (ovos-phal-plugin-browser). ovos-core's skills and intents report themselves.
_SERVICES = ("audio", "voice", "gui_service", "PHAL")
_statuses = []


def _report_status(bus):
    """Answer mycroft.<service>.is_alive / is_ready for the parts above."""
    from ovos_utils.process_utils import ProcessStatus
    for name in _SERVICES:
        status = ProcessStatus(name, bus=bus)
        status.set_started()
        status.set_alive()
        status.set_ready()
        _statuses.append(status)


#: Bus events the page reacts to itself (the mic hint, follow-up listening).
#: ovos-audio-plugin-browser's commands to the page's <audio> (web/media.js);
#: the page answers with <prefix>state through core_send
_MEDIA_PREFIX = "ovos.audio.browser."

#: ovos-phal-plugin-midi's sound, when it plays through the bus ("audio": "bus",
#: its default in a browser): played by the page (web/app.js, midiOut)
_MIDI_PCM = "ovos.midi.pcm"

_STATE_TOPICS = {
    "recognizer_loop:wakeword", "recognizer_loop:record_begin",
    "recognizer_loop:record_end", "mycroft.mic.listen",
    "mycroft.mic.mute", "mycroft.mic.unmute",
    "ovos.utterance.handled", "mycroft.skill.handler.complete",
    "emkay.speech.interim",   # speech.py: what speaks or listens while a new model loads
    "emkay.speech.waiting",   # speech.py: the device's speech isn't ready, nothing stands in
    "complete_intent_failure", "ovos.intent.unmatched",
    # ovos-skill-karaoke: the words being sung, for the caption under the face
    "ovos.karaoke.lyrics", "ovos.karaoke.ended",
    # the listener's recording mode, as ovos-dinkum-listener has it: a skill
    # asks the microphone for a recording to a file (ovos-skill-jamband: a
    # hummed melody); the page records, speech.recorded writes it
    "recognizer_loop:state.set", "recognizer_loop:record_stop",
}


#: What the "What's happening?" view follows (web/activity.js, #50), as
#: ovos-tui-client's activity pane does: what was heard, which skill
#: understood it (OVOS' own ovos.intent.matched, with the pipeline), the
#: fallback and common-query rounds, what was said, and Emkay's note when
#: speech falls back to another plugin. A few messages per question.
_ACTIVITY = {
    "recognizer_loop:wakeword", "recognizer_loop:record_begin", "recognizer_loop:utterance",
    "recognizer_loop:speech.recognition.unknown", "emkay.speech.interim",
    "ovos.intent.matched", "complete_intent_failure", "ovos.intent.unmatched",
    "mycroft.skill.handler.error", "question:query", "question:query.response", "question:action",
    "ocp:play", "ovos.common_play.skill.search_end", "mycroft.stop",
    # what was said: the bus mirrors these two (speech.py, _once); the page
    # shows one of a pair
    "speak", "ovos.utterance.speak",
}
_FALLBACK_PREFIX = "ovos.skills.fallback."


def _brief(data: dict) -> dict:
    """The data of a message, without the session and with long texts cut."""
    out = {}
    for k, v in data.items():
        if k in ("session", "context", "__sess"):
            continue
        if isinstance(v, str) and len(v) > 400:
            v = v[:400] + "…"
        out[k] = v
    return out


def servers_meanwhile(remember: str = ""):
    """The user chose OpenVoiceOS' servers until the device's speech is ready
    (app.js, the "waiting" note): for this start only – or, for a language
    with no model on the device, kept for `remember` ("stt"/"tts") (speech.py)."""
    speech.servers_meanwhile(True, remember or "")


def activity_setup() -> str:
    """How Emkay hears and speaks right now (JSON), for the top of the view."""
    from ovos_config import Configuration
    cfg = Configuration()
    stt, tts = cfg.get("stt", {}), cfg.get("tts", {})
    return json.dumps({"stt": stt.get("module"), "stt_fallback": stt.get("fallback_module"),
                       "tts": tts.get("module"), "tts_fallback": tts.get("fallback_module"),
                       "wake_word": cfg.get("listener", {}).get("wake_word"),
                       "lang": cfg.get("lang")})


def _local_file(uri):
    """The bytes of a file:// track (a skill's own audio, e.g. a song
    ovos-skill-karaoke made): it lives in Pyodide's file system, which the
    page's <audio> can't open, so the page gets the bytes (web/media.js)."""
    if not (uri or "").startswith("file://") or uri.startswith("file:///emkay-local/"):
        return None     # (your own music the page plays from its folder: local_media.py)
    from urllib.parse import unquote
    path = unquote(uri[len("file://"):])
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def _watch(raw):
    """Forward the bus events in _STATE_TOPICS to the page."""
    try:
        msg = json.loads(raw) if isinstance(raw, str) else raw.serialize()
    except Exception:
        return
    t = msg.get("type") if isinstance(msg, dict) else None
    if t == _MIDI_PCM:   # the synth's sound: for the page's player alone (big, many a second)
        _post("bus", json.dumps({"type": t, "data": msg.get("data", {})}))
        return
    if _core_open or _dev_stream:   # the visage's bus socket (and Emkay Dev) get everything
        _post("core", raw if isinstance(raw, str) else raw.serialize())
    if t in _ACTIVITY or ((t or "").startswith(_FALLBACK_PREFIX) and t.endswith((".start", ".response"))):
        _post("activity", json.dumps({"type": t, "data": _brief(msg.get("data") or {}),
                                      "skill_id": (msg.get("context") or {}).get("skill_id")},
                                     default=str))
    if t == _MEDIA_PREFIX + "play":
        _post("bus", json.dumps({"type": t, "data": msg.get("data", {})}),
              _local_file(msg.get("data", {}).get("uri")))
    elif t in _STATE_TOPICS or (t or "").startswith(_MEDIA_PREFIX) and t != _MEDIA_PREFIX + "state":
        _post("bus", json.dumps({"type": t, "data": msg.get("data", {})}))
    elif t in ("configuration.updated", "configuration.patch", "configuration.patch.clear"):
        # the page's own texts follow OVOS' language (web/i18n.js); read it
        # once ovos-config's handler has applied the change (the control
        # panel sends configuration.patch, a PHAL plugin .updated)
        import asyncio
        asyncio.get_event_loop().call_soon(_post_lang)
        asyncio.get_event_loop().call_soon(_settings_changed)


#: the speech settings as last applied (_speech_settings()), to see what a
#: configuration change touched; None until the first change after boot
_applied = None


def _speech_settings() -> dict:
    """The settings that decide how Emkay hears and speaks."""
    from ovos_config import Configuration
    cfg = Configuration()
    ww = cfg.get("listener", {}).get("wake_word")
    return {"lang": cfg.get("lang", "en-US"),
            "stt": json.dumps(cfg.get("stt", {}), sort_keys=True),
            "tts": json.dumps(cfg.get("tts", {}), sort_keys=True),
            "wake_word": ww,
            "hotword": json.dumps(cfg.get("hotwords", {}).get(ww or "", {}), sort_keys=True),
            "room": json.dumps(cfg.get("listener", {}).get("audio_transformers") or {}, sort_keys=True)}


def remember_speech_settings():
    """At boot: what is in use now."""
    global _applied
    _applied = _speech_settings()


def _settings_changed():
    """A configuration change (the control panel, a skill, a PHAL plugin):
    apply what it did to speech without a restart, as ovos-dinkum-listener
    and ovos-audio do on a device.

    - another language: skills and intents load for the language at boot, as
      on a device; the page offers the restart (app.js languageChanged), and
      speech reloads now so the new language's models download meanwhile
    - another STT or TTS: speech.reload() keeps the ones in use until the new
      ones work, and prewarm() starts their download now (the page shows it)
    - another wake word, or its settings: the page starts its engine again
    - other audio transformers (listener.audio_transformers): loaded again,
      and the page told which want the room audio now
    """
    global _applied
    if _applied is None:
        return
    new = _speech_settings()
    old, _applied = _applied, new
    if new["lang"] != old["lang"]:
        # skills and intents follow at the next start, which the page offers
        # (app.js languageChanged: the "restart to use" button); speech is
        # reloaded now, so the new language's voice and recognition models
        # are fetched meanwhile
        print(f"[emkay] language {old['lang']} -> {new['lang']}")
        # not the previous voice meanwhile: it speaks the old language
        speech.reload(keep_previous=False)
        speech.prewarm()
    elif new["stt"] != old["stt"] or new["tts"] != old["tts"]:
        print("[emkay] speech settings changed: new STT/TTS from the next use")
        speech.reload(keep_previous=True)
        speech.prewarm()
    if new.get("room") != old.get("room"):
        names = listener.reload()
        _post("bus", json.dumps({"type": "emkay.room", "data": {"names": [p.name for p in names]}}))
    if new["wake_word"] != old["wake_word"] or new["hotword"] != old["hotword"]:
        from ovos_config import Configuration
        print(f"[emkay] wake word: {new['wake_word']}")
        _post("bus", json.dumps({"type": "emkay.wakeword", "data": {
            "wake_word": new["wake_word"],
            "hotword": Configuration().get("hotwords", {}).get(new["wake_word"] or "", {})}}))


def _post_lang():
    from ovos_config import Configuration
    _post("bus", json.dumps({"type": "emkay.lang",
                             "data": {"lang": Configuration().get("lang", "en-US"),
                                      "stt_module": Configuration().get("stt", {}).get("module"),
                                      # the privacy chip follows a change in the panel (web/privacy.js)
                                      "speech_route": privacy.route()}}))


# --- calls from the page -------------------------------------------------

def gui_message(raw: str):
    """A GUI-protocol message from the screen (focus, page events)."""
    gui.client().from_page(raw)


# --- the visage (ovos-gui-visage, Flutter web build) ---------------------
#
# It opens two websockets on a device: the core messagebus and ovos-gui's
# legacy GUI socket (web/visage2-shim.js stands in for both). The GUI socket
# is ovos-gui's stream (gui.py's BrowserGuiClient); the bus socket is every
# bus message, both ways, while it is open.

_core_open = False
_dev_stream = False   # Emkay Dev follows the bus too (dev_enable)


def core_open(is_open: bool = True):
    """The new visage's bus socket opened (or closed)."""
    global _core_open
    _core_open = bool(is_open)


def core_send(raw: str):
    """A message the new visage put on the bus, emitted as any bus client's is."""
    from ovos_bus_client.message import Message
    from .browser import hand_over
    msg = Message.deserialize(raw)
    hand_over(lambda: boot.bus().emit(msg))


def gui_sync():
    """A GUI socket (re)connected: replay ovos-gui's state to it, as
    GUIWebsocketHandler.open() does for a new connection."""
    from ovos_gui.bus import GUIWebsocketHandler
    GUIWebsocketHandler.synchronize(gui.client())


def res_file(path: str):
    """A file for the new visage's res/ (ovos-gui's cache, `cache=True`) or
    res-abs/ (an absolute path) route; None if there is no such file."""
    import os
    from pyodide.ffi import to_js
    if path.startswith("res/"):
        from ovos_gui.constants import GUI_CACHE_PATH
        full = os.path.join(GUI_CACHE_PATH, path[4:])
    elif path.startswith("res-abs/"):
        full = "/" + path[8:].lstrip("/")
    else:
        return None
    full = os.path.normpath(full)
    if not os.path.isfile(full):
        return None
    with open(full, "rb") as f:
        return to_js(f.read())


def say(text: str):
    """Typed input: handled exactly like a spoken utterance."""
    from .browser import hand_over
    hand_over(lambda: boot.utterance(text))


def wakeword(name: str):
    """The page heard the wake word: tell OVOS as ovos-dinkum-listener does."""
    boot.emit("recognizer_loop:wakeword", {"utterance": name, "engine": "openwakeword (browser)"})


def record_begin():
    """The page started recording: tell OVOS, so the face starts listening."""
    boot.emit("recognizer_loop:record_begin")


def _bytes(b):
    return b.to_bytes() if hasattr(b, "to_bytes") else bytes(b)


def local_media_listing(folder: str, entries: str, keep=True) -> str:
    """The page's music folder (JSON list of its audio files): what to read
    of the new and changed ones, for their tags (local_media.py)."""
    return local_media.listing(str(folder), str(entries), bool(keep))


def local_media_tags(path: str, head, tail):
    local_media.tags(str(path), _bytes(head), _bytes(tail))


def local_media_done(keep=True):
    local_media.done(bool(keep))


def local_media_page(state: str):
    local_media.page_state(str(state))


def local_media_forget():
    local_media.forget()


def room_audio(pcm16):
    """Room audio while the page waits for the wake word, for the audio
    transformers (listener.room, dinkum's feed_audio): 16 kHz 16-bit mono."""
    listener.room(pcm16.to_bytes() if hasattr(pcm16, "to_bytes") else bytes(pcm16))


def heard(pcm16, sample_rate=16000) -> str:
    """A finished recording: run STT and hand the text to OVOS.

    `pcm16` is a JS Uint8Array of 16-bit little-endian mono samples.
    Returns the transcription ("" if nothing was understood).
    """
    data = pcm16.to_bytes() if hasattr(pcm16, "to_bytes") else bytes(pcm16)
    return speech.heard(data, int(sample_rate))


def sound_bytes(uri: str):
    """A sound file's bytes for the page (the confirm-listening sound)."""
    from pyodide.ffi import to_js
    return to_js(speech.sound_bytes(uri))


# --- Emkay Dev (?dev, dev.py): a skill from VS Code ----------------------

def dev_enable() -> str:
    global _dev_stream
    from . import dev
    _dev_stream = True
    return dev.enable(_post)


async def dev_load(skill_id: str, files_json: str, requirements_json: str = "[]",
                   kind: str = "skill", entry: str = "") -> str:
    from . import dev
    if kind == "plugin":
        return await dev.load_plugin(skill_id, entry, files_json, requirements_json)
    return await dev.load(skill_id, files_json, requirements_json)


def dev_unload(skill_id: str, restore: bool = True) -> str:
    from . import dev
    return dev.unload(skill_id, restore=restore)


def dev_lang() -> str:
    from . import dev
    return dev.language()


def dev_skills() -> str:
    from . import dev
    return dev.skills()


async def dev_test(row_json: str) -> str:
    from . import dev
    return await dev.test(row_json)


async def dev_translate(lang: str, files_json: str) -> str:
    """Add language (Emkay Dev): a skill's en-US files translated here (translate.py)."""
    from . import translate
    return await translate.translate_files(lang, files_json)


# --- skills from GitHub (?install=github:owner/repo, app.js; github.py) ----

async def _pip(topic: str, data: dict, timeout: float = 600) -> dict:
    """Ask ovos-core's installer (SkillsStore) over the bus, as the control
    panel does, and wait for its answer: {ok, error, detail}."""
    import asyncio
    from ovos_bus_client.message import Message
    from .browser import hand_over
    bus = boot.bus()
    done, answer = asyncio.Event(), {}

    def finished(ok):
        def handler(message):
            if not done.is_set():
                answer.update(ok=ok, error=message.data.get("error", ""),
                              detail=message.data.get("detail", ""))
                done.set()
        return handler

    good, bad = finished(True), finished(False)
    bus.on(f"{topic}.complete", good)
    bus.on(f"{topic}.failed", bad)
    try:
        hand_over(lambda: bus.emit(Message(topic, data)))
        await asyncio.wait_for(done.wait(), timeout)
    except asyncio.TimeoutError:
        answer.update(ok=False, error="timeout", detail="")
    finally:
        bus.remove(f"{topic}.complete", good)
        bus.remove(f"{topic}.failed", bad)
    return answer


async def gh_install(spec: str) -> str:
    """Install `git+https://github.com/owner/repo[@ref]` (also an update:
    a newer commit replaces the one installed). JSON {ok, error, detail}."""
    from . import github
    if not github.parse(spec):
        return json.dumps({"ok": False, "error": "not a GitHub repository", "detail": spec})
    return json.dumps(await _pip("ovos.pip.install", {"packages": [spec]}))


async def gh_remove(name: str) -> str:
    """Uninstall a package installed from GitHub. JSON {ok, error, detail}."""
    from . import github
    if name not in {d["name"] for d in github.installed()}:
        return json.dumps({"ok": False, "error": "not installed from GitHub", "detail": name})
    return json.dumps(await _pip("ovos.pip.uninstall", {"packages": [name]}))


def gh_installed() -> str:
    """JSON list of what was installed from GitHub (github.installed)."""
    from . import github
    return json.dumps(github.installed())


def recorded(pcm16, sample_rate=16000, name="") -> str:
    """The page recorded for the listener's recording mode (a skill asked:
    recognizer_loop:state.set "recording"): to a file, no STT (speech.recorded)."""
    data = pcm16.to_bytes() if hasattr(pcm16, "to_bytes") else bytes(pcm16)
    return speech.recorded(data, int(sample_rate), str(name))


def heard_text(text: str) -> str:
    """Text the browser's own speech recognition heard (ovos-stt-plugin-browser):
    on to OVOS as any STT result goes (speech.heard after its STT step)."""
    return speech.heard_text(text)


def playback_started(ident: str, visemes_json: str = "[]"):
    """The page started playing speech `ident`: the face starts talking."""
    speech.playback_started(ident, json.loads(visemes_json))


def playback_ended(ident: str):
    """The page finished playing speech `ident`."""
    speech.playback_ended(ident)


def phal_position(lat=None, lon=None, error=None):
    """The browser's geolocation answer, for the PHAL plugin (ovos-phal-plugin-browser)."""
    if phal.plugin() is not None:
        phal.plugin().on_position(lat, lon, error)


def phal_event(event, data_json):
    """A change the page saw for the PHAL plugin: online, sensor, picture,
    camera (ovos-phal-plugin-browser)."""
    if phal.plugin() is not None:
        phal.plugin().on_page_event(event, json.loads(data_json))


async def panel_request(method, path, query, headers_json, body):
    """One request for the stock settings panel (see panel.py and sw.js).

    Returns a JS object {status, headers: [[k, v], ...], body: Uint8Array}.
    """
    import js
    from pyodide.ffi import to_js
    status, headers, data = await panel.request(method, path, query, headers_json, body)
    return to_js({"status": status, "headers": json.loads(headers), "body": to_js(data)},
                 dict_converter=js.Object.fromEntries)


def skipped_threads() -> str:
    """Names of the threads that were deferred or left out (diagnostics)."""
    return json.dumps(browser.STARTED)
