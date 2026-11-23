"""Where a pipeline plugin goes in OVOS' pipeline, worked out instead of read.

On a device a newly installed pipeline plugin does nothing until someone adds
it to `intents.pipeline` by hand, where its README says. Emkay places it
itself, by one rule that comes from OVOS, not from the README: a pipeline
plugin is either one stage, or (a ConfidenceMatcherPipeline) three stages,
`<id>-high`, `<id>-medium` and `<id>-low`, as in OVOS' own default pipeline
(`ovos-padatious-pipeline-plugin-high`, ...). Each stage goes next to the
stages of the same confidence:

- `-high`   after the last high stage of the first block (before the first
            medium stage): sure matches are tried before any unsure one
- `-medium` before the medium fallbacks (else after the last medium stage)
- `-low`    before the low fallbacks (else at the end)
- one stage before the medium fallbacks, like common query

A plugin whose README asks for something else gets an entry in OVERRIDES.
Only plugins installed after Emkay first saw the pipeline are placed
(`emkay.pipelines_seen` in the user mycroft.conf), so the ones Emkay ships
unused stay unused, and a stage the user took out is not put back.
"""

#: placements the rule gets wrong: plugin id -> {stage: (where, anchors)}.
#: "after": right after the first anchor found; "before": right before it;
#: "first": first in the pipeline; "skip": that stage is left out (a plugin
#: that only uses some of its three).
OVERRIDES = {
    # its README: first, so it sees every utterance before any stage claims
    # it; it observes and never matches
    "ovos-good-manners-pipeline-plugin": {
        None: ("first", []), "high": ("first", []), "medium": ("skip", []), "low": ("skip", []),
    },
    # one stage: right after OVOS' sure matches (the last high stage), before
    # common query, persona and the fallbacks - what Home Assistant's Assist
    # recognizes is HA's before a solver or a chatbot answers it (its README)
    "ovos-assist-pipeline-plugin": {
        None: ("after", ["ovos-adapt-pipeline-plugin-high", "adapt_high"]),
    },
    # its README: "-high" right after the stop matcher (so "stop" and
    # "continue" reach a reading in progress), "-low" after padatious/adapt,
    # before common query and the fallbacks
    "ovos-common-reading-pipeline-plugin": {
        "high": ("after", ["ovos-stop-pipeline-plugin-high", "stop_high"]),
        "medium": ("skip", []),
        "low": ("before", ["common_qa", "ovos-common-query-pipeline-plugin",
                           "fallback_medium", "ovos-fallback-pipeline-plugin-medium",
                           "fallback_low", "ovos-fallback-pipeline-plugin-low"]),
    },
}

_FALLBACK_MEDIUM = ["ovos-fallback-pipeline-plugin-medium", "fallback_medium"]
_FALLBACK_LOW = ["ovos-fallback-pipeline-plugin-low", "fallback_low"]


def _index(pipeline, anchors):
    found = [i for i, p in enumerate(pipeline) if p in anchors]
    return found[0] if found else None


def _rule_index(pipeline, stage):
    """Where the rule puts a stage of confidence `stage` (or None: one stage)."""
    if stage == "high":
        first_medium = next((i for i, p in enumerate(pipeline) if p.endswith("-medium")), len(pipeline))
        highs = [i for i, p in enumerate(pipeline[:first_medium]) if p.endswith("-high")]
        return highs[-1] + 1 if highs else 0
    if stage == "medium":
        i = _index(pipeline, _FALLBACK_MEDIUM)
        if i is not None:
            return i
        mediums = [i for i, p in enumerate(pipeline) if p.endswith("-medium")]
        return mediums[-1] + 1 if mediums else len(pipeline)
    if stage == "low":
        i = _index(pipeline, _FALLBACK_LOW)
        return len(pipeline) if i is None else i
    i = _index(pipeline, _FALLBACK_MEDIUM)                  # a single stage
    return len(pipeline) if i is None else i


def stages(plugin_id: str) -> list:
    """The matcher ids `plugin_id` registers, as OVOS' plugin manager lists them."""
    from ovos_plugin_manager.pipeline import OVOSPipelineFactory
    return [m for m in OVOSPipelineFactory.get_installed_pipeline_matcher_ids()
            if m == plugin_id or m.startswith(f"{plugin_id}-")]


def place(pipeline: list, plugin_id: str, matchers: list = None) -> list:
    """`pipeline` with `plugin_id`'s stages put where they belong ([] if it is
    already there or registers none). `matchers` defaults to stages()."""
    if not pipeline or any(p == plugin_id or p.startswith(f"{plugin_id}-") for p in pipeline):
        return []
    matchers = stages(plugin_id) if matchers is None else matchers
    over = OVERRIDES.get(plugin_id, {})
    out = list(pipeline)
    order = {"high": 0, "medium": 1, "low": 2}
    for m in sorted(matchers, key=lambda m: order.get(m.rsplit("-", 1)[-1], 1)):
        stage = m.rsplit("-", 1)[-1] if m != plugin_id else None
        if stage in over:
            where, anchors = over[stage]
            if where == "skip":
                continue
            if where == "first":
                out.insert(0, m)
                continue
            i = _index(out, anchors)
            i = (len(out) if where == "before" else 0) if i is None else (i + 1 if where == "after" else i)
        else:
            i = _rule_index(out, stage)
        out.insert(i, m)
    return out


def place_new(pipeline: list, seen) -> tuple:
    """(new pipeline or [], new seen list) for the pipeline plugins installed
    since `seen` (None: nothing seen yet, so nothing is new)."""
    from ovos_plugin_manager.pipeline import OVOSPipelineFactory
    installed = sorted(OVOSPipelineFactory.get_installed_pipeline_ids())
    if seen is None:
        return [], installed
    out = list(pipeline)
    for plugin_id in installed:
        if plugin_id not in seen:
            out = place(out, plugin_id) or out
            print(f"[emkay] pipeline: placed {plugin_id} by the rule")
    return (out if out != list(pipeline) else []), sorted(set(seen) | set(installed))


#: the MediaProvider plugins OCP had when last (re)loaded
_providers_seen = None


def _installed_media_providers() -> set:
    import importlib
    from importlib.metadata import entry_points
    importlib.invalidate_caches()   # a package installed a moment ago
    return {ep.name for ep in entry_points(group="opm.media.provider")}


def reload_media_providers():
    """Load newly installed MediaProvider plugins into the running OCP.

    OCP (ovos-ocp-pipeline-plugin) loads its MediaProviders (opm.media.provider:
    ovos-media-provider-pyradios, -somafm, -news, ...; they replace the old
    OCP search skills) once, when the pipeline starts. ovos-core's
    intent.service.pipelines.reload would build a second OCP beside the
    running one, so OCP's own loader is run again instead. Only when the
    installed set changed. A candidate for OCP itself (reload on
    ovos.pip.install.complete).
    """
    global _providers_seen
    now = _installed_media_providers()
    if _providers_seen is not None and now == _providers_seen:
        return
    first = _providers_seen is None
    _providers_seen = now
    if first:
        return   # OCP loaded these at boot
    from . import boot
    service = getattr(getattr(boot, "_manager", None), "intents", None)   # IntentService
    for plugin in (getattr(service, "pipeline_plugins", None) or {}).values():
        if hasattr(plugin, "_load_media_providers"):
            plugin._load_media_providers()
            print(f"[emkay] OCP media providers: {sorted(plugin.media_providers)}")


def on_installed(message=None):
    """After an install (ovos.pip.install.complete): place any new pipeline
    plugin now, and have ovos-core load it (intent.service.pipelines.reload,
    its own message for that), so it answers without a restart. A new
    MediaProvider goes into the running OCP (reload_media_providers)."""
    try:
        reload_media_providers()
    except Exception as e:   # an install must not fail on this
        print(f"[emkay] media providers not reloaded: {e!r}")
    from ovos_bus_client.message import Message
    from ovos_bus_client.session import SessionManager
    from ovos_config import Configuration
    from . import boot
    user = boot.read_user_config()
    pipeline = Configuration().get("intents", {}).get("pipeline", [])
    placed, seen = place_new(pipeline, user.get("emkay", {}).get("pipelines_seen"))
    if seen == user.get("emkay", {}).get("pipelines_seen"):
        return
    patch = {"emkay": {"pipelines_seen": seen}}
    if placed:
        patch["intents"] = {"pipeline": placed}
    boot.write_user_config(patch)
    Configuration.reload()
    if placed:
        # also into ovos-config's runtime patch layer, which sits above the
        # file: once anything patched `intents` there (the control panel
        # does), the file alone no longer decides the pipeline
        boot.bus().emit(Message("configuration.patch", {"config": {"intents": {"pipeline": placed}}}))
    SessionManager.reset_default_session()   # the default session keeps its own copy
    if placed:
        boot.bus().emit(Message("intent.service.pipelines.reload"))
