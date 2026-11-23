"""Hugging Face files a plugin asks for, from the site itself.

A page can't use huggingface_hub's own download: it needs response headers
(X-Repo-Commit, ETag) that a cross-origin page may not read. The files a
plugin needs at a pinned revision ship with the site instead
(tools/fetch_wakeword_models.py, HF_FILES: oww/hf/<repo>/<revision>/), and
this fetches them from there into Pyodide's file system, once.

Used for ovos-ww-plugin-wakeforge's featurizer (WakePhoneHuBERT), which
ovos-audio-transformer-plugin-overheard-manners listens with. Its model
only runs with JSPI (shims/onnxruntime), so without JSPI nothing is
fetched: the plugin stays off at once.
"""
import os

CACHE = os.path.expanduser("~/.cache/emkay-hf")


def _site_base() -> str:
    """The site's root: worker.js sits there."""
    import js
    return str(js.location.href).rsplit("/", 1)[0] + "/"


def hf_hub_download(repo_id, filename, revision=None, **kw):
    """huggingface_hub.hf_hub_download for the files the site ships."""
    from . import speech
    if not speech.jspi():
        raise RuntimeError("this model needs JSPI to run here; not fetched")
    if not revision:
        raise FileNotFoundError(f"{repo_id}/{filename}: the site ships pinned revisions only")
    path = os.path.join(CACHE, repo_id, revision, filename)
    if not os.path.exists(path):
        import urllib.request
        url = f"{_site_base()}oww/hf/{repo_id}/{revision}/{filename}"
        with urllib.request.urlopen(url) as r:
            data = r.read()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
    return path


def install():
    """wakeforge's pretrained featurizers come from the site."""
    try:
        from ovos_ww_plugin_wakeforge import pretrained
    except ImportError:
        return
    pretrained.hf_hub_download = hf_hub_download
