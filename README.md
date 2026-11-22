# Emkay

A stock [OpenVoiceOS](https://openvoiceos.org) running **in a browser** – on a
phone, a tablet, a TV or a Raspberry Pi in kiosk mode; no app store, no
sideloading, nothing to install – with the Mycroft Mark II Kickstarter face
([ovos-gui-visage](https://github.com/OscillateLabsLLC/ovos-gui-visage)) as the screen.

"Emkay" is "MK" said out loud, a nod to Mycroft's Mark I and Mark II.

> **Status: early alpha.** OVOS core, the installer's 22 default skills,
> ovos-gui with the homescreen and the Mark II face boot in the browser
> (about 2½ minutes the first time on a PC, longer on a phone). A typed or
> spoken question goes the whole way: intent, skill, the public OVOS TTS
> server, sound and the face's mouth. The stock ovos-control-panel opens
> from the ⚙ menu.
>
> Open it: <https://app.emkay.ai/> (built by GitHub Actions). Project page:
> <https://emkay.ai/>.

## What it is

The same OVOS an [ovos-installer](https://github.com/OpenVoiceOS/ovos-installer)
device gets, on the **alpha** channel, compiled to WebAssembly with
[Pyodide](https://pyodide.org):

| Part | What runs |
|---|---|
| Core | `ovos-core[plugins]` – SkillManager, IntentService and the pipeline plugins (m2v, padatious, adapt, …) on an in-process bus |
| Skills | the installer defaults: `ovos-core[skills-essential,skills-internet,skills-audio]`, plus skills that answer without servers (calculator, geography, geometry, NATO alphabet, morse code), short facts from Wikidata (who leads a country, where places are), jokes, reading aloud, internet radio and the news and Emkay's own (about Emkay, Guardian, the skill store, kiosk). Defaults that cannot work in a browser are switched off, and can be switched on again in the settings: DuckDuckGo and Wolfram Alpha (servers a web page may not read), speedtest, audio recording, dictation, IP address, diagnostics and boot-finished (they need the device itself). See [`requirements/browser.txt`](requirements/browser.txt) and `boot.py`. |
| Speech | on the device: `ovos-stt-plugin-whisper-browser` (Whisper, Røst for Danish) and `ovos-tts-plugin-piper-browser` (Piper), with OpenVoiceOS' public servers (`ovos-stt-plugin-server`, `ovos-tts-plugin-server`) as the fallback while the models download the first time; "Hey Emkay" as the wake word. Emkay's choice as a device (defaults v13, `boot.py`): what is said stays on the device, and the public servers are not used for every sentence. All of it can be changed in the settings. |
| Screen | `ovos-gui` + `ovos-skill-homescreen`, drawn by ovos-gui-visage (the Mark II face, Flutter web build) |
| Setup | the stock `ovos-control-panel`, in the ⚙ menu |
| Network | a log of everything Emkay contacts, by day and service, in the ⚙ menu ([docs/network-log.md](docs/network-log.md)) |
| Local only | "go offline": speech and voice on the phone, nothing you say leaves it, a shield on the screen ([docs/local-only.md](docs/local-only.md)) |
| Settings | speech recognition, voice and wake word change without a restart, with the download shown on screen; a new language offers a restart for its skills ([docs/settings-live.md](docs/settings-live.md)) |

See [`requirements/`](requirements) for the exact lists.

Skills install the usual way – they are Python packages, and everything in
`~/.config` and `~/.local` lives in the browser's IndexedDB. The control
panel's Backup page (⚙ → Control panel) downloads the settings to the
phone and restores them, so they survive clearing the browser.

## How it fits together

```
page (web/app.js)                 Web Worker (web/worker.js + Pyodide)
 ├─ ovos-gui-visage (frame) ◄───► BrowserGuiClient ─ ovos-gui ─┐
 │   core + gui websockets       (and every bus message)       │
 ├─ microphone → 16 kHz PCM  ───► speech.heard → STT plugin    ├─ FakeBus ─ ovos-core
 ├─ speaker ◄─ WAV + visemes ◄─── speech.on_speak → TTS plugin ┘            + skills
 └─ menu (⚙): where Emkay hears, speaks and thinks; Guardian; the store; the control panel (the stock OpenVoiceOS one, in Emkay's look); about
```

- `py/emkay_mobile/boot.py` starts OVOS the way `ovos_core.__main__` does.
- `py/emkay_mobile/gui.py` makes the page a GUI client of ovos-gui. The screen
  is ovos-gui-visage's web build, unchanged, in a frame
  ([`tools/fetch_visage2.py`](tools/fetch_visage2.py) takes it from its pinned
  Docker image); [`web/visage2-shim.js`](web/visage2-shim.js) gives it the two
  websockets its nginx sidecar gives it on a device: the bus and ovos-gui's
  legacy GUI socket. A tap on it starts listening.
- `py/emkay_mobile/speech.py` runs whatever STT/TTS plugin `mycroft.conf` names.
- `web/worker.js` downloads the bundle once, caches it, and mounts IndexedDB.

## How the browser differs from a device

We stay as close to OVOS as possible; these are the places where the browser
forces a workaround:

- **No threads.** Pyodide cannot start OS threads. Thread pools run their
  work at once, timers go on the browser event loop, `Event.wait` and
  `time.sleep` return at once, and service loops that never return are not
  started; the event scheduler is driven from the loop instead. A
  `Condition.wait`/`Queue.get` without a timeout raises where it was made
  instead of freezing the page, and ovos-workshop's scheduler-request
  thread is replaced by work on the loop
  ([`browser.py`](py/emkay_mobile/browser.py)).
- **Native packages without a WebAssembly build** (rapidfuzz, PyStemmer,
  pyahocorasick, marisa-trie, psutil, timezonefinder, tokenizers) get small
  pure-Python stand-ins ([`shims/`](py/emkay_mobile/shims)). The tokenizers
  stand-in is checked token for token against the real one
  (`tools/check_tokenizers_shim.py`).
- **m2v uses one model per language** (via the plugin's documented `models`
  setting) instead of the 141 MB multilingual default.
- **Padatious is pre-trained.** Training its networks takes minutes in
  WebAssembly, so [`tools/build_intent_cache.py`](tools/build_intent_cache.py)
  trains them on normal CPython with the same versions, one CI job per
  language, and the phone loads the cache. Padaos' prefilter warm-up is
  skipped (it only speeds queries up).
- **ovos-gui is held at 1.5.4a1** and its websocket server is not started; the
  page is its client directly. 1.6 moved GUI clients to adapter plugins
  (ovos-gui-plugin-visage), which is the way forward once it is released.
- **The phone's "hardware"** is a PHAL plugin whose device is the page
  ([ovos-phal-plugin-browser](https://github.com/emkay-voice/ovos-phal-plugin-browser), its own package). Volume answers `mycroft.volume.*`
  exactly like ovos-PHAL-plugin-alsa, with the page's output gain as the
  mixer. Location works like ovos-phal-plugin-ipgeo (assistant config
  layer, `ovos.ipgeo.update`), but from the browser's geolocation, since
  ipgeo's `http://` service cannot be called from an https page; until the
  user allows it, OVOS gets the browser's time zone. It ships as an
  ordinary installed PHAL plugin (`ovos-phal-plugin-browser`, entry point
  `opm.phal`), so the control panel sees it. Also in it, each with the bus
  contract of the plugin a device uses:
  - power, factory reset and language as ovos-PHAL-plugin-system
    (in [ovos-phal-plugin-browser](https://github.com/emkay-voice/ovos-phal-plugin-browser)): reboot and
    "restart the services" reload the page, shutdown darkens it until
    tapped, factory reset wipes what the system plugin wipes and starts
    over; there is no SSH;
  - connectivity as ovos-PHAL-plugin-connectivity-events, from the
    browser's online/offline state (in [ovos-phal-plugin-browser](https://github.com/emkay-voice/ovos-phal-plugin-browser));
  - the phone's sensors as ovos-PHAL-sensors reports them
    (`ovos.phal.sensor`, shown on the control panel's Sensors page):
    battery and charging, network type and speed, screen on and
    orientation, moving or still, how the phone lies (face up, face down,
    upright), compass direction, ambient light, storage, memory and CPU
    cores – whichever the browser has, and only when a value changes;
  - the camera as ovos-PHAL-plugin-camera (`ovos.phal.camera.*`), except
    that `b64_frame` is a JPEG rather than OpenCV's raw pixel buffer.
  The page side is [`device.js`](web/device.js).
- **Music, radio and podcasts** play through ovos-audio's own
  `AudioService`, unchanged, as on a device without ovos-media. Its player
  is [ovos-audio-plugin-browser](https://github.com/emkay-voice/ovos-audio-plugin-browser)
  (its own package) instead of mpv or vlc, which a browser cannot start: it
  sends each command as an `ovos.audio.browser.*` bus message, and the page
  plays it in an `<audio>` element ([`media.js`](web/media.js)) and reports
  back. OCP hands its results to it (`"legacy": true`, as OCP does without
  ovos-media), and the music is turned down while OVOS speaks or listens.
  An https page cannot play `http://` streams, so stations without an
  https address fail with a clear reason and OCP tries its next result.
  The "now playing" screen is OCP's own page (`ovos.common_play/OVOSSyncPlayer`,
  which the visage draws). In legacy mode nothing fills it on a device
  either (the classic OCP player did, and is deprecated), so
  [`now_playing.py`](py/emkay_mobile/now_playing.py) does, from OCP's
  results and AudioService's state, and turns its buttons into AudioService
  commands. It belongs in OCP itself, and goes there as a PR.
- **Speech to text** is OVOS' configured STT plugin, as on a device
  (Whisper on the device by default, defaults v13; the public OVOS servers
  are the fallback). One more plugin ships with the
  site: **ovos-stt-plugin-browser**, the browser's own speech recognition
  (Web Speech API – Google's in Chrome on Android, Apple's on an iPhone),
  picked in the control panel like any other STT
  ([ovos-stt-plugin-browser](https://github.com/emkay-voice/ovos-stt-plugin-browser), its own package). It handles languages
  the public servers do not (Danish, for one) and shows the words as you
  speak; the audio goes to Google or Apple. The browser listens itself, so
  Emkay lets the microphone go meanwhile; where the browser has no speech
  recognition (Firefox), `stt.fallback_module` transcribes the recording.
- **The wake word** is OVOS' own `listener.wake_word` ("hey_emkay" by
  default since defaults v13, "hey_mycroft" before), heard with the plugin OVOS' config names for it
  (`hotwords.<name>.module`), as ovos-dinkum-listener would load it, in a
  Web Worker of its own ([`wakeword.js`](web/wakeword.js), onnxruntime-web):
  - `ovos-ww-plugin-precise-onnx`, OVOS' default for "hey mycroft": the
    Mycroft Precise model from
    [precise-lite-models](https://github.com/OpenVoiceOS/precise-lite-models),
    run with [precise-onnx-js](https://github.com/TigreGotico/precise-onnx-js)
    (a port of that plugin's inference: the same features, calibration and
    trigger detector, so `sensitivity` and `trigger_level` work as on a
    device; Apache-2.0)
  - `ovos-ww-plugin-openwakeword`: [openWakeWord](https://github.com/dscripka/openWakeWord)'s
    own models and streaming pipeline ("hey_jarvis", "alexa", or
    "hey_mycroft" when configured; code Apache-2.0, pre-trained models
    CC BY-NC-SA 4.0, non-commercial), and Emkay's own **"hey M K"**
    (`hey_emkay`, trained with
    [hey-emkay-wakeword](https://github.com/emkay-voice/hey-emkay-wakeword),
    same licence). Its `hotwords` entry is in Emkay's defaults (step 11
    in `boot.py`), and since step 13 it is the wake word where it was
    still "hey_mycroft"; **Wake word** under Voice settings in the control
    panel changes it back. The setting is:

    ```json
    {"listener": {"wake_word": "hey_emkay"},
     "hotwords": {"hey_emkay": {"module": "ovos-ww-plugin-openwakeword",
                                "threshold": 0.8, "listen": true}}}
    ```

  The microphone stays open while Emkay is on screen – a phone or
  tablet used as an assistant is usually on its charger – and listening
  pauses while Emkay records, speaks or is muted. Hearing it does what
  ovos-dinkum-listener does (`recognizer_loop:wakeword`, then listen).
  Tapping the screen still works. The browser's noise suppression and
  automatic gain are off (they distort speech); echo cancellation is on.
- **The listener's microphone controls** (`mycroft.mic.get_status`, `mute`,
  `unmute`) are answered as ovos-dinkum-listener does; a muted mic does not
  listen.
- **The control panel has no port to listen on.** The stock FastAPI app is
  built with `create_app(bus=..., connect_bus=False)`, as its own tests do,
  and called as ASGI inside the worker ([`panel.py`](py/emkay_mobile/panel.py));
  a Service Worker ([`sw.js`](web/sw.js)) is its network. It prefixes the
  panel's absolute links when the site lives below a path, sets
  `Sec-Fetch-Site` honestly for the panel's cross-site check, lets this
  one site show it in a frame (it forbids all frames otherwise), and gives
  it Emkay's colours through its own CSS variables. A Service Worker's
  responses cannot set cookies, so the Emkay page keeps the panel's sign-in
  cookie for it ([`app.js`](web/app.js)). Pages for hardware a phone does
  not have (Wi-Fi, Mark 1 faceplate, sensors, desktop apps) are left out of
  its menu. The panel is only reachable on the phone itself: a browser tab
  cannot listen on the network.
- **Installing skills** goes through ovos-core's own installer
  (`ovos.pip.install`, also what the control panel's Plugins page uses);
  only the one place it starts pip is replaced
  ([`pip.py`](py/emkay_mobile/pip.py)), since a browser cannot run
  processes. It resolves against OVOS' alpha constraints, takes pure-Python
  wheels from PyPI and unpacks them into `~/.local/lib/python3.14/site-packages`
  (IndexedDB, so they survive a reload). SkillManager then loads the new
  skill at once, as on a device. Packages that ship with the site cannot be
  removed, and a skill whose service only answers on `http://` or without
  CORS will install but cannot reach it from the browser.
- **Speaking** is ovos-audio's speak handler without its playback queue
  ([`speech.py`](py/emkay_mobile/speech.py)): ovos-audio's own dialog
  transformer service, the configured TTS, ovos-audio's TTS transformer
  service on the WAV, then the page plays it. Transformers are set up in
  `mycroft.conf` (`dialog_transformers`, `tts_transformers`) or the control
  panel and, as on a device, load when the audio side starts.
- **Language:** the site ships the OVOS languages with 80 % or more of the
  skills translated (en-US, da-DK, de-DE, fr-FR, it-IT, es-ES, gl-ES, ca-ES,
  eu-ES, pt-PT, pt-BR, nl-NL). OVOS' default language is the phone's, when
  it is one of them, else OVOS' own en-US. It is written to the assistant
  layer, as ipgeo does with the location, so a language chosen in the
  control panel always wins. A phone downloads only the pre-trained intents
  and m2v model of the language OVOS boots in; a newly chosen language is
  fetched with a restart, which Emkay offers. Languages OpenVoiceOS has no
  m2v model for (fr, it) run without the m2v pipeline. Emkay's own few
  words (start screen, menu) follow OVOS' language, and the phone's until
  OVOS is up; they are in [`locale/`](locale), one `.dialog` file per text
  as in an OVOS skill.
- **First start** offers the control panel's own setup wizard next to
  starting on the defaults. Its recommendations are limited to plugins that
  run in a browser, and its wake word step is hidden for now.
- **Config changes are followed over the bus** (`configuration.updated`),
  as the services on a device do; the file watcher thread is left out.
- **The screen fills the window** on a phone, a tablet or a PC (an installed
  app or kiosk mode alike): ovos-gui-visage lays itself out for any size.
- **Left out:** `ovos-skill-boot-finished` (waits for an audio service and a
  listener that do not exist here).
- **Added to the "ovos" skill profile:** skills that answer without a server
  (calculator, geography, geometry, NATO alphabet, Morse code), and
  reading aloud: `ovos-common-reading-pipeline-plugin` with the providers
  whose sources a browser may read (the OpenVoiceOS blog, horoscopes). A
  browser can only fetch from sites that allow it (CORS), and public
  servers fail more often than a device notices. The pipeline plugin is put
  into OVOS' pipeline where its README says, once; the setup page can move it.
- **Waiting works as with threads** where the browser has JavaScript Promise
  Integration (JSPI: Chrome and Edge 137+, Firefox 153+, Safari 27+, and their
  Android/iOS versions): a `time.sleep`
  or `Event.wait` suspends Python where it is while the worker goes on with
  the page's messages, so a skill that asks back (`get_response`: "for
  when?", "is it that one?", yes/no, quizzes) gets the answer, and `stop`
  reaches a skill that is reading aloud. Without JSPI (older browsers)
  waits return at once, and a question back is asked but not waited
  for ([#20](https://github.com/emkay-voice/emkay/issues/20)). Emkay's own
  ears and voice on the device (Whisper, Piper) need JSPI too, so there
  Emkay says so at the first tap, downloads no model it can't use, and
  offers OpenVoiceOS' servers for that browser – saying first that what you
  say is then sent to them (`tools/probes/nojspi_browser.mjs` checks it).
- **Speech can be made on the phone** with Piper: choose
  [`ovos-tts-plugin-piper-browser`](https://github.com/emkay-voice/ovos-tts-plugin-piper-browser) as the TTS (the control panel's voice
  settings). It is Emkay's stand-in for ovos-tts-plugin-piper, which needs
  onnxruntime and espeak-ng: here piper-phonemize (espeak-ng) and the voice
  run as WebAssembly in the worker (`web/piper.js`, onnxruntime-web; the plugin is its own package). The
  voice for OVOS' language (or `voice` in the plugin's config, a
  [piper-voices](https://huggingface.co/rhasspy/piper-voices) name) is
  downloaded the first time, about 63 MB plus 18 MB of espeak-ng data, and
  kept; until then `tts.fallback_module` speaks. After that nothing leaves the
  phone to speak, and a sentence takes well under a second on a laptop
  ([#3](https://github.com/emkay-voice/emkay/issues/3)). It is not the default yet.

## The skill store

[store.emkay.ai](https://store.emkay.ai) ([emkay-voice/store](https://github.com/emkay-voice/store))
lists the OVOS skills Emkay can use, by category and in the visitor's language.
Its "Get" opens `app.emkay.ai/?install=<package>`: Emkay opens the control
panel's Plugins page searched for that package, and the panel's own Install
button installs it (Emkay installs nothing on a link's say-so).

## Versions and releases

app.emkay.ai is always the newest build of `main`. The boot screen and
*About Emkay* show which one: `Emkay 0.1.0 · build 123 · abc1234` (the
[VERSION](VERSION) file, the CI run, the commit), so a report can name it.
A release names a tested point: set VERSION, tag `vX.Y.Z` and push; the
release workflow makes the GitHub release with the commits since the last
tag as notes.

Every deploy also publishes the site as one download, the release
[`site`](https://github.com/emkay-voice/emkay/releases/tag/site):
`emkay-site.tar.gz` (with its `.sha256`) and `emkay-site.json` (its
`build.json`). It is a static site – any https server can serve it, at any
path. [Emkay Home](https://github.com/emkay-voice/emkay-home) uses it to
serve Emkay from the house.

## Developing

```bash
npm install --include=dev            # Pyodide, for Node runs
# the wheelhouse and plan.json, built fresh from requirements/ with Python
# 3.14 exactly as CI does; run it again whenever requirements/ change
tools/sync_wheelhouse.sh

# pre-train padatious (normal CPython venv with requirements/browser*.txt,
# minus ovos-m2v-pipeline), fetch the m2v and wake word models
python tools/build_intent_cache.py build/intent_cache en-US da-DK
python tools/fetch_m2v_models.py build/m2v en-US da-DK
python tools/fetch_wakeword_models.py build/oww

# build and serve the site on http://127.0.0.1:8080/
EMKAY_M2V=build/m2v EMKAY_OWW=build/oww python3 tools/build_site.py wheelhouse plan.json build/intent_cache
python3 tools/serve.py

# or run OVOS in Pyodide under Node
node tools/node_smoke.mjs wheelhouse plan.json "what time is it"
```

`tools/probes/` holds measurement scripts for `tools/node_run.mjs` and the
headless-browser tests (`*_browser.mjs`). `tools/probes/ci.py` serves the built
site and runs the browser tests, as CI does before every deploy:

```bash
CHROME=/path/to/chrome python3 tools/probes/ci.py
```

### Adding a language

1. Add it to `matrix.lang` in [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
   CI pre-trains padatious for it and fetches its m2v model, if OpenVoiceOS
   publishes one (`tools/fetch_m2v_models.py`).
2. Translate Emkay's own texts: copy [`locale/en-us/`](locale/en-us) to
   `locale/<lang>/` (lower case, e.g. `pt-br`) and translate each `.dialog`
   file, keeping the `{placeholders}`. The build gathers them into
   `texts.json` for [`i18n.js`](web/i18n.js); a language without its own
   folder falls back to one with the same base language, then English.

The texts are laid out like a skill's dialogs so that OVOS' translation
tooling (ovos-localize) can take them over once Emkay lives under
OpenVoiceOS.

## License

Apache-2.0. Parts that come with their own licence: ovos-gui-visage
(Apache-2.0), precise-onnx-js (Apache-2.0), onnxruntime-web
(MIT), piper-wasm (MIT; it contains espeak-ng and its data, GPL-3.0, in
`piper/`), and the Piper voices, each with the licence in its model card.
