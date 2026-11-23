"""PHAL plugins the user installs, started as OVOS' PHAL service would.

Emkay runs no PHAL service: the browser tab is its one device, and
ovos-phal-plugin-browser its plugin (worker_main.py). A PHAL plugin
installed later (the panel's Plugins page, the store, ovos.pip.install) was
therefore never started. This starts one when its install completes, and
again at every boot after that: the plugins are remembered by their entry
point names in the state folder, which Emkay keeps. The ones Emkay ships with
(SHIPPED, from requirements/browser.txt) start at every boot as well - they
were never installed, so never remembered.

Each is made as the PHAL service makes it: its validator asked whether it
fits this device, then the class with the bus and its part of the
configuration (PHAL.<name>). One that fails is logged and left out; the rest
of Emkay does not depend on it. E.g. ovos-phal-plugin-midi, whose synth then
plays through the page (its ovos.midi.pcm, web/app.js midiOut).
"""
from __future__ import annotations

import json
from pathlib import Path

BUILT_IN = {"ovos-phal-plugin-browser"}
#: in Emkay's build (requirements/browser.txt): the MIDI instrument that
#: karaoke, the jam band and the music teacher play on
SHIPPED = ("ovos-phal-plugin-midi",)
_running: dict = {}
_known: set | None = None    # the entry points there were before an install


def _state_file() -> Path:
    from ovos_utils.xdg_utils import xdg_state_home
    return Path(xdg_state_home()) / "emkay" / "phal_plugins.json"


def _remembered() -> list:
    try:
        return json.loads(_state_file().read_text())
    except (OSError, ValueError):
        return []


def _remember(names):
    p = _state_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(sorted(set(names))))


def _entry_points() -> dict:
    from ovos_plugin_manager.phal import find_phal_plugins
    try:
        return find_phal_plugins()
    except Exception as e:
        print(f"[emkay] PHAL plugins: {e!r}")
        return {}


def _start(bus, name, cls) -> bool:
    if name in _running or name in BUILT_IN:
        return name in _running
    from ovos_config import Configuration
    cfg = Configuration().get("PHAL", {}).get(name, {})
    if cfg.get("enabled", True) is False:
        return False
    try:
        validator = getattr(cls, "validator", None)
        if validator is not None and not validator.validate(cfg):
            print(f"[emkay] PHAL plugin {name}: not for this device")
            return False
        _running[name] = cls(bus=bus, config=cfg)
        print(f"[emkay] PHAL plugin {name} started")
        return True
    except Exception as e:
        print(f"[emkay] PHAL plugin {name} not started: {e!r}")
        return False


def start(bus):
    """At boot: the plugins Emkay ships with and those installed before; then
    follow new installs."""
    global _known
    found = _entry_points()
    _known = set(found)
    for name in list(SHIPPED) + _remembered():
        if name in found:
            _start(bus, name, found[name])
    bus.on("ovos.pip.install.complete", lambda _m: installed(bus))


def installed(bus):
    """After an install: start the PHAL plugins it brought, and remember them."""
    global _known
    found = _entry_points()
    new = [n for n in found if n not in (_known or set()) and n not in BUILT_IN]
    _known = set(found)
    started = [n for n in new if _start(bus, n, found[n])]
    if started:
        _remember(_remembered() + started)
