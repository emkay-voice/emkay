"""Run the headless-browser tests against a built site and check their output.

Each probe (tools/probes/*_browser.mjs) boots Emkay in a real headless
Chromium, does one thing a user does and logs what happened; this runner
serves build/site, runs the probes one after another and checks the lines
each must log. It exits non-zero when one is missing, so CI does not
deploy a site that fails them.

  CHROME=/path/to/chrome python3 tools/probes/ci.py [LOG_DIR]

The logs go to LOG_DIR (default build/probe-logs).
"""
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
URL = "http://127.0.0.1:8080/"

#: probe, extra env, arguments, the lines its log must hold (regex)
PROBES = [
    # Emkay Dev (?dev, #43): a skill sent as files from another window,
    # tested, changed and loaded again; a broken one says why
    ("dev_browser.mjs", {}, [], [
        r"hello: ready=true",
        r'load: ok=true .*"trained":\d',
        r'test "[^"]+": pass – ovos-skill-hello\.emkay-voice:hello\.intent',
        r"other language: skipped",
        r'after reload: pass said \["Reloaded and ready\."\]',
        r'broken: ok=false problems=\["Failed to load skill',
    ]),
    ("setup_browser.mjs", {}, [], [
        r"\| Start ",                            # the first start offers setup
        r"wake step shown: false",              # browser-honest wizard
        r"setup url: .*/panel/setup",
        # Emkay as a distribution of the panel (boot.py DISTRIBUTION): its
        # own recommendations (Whisper and Piper in the browser) and store
        r"setup text:[\s\S]*ovos-stt-plugin-whisper-browser[\s\S]*ovos-tts-plugin-piper-browser",
        r'/api/stores: \{"stores":\[\{"name":"Emkay","url":"https://store\.emkay\.ai/data/skills\.json"',
    ]),
    ("lang_browser.mjs", {"PHONE_LANG": "da-DK"}, [], [
        r"OVOS lang: da-DK",                    # the phone's language
        r"downloaded: \['intents-da-DK', 'm2v-da'\]",   # and only that one
        # texts follow the panel: an entry of the menu reads "Control panel"
        # now (any entries before it, e.g. "Where should Emkay think?")
        r"menu:(?:(?!html lang)[\s\S])*?Control panel",
        r"restart button: Restart to use en-US",
        r"after restart: .*intents-en-US",
    ]),
    ("install_browser.mjs", {}, [URL, "ovos-skill-number-facts", "tell me a fact about the number 7"], [
        r"install finished: state=done returncode=0",
        r"new: ovos-skill-number-facts\.openvoiceos",
        r"Successfully uninstalled ovos-skill-number-facts",
    ]),
    # a skill straight from GitHub (#49): ?install=github:..., Install, it
    # answers, it is there after a reload, Update, Remove
    ("github_browser.mjs", {}, [], [
        r'install: gh-status ok',
        r"new skills: ovos-skill-hello-example\.emkay-voice",
        r"asked \"hello from my skill\": answered by the skill",
        r"after reload: still loaded=true",
        r'update: gh-status ok',
        r"after remove: skill gone=true listed=0",
    ]),
    # What's happening? (#50): heard, understood with skill and pipeline,
    # answered, from the bus as it happens
    ("activity_browser.mjs", {}, [], [
        r"setup: Hears with: \S+ – ",
        r"understood: date-time: what_time_is_it \[via ovos-",
        r"understood: geography: capital_of",
        r"answered: “[^”]+” \[",
    ]),
    ("tx_browser.mjs", {}, [], [
        r"enable: \['ovos-dialog-normalizer-plugin'\]",
        r"spoken: I('ve| have) got (three|tre) apples",   # rewritten before TTS
    ]),
    ("backup_browser.mjs", {}, [], [
        r"backup: 200 application/gzip attachment",   # the panel's Backup page
        r"after restore: unit imperial",
    ]),
    ("mic_browser.mjs", {"SPEECH_WAV": str(REPO / "tools/probes/audio/what_time.wav")}, [], [
        r'captions: \["Listening…","One moment…","“What time is it\?”"',   # tap, STT
        r'second said: \["(It|Currently)',                 # and an answer
    ]),
    # a browser without JSPI (Safari before 27): the page's commands work,
    # the note says so at once, no model is fetched, servers only when chosen
    ("nojspi_browser.mjs", {}, [], [
        r"ok   the note at the first tap: “This browser can't run",
        r"ok   no speech model downloaded",
        r"ok   nothing sent to a speech server before the tap",
        r"ok   the servers are kept for both ears and voice",
        r"PASSED",
    ]),
    # the recordings say "hey mycroft"; Emkay's default is "hey_emkay"
    # (openWakeWord), so the probe switches as the control panel would
    ("wakeword_browser.mjs", {"SPEECH_WAV": str(REPO / "tools/probes/audio/hey_mycroft_what_time.wav"), "ANSWERS": "2", "WAKE_WORD": "hey_mycroft"}, [], [
        r"default wake word engine ready in [0-9.]+s: oww",   # Emkay's own: hey_emkay
        r"wake word engine ready in [0-9.]+s: precise",       # OVOS' hey_mycroft: ovos-ww-plugin-precise-onnx
        r'said: \["(It|Currently)',                        # no tap: the wake word
        r"answer 2; mic: mic[^,]*, wake listening",                # and back waiting for the next one
    ]),
    # a skill asking back (get_response) gets the answer: Python really waits (JSPI, #20)
    ("noanswer_browser.mjs", {"QUESTIONS": "set an alarm|in five minutes|read the latest post from ovosblog|yes|stop"}, [], [
        r'"in five minutes": said \["Your alarm is set',
        r'"yes": said \["[^"]*from the OpenVoiceOS Blog',     # the skill's dialogs vary
        # a stop line, not "couldn't help"; the line being read when "stop"
        # came may still be in the list before it
        r'"stop": said \["(?![^|]*(couldn.t|can.t) help)[^|]*\] \| captions \[\]',
    ]),
    # speech without the wake word, for a minute: Precise must stay quiet
    ("wakeword_browser.mjs", {"SPEECH_WAV": str(REPO / "tools/probes/audio/what_time.wav"), "WAIT_S": "60", "WAKE_WORD": "hey_mycroft"}, [], [
        r"wake word engine ready in [0-9.]+s: precise",
        r"FAILED: timed out waiting for answer 1",
        # and meanwhile the room audio went to the audio transformers (#105):
        # auto volume measured it, without threads of its own (Pyodide)
        r'room: \{"sent":[1-9]',
        r'"ovos-audio-transformer-plugin-autovolume": [1-9][0-9.]*',
        # and overheard manners listened, with its model in onnxruntime-web
        # (shims/onnxruntime) and Emkay's own Whisper as its STT
        r'"ovos-audio-transformer-plugin-overheard-manners": \{"ready": true',
        r'"window_ms": [0-9]+, "pronunciations": [1-9]',     # its model really runs (one 1.5 s window, ms)
    ]),
    ("panel_mobile.mjs", {}, [], [
        r"after tapping Settings: /panel/config",       # the panel's menu by touch
    ]),
    ("noanswer_browser.mjs", {}, [], [
        r'"what time is it": said \["(It|Currently)[^|]*\|[^|]*\| sounds 0',   # answered: no error sound, no "couldn't help"
    ]),
    ("noanswer_browser.mjs", {"QUESTIONS": "what is 17 times 23|what is the capital of australia"}, [], [
        r'"what is 17 times 23": said \[[^\]]*391',            # the skills Emkay adds
        r'"what is the capital of australia": said \[[^\]]*Canberra',
    ]),
    # the screen: ovos-gui-visage connects to the bus and to ovos-gui's GUI
    # socket through web/visage2-shim.js (issue #22)
    ("visage2_browser.mjs", {"SETTLE_MS": "20000", "QUESTIONS": "what time is it"}, [], [
        r"connected to messagebus at wss?://[^ ]*/visage2/core",
        r"connected to wss?://[^ ]*/visage2/gui and re-announced framework=html",
    ]),
    # music (#16): ovos-audio's AudioService plays a short tone through
    # ovos-audio-plugin-browser in the page's <audio>, ducks it while OVOS
    # speaks, and hears the end of the track (no radio station needed)
    ("media_browser.mjs", {}, [], [
        r"ducked and restored",
        r"now playing page shown",
        r"pause and resume buttons work",
        r"bus: .*ovos\.audio\.browser\.play.*mycroft\.audio\.playing_track",
        r"queue end reached",
        r"media ok",
    ]),
    # your own music (#108): a song chosen for this session, found by OCP
    # through Emkay's local media provider and played from the page's file
    ("media_browser.mjs", {"LOCAL_SONG": "Kaffesangen.wav", "SAY": "play kaffesangen"}, [], [
        r"local songs: 1",
        r'local media: \{"folder": "songs", "songs": 1, "state": "ready"',
        r'playing: \{"uri":"file:///emkay-local/songs/Kaffesangen\.wav"',
        r"media ok",
    ]),
    ("installable_browser.mjs", {}, [], [
        r"manifest errors: none",
        r"installability errors: none",                     # "Install as app" can be offered
        r"panel menu: [1-9]\d* of \d+ pages shown",            # the panel opens with its advanced groups folded
    ]),
    ("phal_browser.mjs", {}, [], [
        r'internet_check: \[\{"internet_connected": true',
        r'camera\.get: .*"b64_frame"',
        r'sensors before: \{"position": "off", "presence": "off", "mic_level": "off", "motion": "off"\}',
        r'sensors after: \{"states": \{"position": "on".*"position": "55\.9731,12\.4961"',
        r"capabilities: .*power=ovos-phal-plugin-browser",
        r"page reloaded: true",
    ]),
]


def serve():
    proc = subprocess.Popen([sys.executable, str(REPO / "tools/serve.py")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(URL, timeout=1)
            return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    sys.exit("the site server did not start")


def main():
    logs = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "build/probe-logs")
    logs.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("CHROME"):
        sys.exit("set CHROME to a Chromium or Chrome binary")
    # every probe starts from an empty browser profile, as on CI (a profile
    # left by an earlier local run keeps its OVOS config and changes results)
    import glob, shutil
    for d in glob.glob("/tmp/emkay-chrome*"):
        shutil.rmtree(d, ignore_errors=True)
    server = serve()
    failed = []
    try:
        for n, (probe, env, args, expect) in enumerate(PROBES, 1):
            # a probe that fails gets one more try from a clean profile: these
            # are real browsers on a shared runner, and a slow moment (a
            # timeout, a reading that runs on) must not hold every deploy
            # back; a real fault fails twice
            for attempt in (1, 2):
                t = time.time()
                # numbered: a probe that runs twice (other questions) keeps both logs
                suffix = "" if attempt == 1 else "-retry"
                log = logs / f"{n:02d}-{probe.replace('.mjs', '')}{suffix}.log"
                for d in glob.glob("/tmp/emkay-chrome*"):
                    shutil.rmtree(d, ignore_errors=True)
                with open(log, "w") as out:
                    try:
                        subprocess.run(["node", str(REPO / "tools/probes" / probe), *(args or [URL])],
                                       env={**os.environ, **env}, stdout=out, stderr=subprocess.STDOUT,
                                       cwd=REPO, timeout=900)
                    except subprocess.TimeoutExpired:
                        out.write("\nTIMED OUT (900 s)\n")
                text = log.read_text(errors="replace")
                missing = [e for e in expect if not re.search(e, text)]
                label = "ok  " if not missing else ("FAIL" if attempt == 2 else "flaky?")
                print(f"{label} {probe}{' (retry)' if attempt == 2 else ''} ({time.time() - t:.0f} s)")
                for e in missing:
                    print(f"     missing: {e}")
                if not missing:
                    break
            if missing:
                failed.append(probe)
    finally:
        server.kill()
    if failed:
        sys.exit(f"{len(failed)} of {len(PROBES)} browser tests failed; logs in {logs}")


if __name__ == "__main__":
    main()
