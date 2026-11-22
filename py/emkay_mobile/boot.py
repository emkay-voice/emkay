"""Boot a stock ovos-core on an in-process bus.

This is `ovos_core.__main__.main()` without the websocket: the same
SkillManager, IntentService, pipeline plugins and skills, and the same
mycroft.conf layering. The messagebus service is replaced by ovos-utils'
FakeBus, which delivers every message to its handlers in the same process,
because a browser cannot open a server socket.

The page side talks to it through `utterance()`, `emit()` and `bus()`.
"""
import json
import os
import sys
import time

from . import browser, privacy

if sys.platform == "emscripten":
    browser.install()

#: Where the worker unpacks the m2v intent models it fetched from the site,
#: one folder per language (see tools/fetch_m2v_models.py).
M2V_DIR = os.path.expanduser("~/.local/share/emkay-mobile/m2v")

#: Skills that wait for host services a browser does not have: they loop
#: until ovos-audio and ovos-dinkum-listener report ready, which never happens.
UNAVAILABLE_SKILLS = ("ovos-skill-boot-finished.openvoiceos",)
#: skills Emkay has its own version of (defaults v9): ovos-skill-about-emkay
#: answers ovos-skill-personal's questions as Emkay, so the two would compete
REPLACED_SKILLS = ("ovos-skill-personal.openvoiceos",)
#: skills that cannot work in a browser yet (defaults v10): they ask public
#: translation servers that do not allow a web page to read them (CORS), and
#: Wolfram Alpha needs an app id. Asked in turn by common query and the
#: fallbacks, each would add seconds to every unanswered question.
BROWSERLESS_SKILLS = ("ovos-skill-ddg.openvoiceos", "ovos-skill-wolfie.openvoiceos")
#: skills from ovos-core's default groups that make no sense in a browser
#: (defaults v12), tried in Emkay on 2026-11-17:
#: - speedtest: speedtest.net cannot be measured from a web page ("there was
#:   an error")
#: - audio-recording, dictation: they record to files on the device, which
#:   a browser user cannot reach; dictation also takes every sentence until
#:   "stop dictation", and Emkay shows each as unanswered meanwhile
#: - ip: a web page cannot see the device's network address
#: - diagnostics: needs psutil, which Pyodide does not have
#: The control panel can take any of them off the list again.
NO_USE_IN_BROWSER = ("ovos-skill-speedtest.openvoiceos", "ovos-skill-audio-recording.openvoiceos",
                     "ovos-skill-dictation.openvoiceos", "ovos-skill-ip.openvoiceos",
                     "ovos-skill-diagnostics.openvoiceos")

#: Emkay's own wake word, "hey M K" (defaults v11): the openWakeWord model
#: trained in emkay-voice/hey-emkay-wakeword, which the site already ships as
#: oww/hey_emkay_v0.1.onnx (tools/fetch_wakeword_models.py). Only offered,
#: not switched on: with this entry in `hotwords`, "hey_emkay" can be chosen
#: as the wake word in the control panel's Voice settings; listener.wake_word
#: stays as it is.
HEY_EMKAY = {"module": "ovos-ww-plugin-openwakeword", "threshold": 0.8, "listen": True}

#: Emkay's own defaults as a device (defaults v13): speech on the device and
#: its own wake word. Speech recognition (Whisper, Røst for Danish) and the
#: voice (Piper) run in the browser, so what is said stays on the device and
#: OpenVoiceOS' public servers are not used for every sentence. Since v15
#: they are not a silent fallback either: while a model downloads, or for a
#: language with no model on the device, Emkay says so and the user may
#: choose the servers (speech.py, servers_meanwhile).
#: Only a setting still at the installer's default is changed; everything
#: can be set back in the control panel.
LOCAL_STT = "ovos-stt-plugin-whisper-browser"
LOCAL_TTS = "ovos-tts-plugin-piper-browser"
SERVER_STT = "ovos-stt-plugin-server"
SERVER_TTS = "ovos-tts-plugin-server"
EMKAY_WAKE_WORD = "hey_emkay"

#: The intent pipeline ovos-installer writes (defaults v10), so Emkay matches
#: an installed device rather than ovos-config's bare default: it adds
#: common query (knowledge skills compete, e.g. Wikipedia and
#: ovos-skill-wiki-offline). Copied from ovos-installer's
#: ansible/roles/ovos_config/templates/mycroft.conf.j2, November 2026, without
#: its persona stages (defaults v16): Emkay doesn't ship ovos-persona, and
#: installed from the control panel it is put back by the rule
#: (pipeline_place.py).
INSTALLER_PIPELINE = (
    "ovos-stop-pipeline-plugin-high",
    "ovos-converse-pipeline-plugin",
    "ovos-ocp-pipeline-plugin-high",
    "ovos-padatious-pipeline-plugin-high",
    "ovos-m2v-pipeline-high",
    "ovos-fallback-pipeline-plugin-high",
    "ovos-adapt-pipeline-plugin-high",
    "ovos-stop-pipeline-plugin-medium",
    "ovos-adapt-pipeline-plugin-medium",
    "ovos-common-query-pipeline-plugin",
    "ovos-fallback-pipeline-plugin-medium",
    "ovos-fallback-pipeline-plugin-low",
)

#: Version of the one-time defaults below; each step is written once, so a
#: phone set up by an older build gets only the steps it has not had yet.
DEFAULTS_VERSION = 16
#: the package index the control panel searches (defaults v7)
STORE_INDEX = "https://store.emkay.ai"

#: OVOS' own alpha-channel constraints, for what is installed later (the
#: site itself is built from the alpha channel).
ALPHA_CONSTRAINTS = ("https://raw.githubusercontent.com/OpenVoiceOS/ovos-releases/"
                     "refs/heads/main/constraints-alpha.txt")

#: good manners, first in the pipeline (defaults v16)
GOOD_MANNERS = "ovos-good-manners-pipeline-plugin"
#: persona's stages, out of the pipeline (defaults v16): not shipped any more
PERSONA = "ovos-persona-pipeline-plugin"
#: audio transformers Emkay turns on (defaults v16): they listen to the room
#: between wake words, on the device, and keep or send nothing of the sound
AUDIO_TRANSFORMERS = ("ovos-audio-transformer-plugin-overheard-manners",
                      "ovos-audio-transformer-plugin-autovolume")

#: The user layer of mycroft.conf, as on a device (~/.config/mycroft).
CONF_PATH = os.path.expanduser("~/.config/mycroft/mycroft.conf")

_bus = None
_manager = None


def report(key: str, progress: float = None, **variables):
    """How the boot is going, for the start screen's bar (app.js bootStatus).

    `key` is one of Emkay's texts (locale/<lang>/<key>.dialog), `progress`
    0..1 within that step. Does nothing until worker_main sets it.
    """


class _BootSteps:
    """Report OVOS' start step by step, for the start screen.

    Starting ovos-core is most of the boot, and nothing in it says how far it
    is. While it starts, a few of its own functions are wrapped (and put back
    afterwards) so each step reports itself:

      boot.findskills  SkillManager's first find_skill_plugins (imports every skill)
      boot.engines     the intent pipeline plugins loading, i of n
      boot.loadskills  the skills loading, i of n

    Anything ovos-core doesn't have (another version) is simply not reported.
    """

    def __init__(self):
        self._undo = []
        self.manager = None          # set once SkillManager exists
        self.loading_skills = False  # set around SkillManager._load_new_skills
        self.engines = {"done": 0, "total": 0}
        self.skills = {"done": 0, "total": 0}

    def _wrap(self, owner, name, make):
        """Replace owner.name with make(original); undone by restore()."""
        original = owner.__dict__.get(name)
        if original is None:
            return
        self._undo.append((owner, name, original))
        func = original.__func__ if isinstance(original, (staticmethod, classmethod)) else original
        wrapped = make(func)
        if isinstance(original, staticmethod):
            wrapped = staticmethod(wrapped)
        elif isinstance(original, classmethod):
            wrapped = classmethod(wrapped)
        setattr(owner, name, wrapped)

    def __enter__(self):
        try:
            import ovos_core.skill_manager as sm
            from ovos_plugin_manager.pipeline import OVOSPipelineFactory
        except ImportError:
            return self
        steps = self

        def find_skills(find):
            def counting(*args, **kwargs):
                if not steps.loading_skills:
                    report("boot.findskills")
                    return find(*args, **kwargs)
                found = find(*args, **kwargs)
                blacklist = set(getattr(steps.manager, "blacklist", None) or [])
                steps.skills["total"] = len([s for s in found if s not in blacklist])
                report("boot.loadskills", 0, i=0, n=steps.skills["total"])
                return found
            return counting
        # SkillManager calls it by its module-level name
        if hasattr(sm, "find_skill_plugins"):
            self._undo.append((sm, "find_skill_plugins", sm.find_skill_plugins))
            sm.find_skill_plugins = find_skills(sm.find_skill_plugins)

        def load_skill(load):
            def counting(manager, skill_id, *args, **kwargs):
                try:
                    return load(manager, skill_id, *args, **kwargs)
                finally:
                    if steps.loading_skills:
                        steps._step("boot.loadskills", steps.skills)
            return counting
        self._wrap(sm.SkillManager, "_load_plugin_skill", load_skill)

        def pipeline_ids(ids_of):
            def counting(*args, **kwargs):
                ids = ids_of(*args, **kwargs)
                from ovos_config import Configuration
                blacklist = set(Configuration().get("intents", {}).get("blacklisted_pipelines", []))
                steps.engines["total"] = len([p for p in ids if p not in blacklist])
                report("boot.engines", 0, i=0, n=steps.engines["total"])
                return ids
            return counting
        self._wrap(OVOSPipelineFactory, "get_installed_pipeline_ids", pipeline_ids)

        def load_engine(load):
            def counting(*args, **kwargs):
                try:
                    return load(*args, **kwargs)
                finally:
                    steps._step("boot.engines", steps.engines)
            return counting
        self._wrap(OVOSPipelineFactory, "load_plugin", load_engine)
        return self

    def _step(self, key, count):
        """One more of `count` done: report it."""
        count["done"] += 1
        n = max(count["total"], count["done"])
        report(key, count["done"] / n, i=count["done"], n=n)

    def __exit__(self, *exc):
        for owner, name, original in reversed(self._undo):
            setattr(owner, name, original)
        self._undo.clear()


def _merge(base: dict, extra: dict) -> dict:
    """Merge `extra` into `base` in place, recursing into nested dicts."""
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def read_user_config() -> dict:
    """The user mycroft.conf as a dict ({} if there is none or it is broken)."""
    try:
        with open(CONF_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_user_config(overrides: dict) -> dict:
    """Merge `overrides` into the user mycroft.conf and return the result.

    This is what the setup page does on a device: the system and default
    layers stay untouched, the user layer holds only what was changed.
    """
    cur = _merge(read_user_config(), overrides or {})
    _write_whole_user_config(cur)
    return cur


def _write_whole_user_config(conf: dict):
    """Replace the user mycroft.conf (write_user_config only merges)."""
    os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
    with open(CONF_PATH, "w") as f:
        json.dump(conf, f, indent=2)


def _m2v_models() -> dict:
    """{lang: folder} for every m2v model the worker unpacked."""
    if not os.path.isdir(M2V_DIR):
        return {}
    return {lang: os.path.join(M2V_DIR, lang) for lang in sorted(os.listdir(M2V_DIR))
            if os.path.isfile(os.path.join(M2V_DIR, lang, "model.safetensors"))}


def _m2v_without_model() -> list:
    """The m2v pipeline, when OVOS' language has no m2v model on the site.

    OpenVoiceOS publishes per-language m2v intent models for some languages
    (tools/fetch_m2v_models.py); for any other language ovos-m2v-pipeline
    falls back to its 141 MB multilingual model, which is not trained on
    that language either and is far too much for a phone. Then the pipeline
    sits this boot out (the other pipelines still match), and comes back
    on its own once the language has a model again: _unused_pipelines never
    keeps a pipeline that is in use.
    """
    from ovos_config import Configuration
    cfg = Configuration()
    langs = [cfg.get("lang", "en-US")] + list(cfg.get("secondary_langs") or [])
    have = _m2v_models()
    if all(str(l).split("-")[0].lower() in have for l in langs):
        return []
    from ovos_plugin_manager.pipeline import OVOSPipelineFactory
    return [p for p in OVOSPipelineFactory.get_installed_pipeline_ids()
            if p == "ovos-m2v-pipeline"]


def _unused_pipelines(user_blacklist, pipeline=None) -> list:
    """intents.blacklisted_pipelines with every installed pipeline plugin the
    active pipeline does not use.

    ovos-core loads every installed pipeline plugin, used or not, "because a
    remote client/session may select a different pipeline at runtime" - and
    each one then takes part in every skill's intent registration. A phone
    has no remote sessions, and in WebAssembly the unused ones (padacioso,
    persona, common query, the adapt variants, legacy OCP) cost over half of
    the boot. ovos-core's own `intents.blacklisted_pipelines` setting opts
    them out. Recomputed every boot with ovos-core's own matching rule, so a
    plugin put back into `intents.pipeline` (setup page) is loaded again.
    `pipeline`: the pipeline this boot's patch sets, when it sets one.
    """
    from ovos_config import Configuration
    from ovos_plugin_manager.pipeline import OVOSPipelineFactory
    try:
        from ovos_core.intent_services.service import _PIPELINE_MIGRATION_MAP as legacy
    except ImportError:
        legacy = {}
    if pipeline is None:
        pipeline = Configuration().get("intents", {}).get("pipeline", [])
    active = [legacy.get(m, m) for m in pipeline]

    def used(plugin_id):
        return any(m == plugin_id or m.startswith(f"{plugin_id}-") for m in active)

    keep = [p for p in user_blacklist if not used(p)]  # never block an active one
    unused = [p for p in OVOSPipelineFactory.get_installed_pipeline_ids()
              if not used(p) and p not in keep]
    return keep + unused


def _browser_defaults(done: int) -> dict:
    """The few settings that differ from a device, as a user-layer patch.

    `done` is the defaults version this phone already has (0 on a first
    boot). Each one-time step is written once, so the setup page can change
    it later:
      1. skills that cannot run here are blacklisted
      2. ovos-core's installer is enabled, on the alpha channel, and the
         setup page's release channel is alpha to match: installing skills
         and plugins from the setup page is what a device can do (see
         pip.py), and the site itself is built from the alphas
      (3. was padatious without padaos; that made padatious' networks
         answer exact phrases wrongly, so 4 puts padaos back)
      5. the public TTS servers in one order, so the voice stays the same
      6. ovos-common-reading-pipeline-plugin (now on the site) goes into
         the pipeline where its README says: -high right after stop, -low
         before common query and the fallbacks
      7. the control panel searches the Emkay store's package index
      8. music plays through ovos-audio-plugin-browser, and OCP hands its
         results to ovos-audio's AudioService ("legacy")
      9. ovos-skill-personal is blacklisted: ovos-skill-about-emkay answers
         the same questions as Emkay (REPLACED_SKILLS)
     10. the intent pipeline is ovos-installer's (INSTALLER_PIPELINE), with
         common query and persona, and the skills that cannot work in a
         browser yet are blacklisted (BROWSERLESS_SKILLS)
     11. Emkay's own wake word "hey M K" is in `hotwords` (HEY_EMKAY), so
         the control panel offers "hey_emkay"; the wake word in use does
         not change
     12. the default skills that make no sense in a browser are
         blacklisted (NO_USE_IN_BROWSER)
     13. speech runs on the device and "hey M K" wakes it (LOCAL_STT,
         LOCAL_TTS, EMKAY_WAKE_WORD), where those settings are still the
         installer's defaults
     14. yes/no questions use ovos-yes-no-plugin
     15. no server stands in for the device's speech without being asked:
         the `fallback_module` v13 set (the public OVOS servers) goes. While
         a model downloads, Emkay says so and offers the servers for the
         moment (speech.py, servers_meanwhile)
     16. persona's stages leave the pipeline (PERSONA, no longer shipped),
         good manners goes first in it (GOOD_MANNERS), and the
         room is listened to for overheard swearing and its noise level
         (AUDIO_TRANSFORMERS: overheard-manners and auto volume, on)
    The m2v model folders and the unused pipeline plugins are written on
    every boot, since they follow whatever the site shipped and the
    pipeline the user chose.
    """
    from ovos_config import Configuration
    out = {"emkay_mobile_defaults": DEFAULTS_VERSION}
    if done < 1:
        cfg = Configuration()
        blacklisted = list(cfg.get("skills", {}).get("blacklisted_skills", []))
        blacklisted += [s for s in UNAVAILABLE_SKILLS if s not in blacklisted]
        out.setdefault("skills", {})["blacklisted_skills"] = blacklisted
    if done < 2:
        out.setdefault("skills", {})["installer"] = {
            "allow_pip": True, "allow_alphas": True, "constraints": ALPHA_CONSTRAINTS}
        out["webui"] = {"release_channel": "alpha"}
    # The location now comes from the browser PHAL plugin, in the assistant
    # layer like ipgeo's (ovos-phal-plugin-browser). Builds of 2026-11-14 wrote the browser's
    # time zone into the user layer instead, where it would hide that; such
    # an entry, and only that, is dropped again.
    if done < 5:
        # ovos-tts-plugin-server shuffles its public servers for every
        # sentence, and they have different default voices: a man, then a
        # woman, maybe with another accent (#7). The plugin's own "host"
        # list keeps one order, with the second server as the fallback.
        out.setdefault("tts", {})["ovos-tts-plugin-server"] = {
            "host": ["https://tts.openvoiceos.pt", "https://tts.smartgic.io/piper"]}
    if done < 6:
        pipeline = _with_common_reading(Configuration().get("intents", {}).get("pipeline", []))
        if pipeline:
            out.setdefault("intents", {})["pipeline"] = pipeline
    if done < 7:
        # The control panel searches the Emkay store's package index, which
        # lists only what Emkay ships and what its nightly test found
        # working in a browser (emkay-voice/store), instead of all of PyPI
        # (#21). Packages still install from PyPI. The panel's cached PyPI
        # list is dropped so its next search reads the new index.
        out.setdefault("webui", {})["pypi_index"] = STORE_INDEX
        try:
            from ovos_config.locations import get_xdg_cache_save_path
            os.remove(os.path.join(get_xdg_cache_save_path(), "webui-pypi-index.json"))
        except OSError:
            pass
    if done < 8:
        # Music, radio and podcasts (#16). ovos-audio's AudioService plays
        # them through ovos-audio-plugin-browser, the page's <audio>
        # element; mycroft.conf's default backend is mpv, which a browser
        # does not have. OCP hands its results to that AudioService
        # ("legacy"), as it does on a device without ovos-media; without it
        # OCP would also wait a second on every request for a player that
        # never answers.
        audio = out.setdefault("Audio", {})
        audio["default-backend"] = "browser"
        audio.setdefault("backends", {})["browser"] = {
            "type": "ovos_audio_browser", "active": True}
        out.setdefault("intents", {}).setdefault(
            "ovos-ocp-pipeline-plugin", {})["legacy"] = True
    if done < 9:
        # Emkay's own version of a skill replaces OVOS' (REPLACED_SKILLS); the
        # setup page can take it off the list again
        _blacklist(out, REPLACED_SKILLS)
    if done < 10:
        # As ovos-installer sets it up, with common reading where step 6
        # put it; the setup page can change it again
        pipeline = list(INSTALLER_PIPELINE)
        out.setdefault("intents", {})["pipeline"] = _with_common_reading(pipeline) or pipeline
        _blacklist(out, BROWSERLESS_SKILLS)
    if done < 11:
        # offered, not chosen: listener.wake_word is left alone
        out.setdefault("hotwords", {})["hey_emkay"] = HEY_EMKAY
    if done < 12:
        _blacklist(out, NO_USE_IN_BROWSER)
    if done < 13:
        cfg = Configuration()
        if cfg.get("stt", {}).get("module") in (None, SERVER_STT):
            out.setdefault("stt", {})["module"] = LOCAL_STT       # no server fallback (v15)
        if cfg.get("tts", {}).get("module") in (None, SERVER_TTS):
            out.setdefault("tts", {})["module"] = LOCAL_TTS
        if cfg.get("listener", {}).get("wake_word") in (None, "hey_mycroft"):
            out.setdefault("listener", {})["wake_word"] = EMKAY_WAKE_WORD
            out.setdefault("hotwords", {})[EMKAY_WAKE_WORD] = HEY_EMKAY
    if done < 14:
        # ask_yesno: ovos-workshop asks for "ovos-solver-yes-no-plugin" when
        # nothing is set, but ovos-yes-no-plugin (what is installed) names its
        # engine "ovos-yes-no-plugin". Every yes/no question logged "Failed to
        # load YesNo plugin" and fell back to the same engine built in.
        if not Configuration().get("skills", {}).get("ask_yesno_plugin"):
            out.setdefault("skills", {})["ask_yesno_plugin"] = "ovos-yes-no-plugin"
    if done < 16:
        # good manners (ovos-good-manners-pipeline-plugin, which
        # overheard-manners brings): first in the pipeline, as its README asks
        before = out.get("intents", {}).get("pipeline") or Configuration().get("intents", {}).get("pipeline", [])
        # persona's stages go: Emkay no longer ships it (it comes back by the
        # rule if installed from the control panel)
        kept = [p for p in before if not p.startswith(PERSONA)]
        pipeline = _with_plugin(kept, GOOD_MANNERS) or kept
        if pipeline != list(before):
            out.setdefault("intents", {})["pipeline"] = pipeline
        # and the room listened to, on the device, for overheard swearing and
        # for how noisy it is (AUDIO_TRANSFORMERS): named in audio_transformers
        # is OVOS' opt-in, and both start enabled; their control panel pages
        # turn them off
        tx = out.setdefault("audio_transformers", {})
        for name in AUDIO_TRANSFORMERS:
            tx.setdefault(name, {})
    user = read_user_config()
    # defaults v3 turned padaos off (a ~30 s regex compile after boot); without
    # it padatious matched "what time is it" to the timer skill. v4 takes
    # back exactly that setting, so ovos-padatious works as on a device.
    pad = user.get("intents", {}).get("ovos-padatious-pipeline-plugin", {})
    if done < 4 and pad.get("disable_padaos") is True:
        del pad["disable_padaos"]
        if not pad:
            del user["intents"]["ovos-padatious-pipeline-plugin"]
        _write_whole_user_config(user)
    # defaults v15: the public servers are no longer the silent fallback for
    # the device's speech (v13 wrote them); a fallback the user chose stays
    if done < 15:
        changed = False
        for what, server in (("stt", SERVER_STT), ("tts", SERVER_TTS)):
            sec = user.get(what)
            if isinstance(sec, dict) and sec.get("fallback_module") == server:
                del sec["fallback_module"]
                changed = True
        if changed:
            _write_whole_user_config(user)
    loc = user.get("location")
    if isinstance(loc, dict) and list(loc) == ["timezone"] and \
            loc["timezone"].get("code") == loc["timezone"].get("name"):
        del user["location"]
        _write_whole_user_config(user)
    # pipeline plugins installed since the last boot go where the rule says
    # (pipeline_place.py); every boot, so one installed in the panel is used
    # from the next start on even if the live placement (on_installed) missed it
    from . import pipeline_place
    seen = user.get("emkay", {}).get("pipelines_seen")
    current = out.get("intents", {}).get("pipeline") or Configuration().get("intents", {}).get("pipeline", [])
    placed, seen = pipeline_place.place_new(current, seen)
    if placed:
        out.setdefault("intents", {})["pipeline"] = placed
    out.setdefault("emkay", {})["pipelines_seen"] = seen
    user_bl = read_user_config().get("intents", {}).get("blacklisted_pipelines", [])
    new_pipeline = out.get("intents", {}).get("pipeline")   # set above on a defaults step, else None
    out.setdefault("intents", {})["blacklisted_pipelines"] = \
        _unused_pipelines(user_bl, new_pipeline) + _m2v_without_model()
    models = _m2v_models()
    if models:
        # ovos-m2v-pipeline's documented per-language "models" map, pointed at
        # the copies the site ships (its Hub default is 141 MB for every
        # language, too much for a phone)
        out["intents"]["ovos_m2v_pipeline"] = {"models": models}
    return out


def _blacklist(out: dict, skill_ids) -> None:
    """Add `skill_ids` to skills.blacklisted_skills in the patch `out`,
    starting from the list already there (an earlier step's, else the
    configuration's)."""
    from ovos_config import Configuration
    skills = out.setdefault("skills", {})
    blacklisted = skills.get("blacklisted_skills")
    if blacklisted is None:
        blacklisted = list(Configuration().get("skills", {}).get("blacklisted_skills", []))
    blacklisted += [s for s in skill_ids if s not in blacklisted]
    skills["blacklisted_skills"] = blacklisted


def _with_plugin(pipeline: list, plugin_id: str) -> list:
    """`pipeline` with `plugin_id`'s stages added where its README asks
    (pipeline_place.OVERRIDES), else by the rule; [] when nothing is to
    change (already there, plugin missing, or no pipeline to edit)."""
    from ovos_plugin_manager.pipeline import OVOSPipelineFactory
    from . import pipeline_place
    if plugin_id not in OVOSPipelineFactory.get_installed_pipeline_ids():
        return []
    return pipeline_place.place(pipeline, plugin_id)


def _with_common_reading(pipeline: list) -> list:
    """`pipeline` with ovos-common-reading-pipeline-plugin's two stages added
    where its README asks; [] when nothing is to change."""
    return _with_plugin(pipeline, "ovos-common-reading-pipeline-plugin")


def _phone_language():
    """OVOS' default language: the phone's, when the site ships its intents.

    The page passes the phone's languages (navigator.languages) and the
    languages the site has pre-trained intents for (EMKAY_PHONE_LANGS,
    EMKAY_SITE_LANGS, worker.js). The first phone language the site has -
    exactly, else by its base ("da" for "da-DK") - goes into the assistant
    layer, as ipgeo does with the location: below the user layer, so a
    language chosen in the control panel always wins, and followed again on
    every boot. With none of them, OVOS' own default (en-US) stays.
    """
    from ovos_config.models import AssistantConfig
    site = [l for l in os.environ.get("EMKAY_SITE_LANGS", "").split(",") if l]
    phone = [l for l in os.environ.get("EMKAY_PHONE_LANGS", "").split(",") if l]
    pick = None
    for wanted in phone:
        exact = [l for l in site if l.lower() == wanted.lower()]
        base = [l for l in site if l.split("-")[0].lower() == wanted.split("-")[0].lower()]
        if exact or base:
            pick = (exact or base)[0]
            break
    layer = AssistantConfig()
    if pick and layer.get("lang") != pick:
        layer["lang"] = pick
        layer.store()
    elif not pick and "lang" in layer:
        del layer["lang"]
        layer.store()


def _phone_timezone():
    """OVOS' time zone: the phone's, until a real location is known.

    OVOS' default location is Lawrence, Kansas, and some skills read the
    time zone once, when they are imported (alerts: "set an alarm in five
    minutes" said 10:29 a.m. for 17:29 in Copenhagen). The browser PHAL
    plugin finds the real location later (geolocation, with permission), so
    the phone's time zone (EMKAY_TZ, worker.js) goes into the assistant
    layer first, before any skill loads - the browser PHAL plugin writes too.
    A location found later, or one set in the control panel, replaces it.
    """
    from ovos_config.models import AssistantConfig
    tz = os.environ.get("EMKAY_TZ")
    if not tz:
        return
    layer = AssistantConfig()
    loc = layer.get("location") or {}
    if loc.get("city"):   # a real location (geolocation or ipgeo): its own time zone
        return
    if (loc.get("timezone") or {}).get("code") != tz:
        zone = {"code": tz, "name": tz.replace("/", " ")}
        try:   # the offsets too, or the default's (Chicago's) stay merged in
            import datetime as dt
            from zoneinfo import ZoneInfo
            now = dt.datetime.now(ZoneInfo(tz))
            dst = now.dst() or dt.timedelta(0)
            zone["offset"] = int((now.utcoffset() - dst).total_seconds() * 1000)
            zone["dstOffset"] = int(dst.total_seconds() * 1000)
        except Exception as e:
            print(f"[emkay] time zone {tz}: {e!r}")
        layer["location"] = {**loc, "timezone": zone}
        layer.store()


def _warm_models_soon(delay: float = 2.0):
    """Load the intent models a pipeline plugin defers to its first query.

    ovos-m2v-pipeline loads its model on a background thread and skips the
    queries that come before it is ready; here a thread's body runs on the
    page's event loop, so the first question paid for the load (~4 s).
    The same load runs a moment after "ready" instead, while the user is
    still reaching for the phone (issue #4).
    """
    import asyncio

    def warm():
        for pid, plugin in (_manager.intents.pipeline_plugins if _manager.intents else {}).items():
            ensure = getattr(plugin, "_ensure_model", None)
            if callable(ensure):
                t = time.time()
                try:
                    ensure(background_ok=False)
                    print(f"[emkay] {pid} model ready in {time.time() - t:.1f}s")
                except Exception as e:
                    print(f"[emkay] {pid} model warm-up failed: {e!r}", file=sys.stderr)

    asyncio.get_event_loop().call_later(delay, warm)


def _follow_config_changes(bus):
    """Reload the merged mycroft.conf when a service announces a change.

    On a device every config file is watched (a watchdog thread), and the
    services also listen for `configuration.updated` and friends - that is
    Configuration.set_config_update_handlers, which ovos-gui's service
    calls. The browser has neither the watcher thread nor that service, so
    the bus half is registered here, with ovos-config's own handlers: a
    PHAL plugin or the setup page writing a layer and emitting
    `configuration.updated` is then seen at once, as on a device.
    """
    from ovos_config import Configuration
    Configuration.deregister_bus()
    Configuration.bus = bus
    bus.on("configuration.updated", Configuration.updated)
    bus.on("configuration.patch", Configuration.patch)
    bus.on("configuration.patch.clear", Configuration.patch_clear)
    bus.on("configuration.cache.clear", Configuration.clear_cache)


def _drive_scheduler(scheduler, every: float = 0.5):
    """Run the event scheduler's tick() on the event loop instead of its thread.

    ScheduledEventService.run() is `replay()` followed by `tick()` every
    TICK_SECONDS on its own thread. Here the thread is not started (see
    browser.FOREVER_LOOPS), so the same two calls are made from the loop.
    Skill timers, alarms and `schedule_event()` work as on a device.
    """
    import asyncio
    loop = asyncio.get_event_loop()
    try:
        scheduler.replay()
    except Exception as e:
        print(f"[emkay] scheduler replay failed: {e!r}", file=sys.stderr)

    def tick():
        try:
            scheduler.tick()
        except Exception as e:  # one bad schedule must not stop the clock
            print(f"[emkay] scheduler tick failed: {e!r}", file=sys.stderr)
        loop.call_later(every, tick)

    loop.call_later(every, tick)


def _browser_installer():
    """ovos-core's installer (SkillsStore) with pip.run for its subprocess.

    SkillsStore._run_pip is the one place the installer starts a process
    (pip or uv). Everything else it does stays as it is.
    """
    from ovos_core.skill_installer import SkillsStore
    from . import pip
    SkillsStore._run_pip = staticmethod(pip.run)
    SkillsStore.UV = None   # the command line it builds is then plain pip's


def start(on_message=None, user_config=None) -> dict:
    """Load every installed skill on a fresh bus.

    Args:
        on_message: optional callable for every bus message (serialized).
        user_config: optional dict merged into the user mycroft.conf first.

    Returns:
        {"seconds": boot time, "skills": loaded skill ids,
         "skipped_threads": thread names that were deferred or left out}
    """
    global _bus, _manager
    t0 = time.time()
    if user_config:
        write_user_config(user_config)
    from ovos_config import Configuration
    from ovos_utils.fakebus import FakeBus
    from ovos_bus_client.message import Message

    report("boot.settings")
    done = int(read_user_config().get("emkay_mobile_defaults") or 0)
    _phone_language()        # first: the defaults below depend on the language
    _phone_timezone()        # before skills load: some read it once (alerts)
    Configuration.reload()
    write_user_config(_browser_defaults(done))
    Configuration.reload()
    # the default session keeps its own copy of the configuration from when
    # it was made (location and time zone, but also the intent pipeline and
    # its blacklist), and it was made before the steps above: make it again
    # from what they wrote, as the browser PHAL plugin does for a new location
    from ovos_bus_client.session import SessionManager
    SessionManager.reset_default_session()
    if sys.platform == "emscripten":
        browser.adapt_ovos()

    from ovos_core.skill_manager import SkillManager
    _bus = FakeBus()
    if on_message is not None:
        _bus.on("message", on_message)
    _follow_config_changes(_bus)
    if sys.platform == "emscripten":
        _browser_installer()
    with _BootSteps() as steps:   # the start screen follows each step
        _manager = SkillManager(_bus,
                                enable_file_watcher=False,   # nothing edits files behind OVOS here
                                enable_installer=True,       # ovos.pip.install, see pip.py
                                enable_event_scheduler=True,
                                enable_skill_api=True,
                                enable_intent_service=True)
        if _manager.event_scheduler is not None and sys.platform == "emscripten":
            _drive_scheduler(_manager.event_scheduler)
        # after an install or removal, SkillManager itself loads, reloads or
        # unloads skills (its handlers for ovos.pip.install.complete etc.)
        # SkillManager.run() minus its 30 s rescan loop (a service loop, see
        # browser.FOREVER_LOOPS): load the skills, then announce readiness.
        steps.manager = _manager
        steps.loading_skills = True
        _manager._load_new_skills()
    _bus.emit(Message("mycroft.skills.initialized"))
    _manager.status.set_ready()
    if sys.platform == "emscripten":
        _warm_models_soon()
    loaded = sorted(_manager.plugin_skills.keys())
    return {"seconds": round(time.time() - t0, 2), "skills": loaded,
            "lang": Configuration().get("lang", "en-US"),
            "wake_word": Configuration().get("listener", {}).get("wake_word"),
            # the wake word's own settings (hotwords.<name>: module, model,
            # sensitivity, trigger_level), as ovos-dinkum-listener loads its
            # plugin from them; the page runs the same engine (wakeword.js)
            "hotword": Configuration().get("hotwords", {}).get(
                Configuration().get("listener", {}).get("wake_word") or "", {}),
            "stt_module": Configuration().get("stt", {}).get("module"),
            # where it hears and speaks, for the privacy chip (web/privacy.js)
            "speech_route": privacy.route(),
            # how the page listens, from OVOS' own listener settings
            # (ovos-dinkum-listener's): end of speech, time limits, the
            # confirm-listening sound
            "listener": {k: Configuration().get("listener", {}).get(k) for k in
                         ("silence_end", "recording_timeout", "recording_timeout_with_silence")},
            "confirm_listening": Configuration().get("confirm_listening", True),
            "start_listening_sound": Configuration().get("sounds", {}).get(
                "start_listening", "snd/start_listening.wav"),
            "error_sound": Configuration().get("sounds", {}).get("error", "snd/error.mp3"),
            "skipped_threads": list(browser.STARTED)}


def utterance(text: str, lang: str = None, session=None):
    """Put what the user said on the bus, the way ovos-dinkum-listener does."""
    from ovos_bus_client.message import Message
    from ovos_bus_client.session import SessionManager
    from ovos_config import Configuration
    lang = lang or Configuration().get("lang", "en-US")
    sess = session or SessionManager.get_default_session()
    _bus.emit(Message("recognizer_loop:utterance",
                      {"utterances": [text], "lang": lang},
                      {"session": sess.serialize(), "source": "emkay",
                       "destination": "skills"}))


def emit(msg_type: str, data: dict = None, context: dict = None):
    """Emit one message on the bus."""
    from ovos_bus_client.message import Message
    _bus.emit(Message(msg_type, data or {}, context or {}))


def bus():
    """The bus OVOS runs on (None before start())."""
    return _bus
