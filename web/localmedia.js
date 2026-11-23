// Emkay – your own music, from a folder on this device (#108).
//
// The page owns the files: it is given a folder (File System Access, kept
// in IndexedDB so it is chosen once) or, where a browser has no folder
// picker (phones), some songs for this session. It lists the audio in it,
// and for new or changed files hands OVOS their first (and last) bytes, from
// which tinytag reads title, artist and album as on a device
// (py/emkay_local_media). "Play <song>" then finds them through OCP, and
// web/media.js plays emkay-local:<path> from here. Nothing is copied and
// nothing leaves the device.
//
// A kept folder needs the browser's permission again after a restart, and
// asking needs a tap: the control panel's page (Local media) and a small
// note on the face offer it.

const DB = "emkay-local-media";
const AUDIO = new Set(["aac", "ac3", "aiff", "amr", "ape", "au", "flac", "alac", "m4a", "m4b", "m4p",
  "mp2", "mp3", "mpc", "oga", "ogg", "opus", "wav", "wma"]);
const BATCH = 8;          // files whose bytes cross to the worker together

const ext = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = fn(tx.objectStore("handles"));
      tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
const kept = () => idb("readonly", (s) => s.get("folder")).catch(() => null);
const keep = (h) => idb("readwrite", (s) => s.put(h, "folder"));
const drop = () => idb("readwrite", (s) => s.delete("folder"));

/**
 * @param {object} o
 * @param {(cmd: string, args?: object, transfer?: Transferable[]) => Promise<any>} o.call  worker.js commands
 * @param {(on: boolean) => void} o.askTap  show/hide the "allow the music folder" note on the face
 */
export function createLocalMedia({ call, askTap }) {
  const canFolder = typeof window.showDirectoryPicker === "function";
  let folder = null;              // the kept FileSystemDirectoryHandle
  let handles = new Map();        // path -> FileSystemFileHandle (folder) or File (session songs)
  let scanning = false;

  const tell = (state) => call("local_media_page", { state: { can_folder: canFolder, ...state } }).catch(() => {});

  async function walk(dir, prefix, out) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith(".")) continue;
      const path = `${prefix}/${name}`;
      if (h.kind === "directory") await walk(h, path, out);
      else if (AUDIO.has(ext(name))) out.set(path, h);
    }
  }

  /** Hand OVOS the folder's list, then the bytes of what it wants to read. */
  async function index(name, files, keepIt) {
    if (scanning) return;
    scanning = true;
    try {
      const entries = [];
      const opened = new Map();
      for (const [path, h] of files) {
        const f = h instanceof File ? h : await h.getFile();
        opened.set(path, f);
        entries.push({ path, size: f.size, mtime: f.lastModified / 1000 });
      }
      const wanted = JSON.parse(await call("local_media_listing", { folder: name, entries, keep: keepIt }));
      for (let i = 0; i < wanted.length; i += BATCH) {
        await Promise.all(wanted.slice(i, i + BATCH).map(async ({ path, head, tail }) => {
          const f = opened.get(path);
          if (!f) return;
          const [h, t] = await Promise.all([f.slice(0, head).arrayBuffer(),
            f.slice(Math.max(0, f.size - tail)).arrayBuffer()]);
          await call("local_media_tags", { path, head: h, tail: t }, [h, t]);
        }));
      }
      await call("local_media_done", { keep: keepIt });
      console.log(`[emkay] local media: ${files.size} songs in ${name}, ${wanted.length} read`);
    } catch (e) {
      console.warn("[emkay] local media", e);
    } finally {
      scanning = false;
    }
  }

  async function scanFolder() {
    const files = new Map();
    await walk(folder, folder.name, files);
    handles = files;
    await index(folder.name, files, true);
  }

  async function allowed(h, ask) {
    const opts = { mode: "read" };
    if ((await h.queryPermission?.(opts)) === "granted") return true;
    return ask && (await h.requestPermission?.(opts)) === "granted";
  }

  const api = {
    canFolder,
    /** At the start: the kept folder, if the browser still lets us read it. */
    async start() {
      await tell({ needs_permission: false, session: false });
      folder = await kept();
      if (!folder) return;
      if (await allowed(folder, false)) return scanFolder();
      await tell({ needs_permission: true });
      askTap(true);
    },
    /** The browser's permission again for the kept folder (needs a tap). */
    async allow() {
      if (!folder) return;
      if (await allowed(folder, true)) {
        askTap(false);
        await tell({ needs_permission: false });
        await scanFolder();
      }
    },
    async chooseFolder() {
      if (!canFolder) return api.chooseFiles();
      try {
        folder = await window.showDirectoryPicker({ id: "emkay-music", mode: "read" });
      } catch (e) {
        if (e.name !== "AbortError") console.warn("[emkay] local media folder", e);
        return;
      }
      await keep(folder).catch((e) => console.warn("[emkay] could not keep the folder", e));
      askTap(false);
      await tell({ needs_permission: false, session: false });
      await scanFolder();
    },
    /** Songs for this session (no folder picker, or by choice). */
    chooseFiles() {
      const input = Object.assign(document.createElement("input"),
        { type: "file", multiple: true, accept: "audio/*,.flac,.m4a,.ogg,.opus" });
      input.onchange = () => api.useFiles(input.files);
      input.click();
    },
    /** Songs (File objects) for this session: chosen above, or a test's. */
    async useFiles(list) {
      const files = new Map([...list].filter((f) => AUDIO.has(ext(f.name)))
        .map((f) => [`songs/${f.name}`, f]));
      if (!files.size) return 0;
      handles = files;
      await tell({ session: true });
      await index("songs", files, false);
      return files.size;
    },
    async rescan() {
      if (folder && await allowed(folder, true)) await scanFolder();
    },
    async forget() {
      folder = null;
      handles = new Map();
      askTap(false);
      await drop().catch(() => {});
      await call("local_media_forget");
    },
    /** A button on the control panel's page (emkay.local_media {do}). */
    onBus(msg) {
      if (msg.type !== "emkay.local_media") return false;
      const act = { choose_folder: api.chooseFolder, allow: api.allow, choose_files: api.chooseFiles,
        rescan: api.rescan, forget: api.forget }[msg.data?.do];
      act?.();
      return true;
    },
    /** The File for an emkay-local: uri (web/media.js), or null. */
    async file(uri) {
      const path = decodeURIComponent(uri.slice("emkay-local:".length));
      const h = handles.get(path);
      if (!h) return null;
      return h instanceof File ? h : h.getFile();
    },
  };
  return api;
}
