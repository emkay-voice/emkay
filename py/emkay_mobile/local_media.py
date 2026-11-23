"""Local media between the page and OVOS (emkay_local_media).

The page (web/localmedia.js) owns the folder: it lists it, reads the files'
first bytes for their tags and plays them. This side keeps the library the
media provider searches, answers the control panel's page, and passes the
page's buttons on to the page.

Page -> here (worker.js commands): listing, tags, done, page_state.
Bus: ovos.emkay.local_media.status (-> .response) for the panel; its
buttons (choose_folder, allow, choose_files, rescan, forget) go on to the
page as emkay.local_media {do: <button>}.
"""
import json

from emkay_local_media import PREFIX, library

ACTIONS = ("choose_folder", "allow", "choose_files", "rescan", "forget")

_post = None
#: what the page says about itself: can_folder (a folder picker), needs_permission
#: (a kept folder the browser asks for again), session (songs chosen for now only)
_page = {"can_folder": False, "needs_permission": False, "session": False}


def status() -> dict:
    lib = library()
    return {**lib.status(_page["can_folder"]), "has_folder": bool(lib.folder),
            "needs_permission": _page["needs_permission"], "session": _page["session"],
            "indexing": lib.state == "indexing"}


def listing(folder: str, entries: str, keep: bool) -> str:
    """The folder's audio from the page (JSON [{path, size, mtime}]) -> what
    to read of the files whose tags are wanted (JSON)."""
    _page["needs_permission"] = False
    _page["session"] = not keep
    return json.dumps(library().listing(folder, json.loads(entries), keep=keep))


def tags(path: str, head: bytes, tail: bytes):
    library().tags(path, head, tail)


def done(keep: bool = True):
    lib = library()
    lib.state = "ready" if lib.files else "none"
    if keep:
        lib.save()


def page_state(raw: str):
    _page.update({k: bool(v) for k, v in json.loads(raw).items() if k in _page})


def forget():
    library().forget()
    _page.update(needs_permission=False, session=False)


def start(bus, post):
    """`post(payload)`: a message to the page."""
    global _post
    _post = post
    from ovos_bus_client.message import Message

    def answer(message):
        msg = Message.deserialize(message) if isinstance(message, str) else message
        bus.emit(msg.response(status()))
    bus.on(PREFIX + "status", answer)
    for action in ACTIONS:
        bus.on(PREFIX + action, lambda m, a=action: _post({"type": "emkay.local_media", "data": {"do": a}}))
