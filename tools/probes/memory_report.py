# Where Emkay's Python memory goes, run inside the worker (memory_browser.mjs).
# Prints JSON: Pyodide's WebAssembly heap, the files in its file system by
# folder, and what each skill and each package keeps alive (sizes of the
# objects reachable from it; an object is counted once, for whoever reached
# it first: skills, then packages).
import gc, json, logging, os, sys, types

import pyodide_js

out = {"wasm_heap_mb": round(pyodide_js._module.HEAPU8.byteLength / 2**20)}

# --- files (MEMFS / IDBFS: all of them in memory) -----------------------------
files = {}
for top in ("/lib", "/home", "/tmp", "/usr"):
    for root, dirs, names in os.walk(top):
        parts = root.split("/")
        key = "/".join(parts[:6]) if "site-packages" in root else "/".join(parts[:5])
        if "site-packages/" in root + "/":
            i = parts.index("site-packages")
            key = "/".join(parts[:i + 2])
        for n in names:
            try:
                files[key] = files.get(key, 0) + os.lstat(os.path.join(root, n)).st_size
            except OSError:
                pass
out["files_mb"] = round(sum(files.values()) / 2**20, 1)
out["files_top"] = [[k, round(v / 2**20, 1)] for k, v in sorted(files.items(), key=lambda x: -x[1])[:25]]

# --- objects --------------------------------------------------------------
seen = set()
module_dicts = {id(m.__dict__) for m in list(sys.modules.values()) if isinstance(m, types.ModuleType)}


def deep(root, owner_module=None, stop=()):
    """Bytes of the objects reachable from root not counted yet."""
    total, stack = 0, [root]
    stop = {id(s) for s in stop}
    while stack:
        x = stack.pop()
        i = id(x)
        if i in seen or i in stop:
            continue
        if isinstance(x, types.ModuleType) and x is not root:
            continue
        if i in module_dicts and x is not root:
            continue
        if owner_module is not None and isinstance(x, (type, types.FunctionType)) \
                and getattr(x, "__module__", None) != owner_module:
            continue
        # a skill: its own data only, not the classes and code every skill
        # shares (counted for whichever skill came first, otherwise)
        if owner_module is None and isinstance(x, (type, types.FunctionType, types.CodeType,
                                                   types.BuiltinFunctionType, types.MethodType,
                                                   # every skill's logger reaches Python's
                                                   # whole logging registry
                                                   logging.Logger, logging.Manager)) \
                and x is not root:
            continue
        seen.add(i)
        try:
            total += sys.getsizeof(x)
        except Exception:
            pass
        try:
            stack.extend(gc.get_referents(x))
        except Exception:
            pass
    return total


gc.collect()
from ovos_workshop.skills.ovos import OVOSSkill
skills = [o for o in gc.get_objects() if isinstance(o, OVOSSkill)]
buses = [getattr(s, "bus", None) for s in skills]
shared = [b for b in buses if b is not None]
try:
    from ovos_config import Configuration
    shared.append(Configuration())
except Exception:
    pass
per_skill = []
for s in skills:
    others = [o for o in skills if o is not s]
    per_skill.append([getattr(s, "skill_id", type(s).__name__), deep(s, stop=others + shared)])
out["skills_mb"] = round(sum(v for _, v in per_skill) / 2**20, 1)
out["skills"] = [[k, round(v / 2**20, 2)] for k, v in sorted(per_skill, key=lambda x: -x[1])]

per_pkg = {}
for name, m in sorted(sys.modules.items()):
    if not isinstance(m, types.ModuleType) or name in ("__main__", "__mp_main__"):   # this report's own
        continue
    top = name.split(".")[0]
    per_pkg[top] = per_pkg.get(top, 0) + deep(m.__dict__, owner_module=name)
out["packages_mb"] = round(sum(per_pkg.values()) / 2**20, 1)
out["packages_top"] = [[k, round(v / 2**20, 1)] for k, v in sorted(per_pkg.items(), key=lambda x: -x[1])[:30]]
out["modules_loaded"] = len(sys.modules)

# compiled extensions loaded (WebAssembly side modules: their code is compiled
# by the browser, outside the heap above)
so = {}
for name, m in list(sys.modules.items()):
    f = getattr(m, "__file__", None) or ""
    if f.endswith(".so"):
        try:
            so[name.split(".")[0]] = so.get(name.split(".")[0], 0) + os.path.getsize(f)
        except OSError:
            pass
out["extensions_mb"] = round(sum(so.values()) / 2**20, 1)
out["extensions_top"] = [[k, round(v / 2**20, 1)] for k, v in sorted(so.items(), key=lambda x: -x[1])[:12]]

# what is left: every other object the collector tracks
rest = 0
for o in gc.get_objects():
    if id(o) not in seen:
        try:
            rest += sys.getsizeof(o)
        except Exception:
            pass
out["other_tracked_mb"] = round(rest / 2**20, 1)
json.dumps(out)
