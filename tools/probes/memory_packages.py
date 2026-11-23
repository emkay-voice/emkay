# Each package in site-packages: its files (in memory, MEMFS), whether it is
# imported, how many modules, and the objects its modules keep (MB).
import gc, json, os, site, sys, types

sp = site.getsitepackages()[0]
module_dicts = {id(m.__dict__) for m in list(sys.modules.values()) if isinstance(m, types.ModuleType)}
seen = set()


def deep(root, owner):
    total, stack = 0, [root]
    while stack:
        x = stack.pop()
        i = id(x)
        if i in seen or isinstance(x, types.ModuleType) or (i in module_dicts and x is not root):
            continue
        if isinstance(x, (type, types.FunctionType)) and getattr(x, "__module__", None) != owner:
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


def files_of(path):
    if os.path.isfile(path):
        return os.path.getsize(path)
    n = 0
    for root, _, names in os.walk(path):
        for f in names:
            try:
                n += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return n


# top-level names in site-packages -> files
tops = {}
for name in os.listdir(sp):
    if name.endswith((".dist-info", ".pth")) or name == "__pycache__":
        continue
    key = name[:-3] if name.endswith(".py") else name.split(".")[0]
    tops[key] = tops.get(key, 0) + files_of(os.path.join(sp, name))

mods = {}
gc.collect()
for name, m in sorted(sys.modules.items()):
    if not isinstance(m, types.ModuleType) or name in ("__main__", "__mp_main__"):
        continue
    f = getattr(m, "__file__", "") or ""
    top = name.split(".")[0]
    rec = mods.setdefault(top, [0, 0, f.startswith(sp)])
    rec[0] += 1
    rec[1] += deep(m.__dict__, name)

rows = []
for top in set(tops) | {k for k, v in mods.items() if v[2]}:
    n, objs, _ = mods.get(top, [0, 0, True])
    rows.append([top, round(tops.get(top, 0) / 2**20, 2), n, round(objs / 2**20, 2)])
rows.sort(key=lambda r: -(r[1] + r[3]))
stdlib = sorted(((k, v[0], round(v[1] / 2**20, 2)) for k, v in mods.items() if not v[2]), key=lambda r: -r[2])
json.dumps({"site_packages_mb": round(sum(tops.values()) / 2**20, 1),
            "imported_tops": sum(1 for r in rows if r[2]), "not_imported_tops": sum(1 for r in rows if not r[2]),
            "not_imported_mb": round(sum(r[1] for r in rows if not r[2]), 1),
            "rows": rows, "stdlib_top": stdlib[:15], "modules": len(sys.modules)})
