"""Stand-in for onnxruntime: the model runs in onnxruntime-web, in the
speech worker (web/ortshim.js), so it holds up neither the page nor Pyodide.

Python waits for each run with JSPI (pyodide.ffi.run_sync), so a session can
only be used from a call stack that can wait: an event-loop callback or a
command the worker calls with callPromising (room audio, a recording). Where
the browser has no JSPI, creating a session fails at once, so a plugin that
needs one stays off rather than failing on every chunk.

Only what OVOS' plugins use is here (ovos-ww-plugin-wakeforge's featurizer):
InferenceSession(path, options, providers), get_inputs/get_outputs (.name),
run(output_names, feeds) with numpy arrays, SessionOptions,
GraphOptimizationLevel and get_available_providers.
"""
import enum

import numpy as np

__version__ = "0.0.0+emkay"

#: numpy dtype <-> onnxruntime-web tensor type
_TYPES = {np.dtype("float32"): "float32", np.dtype("float64"): "float64",
          np.dtype("int64"): "int64", np.dtype("int32"): "int32", np.dtype("int16"): "int16",
          np.dtype("int8"): "int8", np.dtype("uint8"): "uint8", np.dtype("bool"): "bool"}
_DTYPES = {v: k for k, v in _TYPES.items()}


class GraphOptimizationLevel(enum.IntEnum):
    ORT_DISABLE_ALL = 0
    ORT_ENABLE_BASIC = 1
    ORT_ENABLE_EXTENDED = 2
    ORT_ENABLE_ALL = 99


class ExecutionMode(enum.IntEnum):
    ORT_SEQUENTIAL = 0
    ORT_PARALLEL = 1


class SessionOptions:
    """Accepted and ignored: onnxruntime-web runs single-threaded here."""

    def __init__(self):
        self.intra_op_num_threads = 1
        self.inter_op_num_threads = 1
        self.graph_optimization_level = GraphOptimizationLevel.ORT_ENABLE_ALL
        self.execution_mode = ExecutionMode.ORT_SEQUENTIAL
        self.log_severity_level = 2
        self.enable_cpu_mem_arena = True
        self.enable_mem_pattern = True

    def add_session_config_entry(self, key, value):
        pass


def get_available_providers():
    return ["CPUExecutionProvider"]


def get_device():
    return "CPU"


class NodeArg:
    def __init__(self, name):
        self.name = name
        self.shape = None
        self.type = None

    def __repr__(self):
        return f"NodeArg(name={self.name!r})"


def _wait(promise):
    from pyodide.ffi import run_sync
    return run_sync(promise)


class InferenceSession:
    def __init__(self, path_or_bytes, sess_options=None, providers=None, **kw):
        from emkay_mobile import speech
        if not speech.jspi():
            raise RuntimeError("onnxruntime here needs JSPI (the browser can't wait for the model)")
        if isinstance(path_or_bytes, (bytes, bytearray)):
            self._model = bytes(path_or_bytes)
        else:
            with open(path_or_bytes, "rb") as f:
                self._model = f.read()
        self._id = None
        self._inputs = self._outputs = None

    def _open(self):
        """The session in the speech worker, made the first time it is used
        (at boot Python can't wait; the first room audio can)."""
        if self._id is None:
            import js
            from pyodide.ffi import to_js
            got = _wait(js.emkayOrt.create(to_js(self._model))).to_py()
            self._id, self._inputs, self._outputs = got["id"], list(got["inputs"]), list(got["outputs"])
            self._model = None          # onnxruntime-web has it now
        return self._id

    def get_inputs(self):
        self._open()
        return [NodeArg(n) for n in self._inputs]

    def get_outputs(self):
        self._open()
        return [NodeArg(n) for n in self._outputs]

    def get_providers(self):
        return get_available_providers()

    def run(self, output_names, input_feed, run_options=None):
        import js
        from pyodide.ffi import to_js
        sid = self._open()
        names = list(output_names or self._outputs)
        feeds = []
        for name, value in input_feed.items():
            a = np.ascontiguousarray(value)
            feeds.append(js.Object.fromEntries(to_js([
                ["name", name], ["type", _TYPES[a.dtype]], ["dims", list(a.shape)],
                ["data", to_js(a.tobytes())]])))
        out = _wait(js.emkayOrt.run(sid, to_js(names), to_js(feeds))).to_py()
        result = []
        for o in out:
            data = bytes(o["data"])
            result.append(np.frombuffer(data, dtype=_DTYPES[o["type"]]).reshape(list(o["dims"])).copy())
        return result
