"""Sort a wheelhouse into: Pyodide-provided, pure (to ship), and shimmed/dropped.

Usage: python3 tools/wheelplan.py WHEEL_DIR PYODIDE_LOCK.json  -> prints JSON plan
"""
import json
import re
import sys
from pathlib import Path

# native wheels with no WebAssembly build; emkay_mobile/shims stands in
SHIMMED = {"rapidfuzz", "pystemmer", "pyahocorasick", "marisa-trie", "psutil",
           "timezonefinder", "pexpect", "ptyprocess", "tokenizers",
           # onnxruntime-web runs the models (shims/onnxruntime, web/ortshim.js)
           "onnxruntime"}
DROPPED = {"hf-xet",               # optional huggingface_hub transfer backend
           "flatbuffers",          # onnxruntime's, which is shimmed
           "timezonefinder-data",  # data for timezonefinder, which the browser answers itself
           # uvicorn extras: the control panel app is called in-process, not served
           "uvloop", "httptools", "watchfiles", "websockets",
           # ovos-m2v-pipeline needs scikit-learn and skops only to convert a
           # legacy pipeline.skops head; every m2v model the site ships has
           # head.safetensors (tools/fetch_m2v_models.py), read with numpy.
           # Loading scipy and scikit-learn at every start took 8.5 s and
           # ~650 MB of the tab's memory (Node: 9.3 -> 0.8 s, 938 -> 286 MB
           # RSS), which a phone may not have. The rest is only theirs.
           "scikit-learn", "scipy", "skops", "threadpoolctl", "narwhals", "prettytable"}
# shipped as-is although tagged for a platform (pure Python inside)
# (tornado: its C speedups are optional; ovos-gui only imports it)
FORCE_PURE = {"watchdog", "tornado"}


def norm(n):
    return re.sub(r"[-_.]+", "-", n).lower()


def plan(wheel_dir, lock_path):
    lock = json.load(open(lock_path))["packages"]
    lock_names = {norm(k): k for k in lock}
    out = {"pyodide": [], "pure": [], "shimmed": [], "dropped": []}
    for whl in sorted(Path(wheel_dir).glob("*.whl")):
        name = norm(whl.name.split("-")[0])
        if name in DROPPED:
            out["dropped"].append(whl.name)
        elif name in SHIMMED:
            out["shimmed"].append(whl.name)
        elif name in lock_names and not whl.name.endswith("none-any.whl"):
            out["pyodide"].append(lock_names[name])
        elif name in lock_names and name in {"pydantic", "pydantic-core", "typing-inspection"}:
            # must match the pydantic-core Pyodide was built with
            out["pyodide"].append(lock_names[name])
        elif whl.name.endswith("none-any.whl") or name in FORCE_PURE:
            out["pure"].append(whl.name)
        else:
            out["dropped"].append(whl.name)
    return out


if __name__ == "__main__":
    print(json.dumps(plan(sys.argv[1], sys.argv[2]), indent=1))
