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
"""
from ovos_utils.log import LOG

_bus = None
_plugins = None       # loaded transformers, highest priority first


def _config() -> dict:
    from ovos_config import Configuration
    return Configuration().get("listener", {}).get("audio_transformers") or {}


def load() -> list:
    """The audio transformers, as dinkum's AudioTransformersService loads them."""
    global _plugins
    from ovos_plugin_manager.audio_transformers import find_audio_transformer_plugins
    config = _config()
    loaded = []
    for name, plug in find_audio_transformer_plugins().items():
        if name not in config or not (config[name] or {}).get("active", True):
            continue
        try:
            p = plug()
            p.bind(_bus)
            loaded.append(p)
            LOG.info(f"loaded audio transformer plugin: {name}")
        except Exception:
            LOG.exception(f"Failed to load audio transformer plugin: {name}")
    _plugins = sorted(loaded, key=lambda p: p.priority, reverse=True)
    return _plugins


def plugins() -> list:
    return _plugins if _plugins is not None else load()


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
    return load()


def start(bus):
    global _bus
    _bus = bus
    load()
