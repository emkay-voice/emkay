"""Local media in Emkay: your own music, played from a folder on the device.

The browser owns the files: the page (web/localmedia.js) is given a folder
(or, where a browser has no folder picker, some songs), lists the audio in
it and hands OVOS each file's first bytes, from which tinytag reads the
tags as it would on a device. The files themselves stay where they are:
nothing is copied, and nothing leaves the device.

The search is ovos-media-provider-local's (its scoring, its Releases); only
the index comes from the page, and the uri is ``file:///emkay-local/<path>``
(OCP keeps only uris it knows how to play: file:// is one), which the page
plays from the folder (web/media.js). The index is kept between
starts, so only new or changed files are read again.

Bus (``ovos.emkay.local_media.``), for the control panel's page:
``status`` -> ``.status.response`` {folder, songs, state, can_folder};
``choose_folder``, ``choose_files``, ``forget`` go to the page.
"""
import io
import json
import os
from dataclasses import asdict
from typing import ClassVar, Dict, List, Optional
from urllib.parse import quote

from ovos_utils.log import LOG

from ovos_media_provider_local import LocalMediaProvider
from ovos_media_provider_local.indexer import (AUDIO_EXTENSIONS, IndexedFile, _extension,
                                               _title_from_filename)

PREFIX = "ovos.emkay.local_media."
#: where the page's files are, as OCP sees them: a file:// uri (OCP drops
#: results whose uri it has no player or extractor for), outside Pyodide's
#: own files; the page knows it (web/media.js)
URI = "file:///emkay-local/"
#: the bytes of a file's start the page sends, for its tags (FLAC and M4A
#: keep theirs there, with a cover image that can be large)
HEAD = 256 * 1024
#: and of its end: ID3v1 for most, the last Ogg page (its length), and MP4's
#: moov box, which many programs write last (title, artist, length)
TAIL = 128
TAILS = {"ogg": 64 * 1024, "oga": 64 * 1024, "opus": 64 * 1024,
         "m4a": 512 * 1024, "m4b": 512 * 1024, "m4p": 512 * 1024, "alac": 512 * 1024}


def wanted_bytes(path: str) -> dict:
    """What the page reads of a file for its tags: {path, head, tail} (bytes)."""
    return {"path": path, "head": HEAD, "tail": TAILS.get(_extension(path), TAIL)}
STATE = os.path.expanduser("~/.local/share/emkay-mobile/local-media.json")


class PageFile(IndexedFile):
    """A file in the folder the page was given."""

    @property
    def uri(self) -> str:
        return URI + quote(self.path)


class _Sparse(io.RawIOBase):
    """A file of `size` bytes of which only the start and the end are known
    (the rest reads as zeros): enough for tinytag's tags and length."""

    def __init__(self, head: bytes, tail: bytes, size: int):
        super().__init__()
        self.head, self.tail, self.size, self.pos = head, tail, max(size, len(head)), 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        base = {0: 0, 1: self.pos, 2: self.size}[whence]
        self.pos = max(0, base + offset)
        return self.pos

    def tell(self):
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray(n)
        start, end = self.pos, self.pos + n
        if start < len(self.head):
            part = self.head[start:min(end, len(self.head))]
            out[:len(part)] = part
        tail_at = self.size - len(self.tail)
        if self.tail and end > tail_at:
            a = max(start, tail_at)
            out[a - start:end - start] = self.tail[a - tail_at:end - tail_at]
        self.pos = end
        return bytes(out)

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def read_tags(path: str, head: bytes, tail: bytes, size: int) -> dict:
    """tinytag's tags from a file's start and end, as on a device."""
    try:
        from tinytag import TinyTag
        tag = TinyTag.get(filename=path, file_obj=_Sparse(head, tail, size), image=False)
    except Exception:
        LOG.debug(f"no tags read from {path}", exc_info=True)
        return {}
    out = {k: str(getattr(tag, k)) for k in ("title", "artist", "album", "genre") if getattr(tag, k, None)}
    if tag.duration:
        out["duration"] = float(tag.duration)
    return out


class Library:
    """The page's folder: {path: PageFile}, with each file's size and mtime."""

    def __init__(self, path: str = STATE):
        self.path = path
        self.files: Dict[str, PageFile] = {}
        self.stamp: Dict[str, list] = {}       # path -> [size, mtime]
        self.folder = ""
        self.state = "none"                    # none | permission | indexing | ready
        self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        self.folder = data.get("folder", "")
        for d in data.get("files", []):
            stamp = d.pop("stamp", None)
            try:
                self.files[d["path"]] = PageFile(**d)
                self.stamp[d["path"]] = stamp
            except (TypeError, KeyError):
                continue
        if self.files:
            self.state = "ready"

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        data = {"folder": self.folder,
                "files": [{**asdict(f), "stamp": self.stamp.get(p)} for p, f in self.files.items()]}
        with open(self.path + ".part", "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(self.path + ".part", self.path)

    def listing(self, folder: str, entries: List[dict], keep: bool = True) -> List[dict]:
        """The page's list of the folder's audio [{path, size, mtime}]: drop
        what is gone, and return what to read of the files whose tags must
        be read (wanted_bytes). Songs
        chosen for this session only (keep=False) are not saved."""
        self.folder = folder
        wanted, seen = [], set()
        for e in entries:
            path = str(e.get("path") or "")
            if _extension(path) not in AUDIO_EXTENSIONS:
                continue
            seen.add(path)
            stamp = [int(e.get("size") or 0), float(e.get("mtime") or 0)]
            if path not in self.files or self.stamp.get(path) != stamp:
                self.files[path] = PageFile(path=path, is_audio=True, mtime=stamp[1],
                                            title=_title_from_filename(path))
                self.stamp[path] = stamp
                wanted.append(wanted_bytes(path))
        for gone in set(self.files) - seen:
            self.files.pop(gone, None)
            self.stamp.pop(gone, None)
        self.state = "indexing" if wanted else "ready"
        if keep:
            self.save()
        return wanted

    def tags(self, path: str, head: bytes, tail: bytes):
        f = self.files.get(path)
        if f is None:
            return
        size = (self.stamp.get(path) or [0])[0] or len(head)
        t = read_tags(path, head, tail, size)
        f.title = t.get("title") or f.title
        f.artist, f.album = t.get("artist", ""), t.get("album", "")
        f.genres = [t["genre"]] if t.get("genre") else []
        f.duration = t.get("duration")

    def forget(self):
        self.files.clear()
        self.stamp.clear()
        self.folder = ""
        self.state = "none"
        self.save()

    def status(self, can_folder: bool = False) -> dict:
        return {"folder": self.folder, "songs": len(self.files), "state": self.state,
                "can_folder": bool(can_folder)}


#: the one library, shared by the provider and Emkay's worker (worker_main)
_LIBRARY: Optional[Library] = None


def library() -> Library:
    global _LIBRARY
    if _LIBRARY is None:
        _LIBRARY = Library()
    return _LIBRARY


class _PageIndex:
    """What LocalMediaProvider.search reads: refresh() and files."""

    def refresh(self):
        pass

    @property
    def files(self):
        return list(library().files.values())


class EmkayLocalMedia(LocalMediaProvider):
    """ovos-media-provider-local, with the index from the page's folder."""

    name: ClassVar[str] = "emkay-local"

    def __init__(self, config: Optional[dict] = None):
        super().__init__(config)
        self.index = _PageIndex()
