"""Emkay's listener: what ovos-dinkum-listener does with the audio, for a
microphone the browser owns.

The page hears the wake word (web/wakeword.js) and records the question;
speech.py tells OVOS (recognizer_loop:wakeword, record_begin, record_end),
runs STT and puts the utterance on the bus.

Audio transformers: like dinkum, the plugins named in
`listener.audio_transformers` are loaded (OPM's audio transformer plugins;
`"active": false` skips one) and fed the same way, 16 kHz 16-bit mono:

- room audio while waiting for the wake word: `room()` (dinkum's feed_audio)
- the recorded question before STT: `speech()` (feed_speech, then transform,
  whose context goes with the utterance as in dinkum)

The page sends room audio only while `names()` is not empty, so with no
transformer no audio crosses over.

A transformer that needs STT on the device (`use_stt`, as
ovos-audio-transformer-plugin-overheard-manners) gets Emkay's own when that
runs on the device (Whisper in the browser), so no second model is loaded.
Never a server, and never the fallback: room audio does not leave the device.
"""
from ovos_utils.log import LOG

_bus = None
_plugins = None       # loaded transformers, highest priority first
_announce = None      # callable(names): tells the page which want the room audio
#: seconds after the start before the transformers load: a model one fetches
#: or opens (overheard manners') must not make the start any longer
LOAD_AFTER = 5.0


def _config() -> dict:
    from ovos_config import Configuration
    return Configuration().get("listener", {}).get("audio_transformers") or {}


class _DeviceSTT:
    """Emkay's STT plugin for a transformer, only while it runs on the device.
    Not speech.transcribe: that may fall back to a server, and logs the text."""

    def execute(self, audio, language=None):
        from . import speech
        if not _stt_on_device():
            return ""
        return speech.stt().execute(audio, language=language) or ""


def _stt_on_device() -> bool:
    from ovos_config import Configuration
    from . import speech
    return Configuration().get("stt", {}).get("module") in speech._ON_DEVICE


def load() -> list:
    """The audio transformers, as dinkum's AudioTransformersService loads them."""
    global _plugins
    from ovos_plugin_manager.audio_transformers import find_audio_transformer_plugins
    from . import hf_site
    hf_site.install()     # the models they ask Hugging Face for come from the site
    config = _config()
    loaded = []
    for name, plug in find_audio_transformer_plugins().items():
        if name not in config or not (config[name] or {}).get("active", True):
            continue
        try:
            p = plug()
            p.bind(_bus)
            if hasattr(p, "use_stt") and _stt_on_device():
                p.use_stt(_DeviceSTT())
            loaded.append(p)
            LOG.info(f"loaded audio transformer plugin: {name}")
        except Exception:
            LOG.exception(f"Failed to load audio transformer plugin: {name}")
    _plugins = sorted(loaded, key=lambda p: p.priority, reverse=True)
    return _plugins


def plugins() -> list:
    """The loaded transformers ([] until they have loaded, after the start)."""
    return _plugins or []


def names() -> list:
    """The transformers listening, for the page: it sends room audio only then."""
    return [p.name for p in plugins()]


def room(pcm16: bytes):
    """Room audio while waiting for the wake word (dinkum's feed_audio)."""
    for p in plugins():
        try:
            p.feed_audio_chunk(pcm16)
        except Exception:
            LOG.exception(f"{p.name}: feed_audio failed")


def speech(pcm16: bytes) -> tuple:
    """The recorded question before STT: fed as speech, then transformed.
    Returns (audio, context), as dinkum's AudioTransformersService.transform."""
    context = {}
    for p in plugins():
        try:
            p.feed_speech_chunk(pcm16)
        except Exception:
            LOG.exception(f"{p.name}: feed_speech failed")
    for p in plugins():
        try:
            pcm16 = p.feed_speech_utterance(pcm16)
            pcm16, data = p.transform(pcm16)
            context.update(data or {})
        except Exception:
            LOG.exception(f"{p.name}: transform failed")
    return pcm16, context


def reload() -> list:
    """After a change to listener.audio_transformers: as at the start."""
    global _plugins
    for p in _plugins or []:
        try:
            (getattr(p, "shutdown", None) or p.default_shutdown)()
        except Exception as e:
            LOG.warning(e)
    _plugins = None
    load()
    return _plugins


def _load_and_announce():
    try:
        load()
    except Exception:
        LOG.exception("audio transformers could not load")
    if _announce:
        _announce(names())


def start(bus, announce=None):
    """After the start (LOAD_AFTER): load the transformers, then tell the page."""
    global _bus, _announce
    _bus, _announce = bus, announce
    import asyncio
    asyncio.get_event_loop().call_later(LOAD_AFTER, _load_and_announce)
