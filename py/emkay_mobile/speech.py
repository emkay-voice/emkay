"""The two halves a device runs outside ovos-core, in their smallest form.

ovos-dinkum-listener: the page records an utterance (the browser owns the
microphone) and hands over 16 kHz mono PCM; the configured STT plugin turns it
into text, which goes on the bus as recognizer_loop:utterance.

ovos-audio: on "speak", the dialog transformers may rewrite the sentence,
the configured TTS plugin makes a WAV and the TTS transformers may change it;
the page plays it (the browser owns the speaker). The transformers are
ovos-audio's own services (ovos_audio.transformers), run where ovos-audio
runs them. The page reports when playback starts
and ends, and this side emits the same bus events ovos-audio does, so the
GUI face listens, talks and rests like on a device.

Both plugins come from mycroft.conf through the plugin manager, exactly as on
a device, so the installer default (public ovos-stt/tts servers) and anything
the setup page writes are used unchanged.
"""
import os
import re
import tempfile
import time

_stt = None
_tts = None
_post_audio = None   # callable(wav_bytes, meta_dict) into the page
_pending = {}        # ident -> speak message, while the page plays it
_dialog_tx = None    # ovos-audio's DialogTransformersService
_tts_tx = None       # ovos-audio's TTSTransformersService


def _config():
    from ovos_config import Configuration
    return Configuration()


#: the module names of the plugins made by stt() and tts(), so a plugin kept
#: as `_previous` after a settings change is known by name
_names = {"stt": None, "tts": None}


def stt():
    global _stt
    if _stt is None:
        from ovos_plugin_manager.stt import OVOSSTTFactory
        _stt = OVOSSTTFactory.create(_config())
        _names["stt"] = _config().get("stt", {}).get("module")
    return _stt


def tts():
    global _tts
    if _tts is None:
        from ovos_plugin_manager.tts import OVOSTTSFactory
        _tts = OVOSTTSFactory.create(_config())
        _names["tts"] = _config().get("tts", {}).get("module")
    return _tts


#: the plugins that run on the device itself; anything else talks to a server
_ON_DEVICE = ("ovos-stt-plugin-whisper-browser", "ovos-tts-plugin-piper-browser")


def _keep_previous(what: str) -> bool:
    """The plugin from before a settings change may go on listening or
    speaking while the new one gets ready – if it runs on the device. One
    that talks to a server is not kept silently (defaults v15): it may only
    stand in like the servers do (_stand_in)."""
    name = _previous_names.get(what)
    return name in _ON_DEVICE or (name is not None and _servers_meanwhile)


def transformers():
    """ovos-audio's two transformer stages, loaded once as ovos-audio does.

    Like on a device they read `dialog_transformers` and `tts_transformers`
    from mycroft.conf when the audio service starts; a newly installed or
    enabled transformer is used after a restart (here: a reload of the page).
    """
    global _dialog_tx, _tts_tx
    if _dialog_tx is None:
        from ovos_audio.transformers import DialogTransformersService, TTSTransformersService
        from . import boot
        _dialog_tx = DialogTransformersService(boot.bus())
        _tts_tx = TTSTransformersService(boot.bus())
    return _dialog_tx, _tts_tx


_fallback = None
#: the plugins in use before a settings change (reload(keep_previous=True)):
#: they speak and listen until the new ones work, e.g. while a new local
#: model downloads, so switching from one local model to another needs no
#: server meanwhile
_previous = {"stt": None, "tts": None}
_previous_names = {"stt": None, "tts": None}
_interim_said = set()   # ("tts", "previous") etc. already told the page since the last reload


def _interim(what: str, using: str, module: str = None):
    """Tell the page, once per change, what speaks or listens meanwhile:
    `using` is "previous" (the plugin from before the change) or "fallback"
    (`<what>.fallback_module`, named in `module`). app.js shows it under the
    download progress."""
    if (what, using) in _interim_said:
        return
    _interim_said.add((what, using))
    try:
        from ovos_bus_client.message import Message
        from . import boot
        boot.bus().emit(Message("emkay.speech.interim",
                                {"what": what, "using": using, "module": module}))
    except Exception as e:
        print(f"[emkay] interim not shown: {e!r}")


class SpeechNotReady(Exception):
    """The device's own speech can't be used yet (its model still
    downloading, or the download failed) and nothing was chosen to stand in."""


#: The user tapped "use OpenVoiceOS' servers until it's ready" (the page,
#: servers_meanwhile()): the public servers stand in for the device's speech
#: while it isn't ready, until the page is loaded again. Never saved – a new
#: start asks again.
_servers_meanwhile = False


def servers_meanwhile(on: bool = True, remember: str = ""):
    """on: the servers stand in while the device's speech isn't ready, this
    start only. remember ("stt", "tts" or both, "stt,tts"): the device can't
    do that – no model for the user's language, or a browser that can't run
    the models at all – and they chose the servers for it: kept as that
    part's `fallback_module`, so the next start doesn't ask again (the
    control panel can change it)."""
    global _servers_meanwhile
    _servers_meanwhile = bool(on)
    parts = [p for p in (remember or "").split(",") if p in ("stt", "tts")]
    if parts:
        from . import boot
        boot.write_user_config({p: {"fallback_module": f"ovos-{p}-plugin-server"} for p in parts})
    print(f"[emkay] servers meanwhile: {_servers_meanwhile}" + (f", kept for {remember}" if remember else ""))


def jspi() -> bool:
    """True when this browser has JavaScript Promise Integration (worker.js
    emkayJSPI). Whisper and Piper on the device wait for whisper.js and
    piper.js (pyodide's run_sync), which needs it: without it (Safari before
    27, for one) they can't run at all, however long one waits. Outside a
    browser (tests) there is nothing to miss."""
    try:
        import js
    except ImportError:
        return True
    return bool(getattr(js, "emkayJSPI", True))


class NoJSPI(RuntimeError):
    """This browser can't run the device's own speech (no JSPI)."""


def _blocked(what: str) -> bool:
    """The configured plugin runs on the device, and this browser can't run it."""
    return _config().get(what, {}).get("module") in _ON_DEVICE and not jspi()


def blocked_parts() -> list:
    """The parts ("stt", "tts") this browser can't run on the device, with no
    stand-in chosen for them yet: the page says so at the first tap (app.js
    speechWait), before anyone speaks to an Emkay that can't hear."""
    return [w for w in ("stt", "tts")
            if _blocked(w) and not _config().get(w, {}).get("fallback_module")]


def _check_browser(what: str):
    """Raise NoJSPI before the device's own plugin is even made or called
    where the browser can't run it: Whisper and Piper start downloading their
    model on first use, which here would only cost data and memory."""
    if _blocked(what):
        raise NoJSPI(f"this browser can't run {what} on the device (no JSPI)")


def _reason(what: str, lang: str) -> str:
    """Why the device's own plugin can't do it: "browser" when this browser
    can't run Emkay's speech on the device at all (no JSPI), "language" when
    Emkay has no model on the device for this language at all (a Piper voice,
    a Whisper language), else "loading" (still downloading, or the download
    failed)."""
    cfg = _config().get(what, {})
    if _blocked(what):
        return "browser"
    base = (lang or "en").split("-")[0].lower()
    try:
        if what == "tts" and cfg.get("module") == "ovos-tts-plugin-piper-browser":
            from ovos_tts_plugin_piper_browser import voice_for
            if not voice_for(lang):
                return "language"
        if what == "stt" and cfg.get("module") == "ovos-stt-plugin-whisper-browser":
            from ovos_stt_plugin_whisper_browser import LANGUAGES, MODELS
            if base not in LANGUAGES and base not in MODELS:
                return "language"
    except Exception:
        pass
    return "loading"


def _waiting(what: str, error: Exception, utterance: str = ""):
    """Tell the page the device's speech isn't ready (emkay.speech.waiting):
    it shows that, offers the servers for the moment (or, for a language
    with no model on the device, for good), and shows a sentence that
    couldn't be spoken as text."""
    try:
        from ovos_bus_client.message import Message
        from . import boot
        lang = _config().get("lang", "en-US")
        boot.bus().emit(Message("emkay.speech.waiting",
                                {"what": what, "utterance": utterance, "error": repr(error),
                                 "reason": _reason(what, lang), "lang": lang}))
    except Exception as e:
        print(f"[emkay] waiting not shown: {e!r}")


def _stand_in(what: str):
    """The plugin that may stand in when the configured one fails: one the
    user chose as `<what>.fallback_module`, or – only after "use the servers
    meanwhile" – OpenVoiceOS' public servers. None: nothing may (since
    defaults v15 the servers are no longer a silent fallback)."""
    cfg = _config().get(what, {})
    name = cfg.get("fallback_module") or ""
    if name and name != cfg.get("module"):
        return name
    if _servers_meanwhile:
        return f"ovos-{what}-plugin-server"
    return None


def _get_tts(utterance, path, lang):
    """The configured TTS; if it fails, the plugin from before the last
    settings change, else a stand-in (_stand_in), as ovos-audio does with its
    fallback. A plugin that runs on the phone (Piper) can fail where a server
    plugin does not: its voice still downloading, no network for that first
    download, a language it has no voice for. With no stand-in it raises
    SpeechNotReady."""
    global _fallback
    try:
        _check_browser("tts")
        out = tts().get_tts(utterance, path, lang=lang)
        _previous["tts"] = None      # the new one works: the old one can go
        return out
    except Exception as e:
        if _previous["tts"] is not None and _keep_previous("tts"):
            print(f"[emkay] tts failed ({e!r}); the previous TTS speaks meanwhile")
            _interim("tts", "previous", _previous_names["tts"])
            return _previous["tts"].get_tts(utterance, path, lang=lang)
        cfg = _config().get("tts", {})
        name = _stand_in("tts")
        if not name:
            print(f"[emkay] tts not ready ({e!r}); nothing stands in")
            raise SpeechNotReady(e) from e
        print(f"[emkay] tts failed ({e!r}); using the fallback {name}")
        _interim("tts", "fallback", name)
        if _fallback is None:
            from ovos_plugin_manager.tts import OVOSTTSFactory
            _fallback = OVOSTTSFactory.create({"tts": {"module": name, name: cfg.get(name, {}),
                                                       "lang": _config().get("lang")}})
        return _fallback.get_tts(utterance, path, lang=lang)


def reload(keep_previous: bool = False):
    """Drop the plugins so the next use reads mycroft.conf again.

    keep_previous: keep the STT and TTS in use until the new ones work (a
    settings change: settings_changed()); without it they go at once (local
    only switches to plugins that wait for their models instead).
    """
    global _stt, _tts, _dialog_tx, _tts_tx, _fallback, _stt_fallback
    if keep_previous:
        for what, cur in (("stt", _stt), ("tts", _tts)):
            if cur is not None:
                _previous[what], _previous_names[what] = cur, _names[what]
    else:
        _previous["stt"] = _previous["tts"] = None
        _previous_names["stt"] = _previous_names["tts"] = None
    _interim_said.clear()
    _stt = _tts = _fallback = _stt_fallback = None
    for service in (_dialog_tx, _tts_tx):
        try:
            service and service.shutdown()
        except Exception:
            pass
    _dialog_tx = _tts_tx = None


def prewarm():
    """Start downloading the models of the configured STT and TTS now, so a
    change made in the settings is ready (and its progress shows) before the
    next sentence. Only Emkay's browser plugins have models to fetch; for
    any other plugin there is nothing to do. Nor where the browser can't run
    them (no JSPI): a model of ~100 MB it can never use would only cost the
    data and the memory a smaller phone needs for Emkay itself."""
    try:
        import js
    except ImportError:          # not in a browser (tests)
        return
    if not jspi():
        return
    cfg = _config()
    lang = cfg.get("lang", "en-US")
    stt_cfg, tts_cfg = cfg.get("stt", {}), cfg.get("tts", {})
    try:
        if stt_cfg.get("module") == "ovos-stt-plugin-whisper-browser":
            from ovos_stt_plugin_whisper_browser import model_for
            model = (stt_cfg.get("ovos-stt-plugin-whisper-browser") or {}).get("model") \
                or model_for(lang.split("-")[0].lower())
            js.emkayWhisper.ready(model)          # starts the download; not awaited
    except Exception as e:
        print(f"[emkay] stt prewarm: {e!r}")
    try:
        if tts_cfg.get("module") == "ovos-tts-plugin-piper-browser":
            from ovos_tts_plugin_piper_browser import voice_for
            voice = (tts_cfg.get("ovos-tts-plugin-piper-browser") or {}).get("voice") or voice_for(lang)
            if voice:
                js.emkayPiper.ready(voice)
    except Exception as e:
        print(f"[emkay] tts prewarm: {e!r}")


# --- listener half ------------------------------------------------------

def transcribe(pcm16: bytes, sample_rate: int = 16000, lang: str = None) -> str:
    from ovos_plugin_manager.utils.audio import AudioData
    lang = lang or _config().get("lang", "en-US")
    audio = AudioData(pcm16, sample_rate, 2)
    t = time.time()
    text = _execute_stt(audio, lang) or ""
    print(f"[emkay] stt {time.time() - t:.1f}s: {text!r}")
    return text.strip()


_stt_fallback = None


def _execute_stt(audio, lang):
    """The configured STT; if it fails, the plugin from before the last
    settings change, else `stt.fallback_module`, as ovos-dinkum-listener does. A plugin that runs on the phone (Whisper)
    fails while its model is still downloading, the first time."""
    global _stt_fallback
    try:
        _check_browser("stt")
        text = stt().execute(audio, language=lang)
        _previous["stt"] = None      # the new one works: the old one can go
        return text
    except Exception as e:
        if _previous["stt"] is not None and _keep_previous("stt"):
            print(f"[emkay] stt failed ({e!r}); the previous STT listens meanwhile")
            _interim("stt", "previous", _previous_names["stt"])
            return _previous["stt"].execute(audio, language=lang)
        cfg = _config().get("stt", {})
        name = _stand_in("stt")
        if not name:
            print(f"[emkay] stt not ready ({e!r}); nothing stands in")
            raise SpeechNotReady(e) from e
        print(f"[emkay] stt failed ({e!r}); using the fallback {name}")
        _interim("stt", "fallback", name)
        if _stt_fallback is None:
            from ovos_plugin_manager.stt import OVOSSTTFactory
            _stt_fallback = OVOSSTTFactory.create({"stt": {"module": name, name: cfg.get(name, {}),
                                                           "lang": _config().get("lang")}})
        return _stt_fallback.execute(audio, language=lang)


def heard(pcm16: bytes, sample_rate: int = 16000):
    """What the listener does after a recording ends."""
    if _mic_muted:   # muted while recording: hear nothing, as a muted listener
        return ""
    from . import boot
    bus = boot.bus()
    from ovos_bus_client.message import Message
    lang = _config().get("lang", "en-US")
    bus.emit(Message("recognizer_loop:record_end"))
    from . import listener
    pcm16, context = listener.speech(pcm16)   # the audio transformers, before STT as in dinkum
    try:
        text = transcribe(pcm16, sample_rate, lang)
    except SpeechNotReady as e:
        # the device's ears aren't there yet: say so rather than "I didn't
        # understand", and let the page offer the servers or typing
        _waiting("stt", e)
        return ""
    if not text:
        bus.emit(Message("recognizer_loop:speech.recognition.unknown"))
        return ""
    from .browser import hand_over
    hand_over(lambda: boot.utterance(text, lang=lang, context=context))   # as the listener: on the bus, back to listening
    return text


def recorded(pcm16: bytes, sample_rate: int, name: str) -> str:
    """The listener's recording mode (recognizer_loop:state.set {"state":
    "recording", "recording_name": name}), as ovos-dinkum-listener does it:
    no STT - the audio is written to <listener save_path>/recordings/<name>.wav
    (and its .json), then recognizer_loop:record_end. A skill that asked for
    it reads the file (ovos-skill-jamband: a hummed melody)."""
    import json
    import os
    import wave
    from ovos_config.locations import get_xdg_data_save_path
    from . import boot
    from ovos_bus_client.message import Message
    listener = _config().get("listener", {})
    folder = os.path.join(listener.get("save_path") or f"{get_xdg_data_save_path()}/listener", "recordings")
    os.makedirs(folder, exist_ok=True)
    name = os.path.basename(name or "") or f"{time.time()}"
    path = os.path.join(folder, f"{name}.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm16 or b"")
    with open(os.path.join(folder, f"{name}.json"), "w") as f:
        json.dump({"recording_name": name}, f)
    boot.bus().emit(Message("recognizer_loop:record_end"))
    return path


def heard_text(text: str) -> str:
    """The browser's speech recognition (ovos-stt-plugin-browser) heard `text`:
    the rest of heard(), as after an STT plugin."""
    if _mic_muted:
        return ""
    from . import boot
    from ovos_bus_client.message import Message
    lang = _config().get("lang", "en-US")
    bus = boot.bus()
    bus.emit(Message("recognizer_loop:record_end"))
    text = (text or "").strip()
    if not text:
        bus.emit(Message("recognizer_loop:speech.recognition.unknown"))
        return ""
    print(f"[emkay] stt (browser): {text!r}")
    from .browser import hand_over
    hand_over(lambda: boot.utterance(text, lang=lang))   # as the listener: on the bus, back to listening
    return text


# --- audio half ---------------------------------------------------------

_VISEME_OF = [  # rough letter-to-mouth table, codes from ovos_utils visimes
    (re.compile(r"[bpm]"), "4"), (re.compile(r"[fv]"), "5"),
    (re.compile(r"[ouw]"), "2"), (re.compile(r"[aei]"), "0"),
    (re.compile(r"[a-z]"), "3"),
]


def text_visemes(text: str, seconds: float):
    """Visemes from the text when the TTS gives no phonemes (Piper over HTTP
    does not). Spread evenly over the audio, it is enough for the face."""
    letters = [c for c in text.lower() if c.isalpha() or c in " ,.!?"]
    if not letters or seconds <= 0:
        return []
    step = seconds / len(letters)
    out, t = [], 0.0
    for c in letters:
        t += step
        code = "4"
        for pat, v in _VISEME_OF:
            if pat.match(c):
                code = v
                break
        if out and out[-1][0] == code:
            out[-1][1] = round(t, 3)
        else:
            out.append([code, round(t, 3)])
    return out


def _wav_seconds(data: bytes) -> float:
    import io
    import wave
    try:
        with wave.open(io.BytesIO(data)) as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def on_speak(message):
    """ovos-audio's speak handler, minus the playback queue.

    In ovos-audio's order: dialog transformers (service.py, handle_speak:
    skipped for skills in their blacklist and for speech with no skill),
    TTS, then the TTS transformers on the WAV file (playback.py, _play).
    """
    utterance = message.data.get("utterance", "")
    if not utterance or _post_audio is None:
        return
    message.context = message.context or {}
    lang = message.data.get("lang") or _config().get("lang", "en-US")
    ident = message.context.get("ident") or f"{time.time():.6f}"
    t = time.time()
    try:
        from ovos_bus_client.session import SessionManager
        dialog_tx, tts_tx = transformers()
        skill_id = message.data.get("meta", {}).get("skill") or message.context.get("skill_id")
        if skill_id and skill_id not in dialog_tx.blacklisted_skills:
            changed, message.context = dialog_tx.transform(
                dialog=utterance, context=message.context, sess=SessionManager.get(message))
            if changed != utterance:
                print(f"[emkay] dialog transformed to: {changed}")
                utterance = changed
    except Exception as e:   # as in ovos-audio: a transformer never stops speech
        print(f"[emkay] dialog transformers failed: {e!r}")
    try:
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        path, phonemes = _get_tts(utterance, path, lang)
        try:
            out, message.context = tts_tx.transform(path, message.context)
            if out and out != path:
                os.unlink(path)
                path = out.replace("file://", "")
        except Exception as e:
            print(f"[emkay] tts transformers failed: {e!r}")
        with open(path, "rb") as f:
            data = f.read()
        os.unlink(path)
    except Exception as e:
        print(f"[emkay] tts failed: {e!r}")
        if isinstance(e, SpeechNotReady):
            _waiting("tts", e, utterance)   # the page shows the sentence as text
        from ovos_bus_client.message import Message
        message.forward("ovos.audio.output.error", {"error": repr(e)})
        return
    seconds = _wav_seconds(data)
    visemes = None
    if phonemes and not _blocked("tts"):   # a stand-in spoke: don't make Piper for its visemes
        try:
            visemes = [[str(c), float(d)] for c, d in tts().viseme(phonemes)]
        except Exception:
            visemes = None
    visemes = visemes or text_visemes(utterance, seconds)
    _pending[ident] = message
    print(f"[emkay] tts {time.time() - t:.1f}s for {seconds:.1f}s of audio")
    _post_audio(data, {"ident": ident, "utterance": utterance,
                       "seconds": seconds, "visemes": visemes})


try:   # the spec names; ovos-audio before the spec used recognizer_loop:audio_output_*
    from ovos_spec_tools import SpecMessage as _Spec
    _OUTPUT_STARTED, _OUTPUT_ENDED = _Spec.AUDIO_OUTPUT_STARTED, _Spec.AUDIO_OUTPUT_ENDED
except ImportError:  # pragma: no cover
    _OUTPUT_STARTED, _OUTPUT_ENDED = ("recognizer_loop:audio_output_start",
                                      "recognizer_loop:audio_output_end")


def playback_started(ident: str, visemes=None):
    from ovos_bus_client.message import Message
    msg = _pending.get(ident) or Message("speak")
    from . import boot
    # the same message ovos-audio's PlaybackService sends (ovos-spec-tools);
    # ovos-audio's AudioService ducks music on it, the visage animates on it
    boot.bus().emit(msg.forward(_OUTPUT_STARTED))
    if visemes:
        boot.bus().emit(msg.forward("enclosure.mouth.viseme_list",
                                    {"start": time.time(), "visemes": visemes}))


def playback_ended(ident: str):
    from . import boot
    from ovos_bus_client.message import Message
    msg = _pending.pop(ident, None) or Message("speak")
    boot.bus().emit(msg.forward(_OUTPUT_ENDED))
    if msg.data.get("expect_response"):
        boot.bus().emit(msg.forward("mycroft.mic.listen"))


_recent = {}


def _once(m):
    """The bus mirrors "speak" and "ovos.utterance.speak"; speak once.

    The bus runs handlers one after the other, so the mirror arrives after
    on_speak() returns, which takes as long as the TTS: seconds the first
    time, or while a Piper voice downloads. The window is therefore counted
    from when the sentence was handled, not from when it arrived; counted
    from the start, a slow TTS let the mirror through and the answer was
    said twice."""
    m = _as_message(m)
    key = (m.data.get("utterance"), m.context.get("ident"))
    if time.time() - _recent.get(key, 0) < 2.0:
        return
    _recent[key] = float("inf")       # handling it now: any mirror is a repeat
    try:
        on_speak(m)
    finally:
        _recent[key] = time.time()


#: The listener's mute state, as ovos-dinkum-listener keeps it (not saved:
#: a device's listener also starts unmuted).
_mic_muted = False


def _mic_status(message):
    """mycroft.mic.get_status: answer like ovos-dinkum-listener does."""
    _bus.emit(_as_message(message).response({"muted": _mic_muted}))


def _mic_mute(_message=None):
    """mycroft.mic.mute: stop listening (the page greys its mic out)."""
    global _mic_muted
    _mic_muted = True


def _mic_unmute(_message=None):
    """mycroft.mic.unmute: listen again."""
    global _mic_muted
    _mic_muted = False


def mic_muted() -> bool:
    return _mic_muted


_bus = None


def resolve_sound(uri: str) -> str:
    """A sound's file, found as ovos-audio finds it (_resolve_sound_uri):
    "snd/..." from ovos-audio's own resources, else OVOS' resource lookup."""
    if uri.startswith("snd/") or uri.startswith("snd\\"):
        import ovos_audio
        local = os.path.join(os.path.dirname(ovos_audio.__file__), "res", uri)
        if os.path.isfile(local):
            return local
    from ovos_utils.file_utils import resolve_resource_file
    found = resolve_resource_file(uri)
    if not found or not os.path.exists(found):
        raise FileNotFoundError(f"could not resolve sound uri: {uri}")
    return found


def sound_bytes(uri: str) -> bytes:
    """The bytes of a sound (the page keeps the confirm-listening sound)."""
    with open(resolve_sound(uri), "rb") as f:
        return f.read()


def on_play_sound(message):
    """ovos-audio's instant sound (mycroft.audio.play_sound / ovos.audio.play_sound):
    a sound file, or hex data, played at once - here by the page, over speech."""
    import binascii
    message = _as_message(message)
    key = ("sound", message.data.get("uri"), message.context.get("ident"))
    now = time.time()
    if now - _recent.get(key, 0) < 0.5:   # the bus mirrors the two topic names
        return
    _recent[key] = now
    try:
        if message.data.get("binary_data"):
            data = binascii.unhexlify(message.data["binary_data"])
        else:
            data = sound_bytes(message.data.get("uri") or "")
    except Exception as e:
        print(f"[emkay] play_sound: {e}")
        return
    if _post_audio is not None:
        _post_audio(data, {"sound": True, "uri": message.data.get("uri")})
    from . import boot
    boot.bus().emit(message.response({}))


def start(bus, post_audio):
    global _post_audio, _bus
    _post_audio = post_audio
    _bus = bus
    bus.on("speak", _once)
    bus.on("ovos.utterance.speak", _once)
    bus.on("mycroft.audio.play_sound", on_play_sound)
    bus.on("ovos.audio.play_sound", on_play_sound)
    # the listener's microphone controls (ovos-dinkum-listener's messages)
    bus.on("mycroft.mic.get_status", _mic_status)
    bus.on("mycroft.mic.mute", _mic_mute)
    bus.on("mycroft.mic.unmute", _mic_unmute)


def _as_message(m):
    from ovos_bus_client.message import Message
    return Message.deserialize(m) if isinstance(m, str) else m
