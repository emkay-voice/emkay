# Emkay as a HiveMind satellite

Emkay can use an OpenVoiceOS in your house instead of the one in the
browser ([#11](https://github.com/emkay-voice/emkay/issues/11), part of
[#27](https://github.com/emkay-voice/emkay/issues/27)). The phone keeps the
body – the face, the wake word, the microphone and the speaker – and the
questions go to the house over [HiveMind](https://github.com/JarbasHiveMind/HiveMind-core).
Nothing heavy loads on the phone: no Pyodide, no OVOS. Emkay starts in a
second or two.

The wake word is Emkay's own "hey M K" where the site has it, as on the
device (`hey mycroft` otherwise; `wakeWord` in the settings picks another of
the site's wake words). The face moves its mouth to the answer the same way
the local OVOS does it (visemes from the text, spread over the audio).

It works like `hivemind-voice-sat`: the wake word and the speech
recognition run on the phone (Whisper in the browser, or the browser's own
recognition), only the text goes to the house; the answer (`speak`) comes
back and the phone makes the voice (Piper in the browser).

## In the house

The easy way: [Emkay Home](https://github.com/emkay-voice/emkay-home) – OVOS,
hivemind-core and a page that pairs an Emkay with a QR code, behind one https
address with the house's own certificate, and Emkay served from the house.
No keys or passwords to type.

By hand: a hivemind-core next to your OVOS, and a client for Emkay:

```sh
hivemind-core add-client --name kitchen-tablet
```

It prints an access key and a password; Emkay needs both.

**The browser needs `wss://`.** A page on https (app.emkay.ai) may only open
a secure WebSocket to your LAN, so hivemind-core must have TLS: its own
certificate (`ssl: true` and `cert_dir` in its config), or a reverse proxy
in front of it (Caddy, Nginx Proxy Manager, …) with a certificate the phone
trusts. Emkay served from the house over plain http could use `ws://`, but
the browser then gives it no microphone – https it is. Behind a reverse proxy
at a path, put it in the pairing link: `"path": "/hivemind"`.

## On the phone

Emkay always starts on its own first, with nothing to choose: OpenVoiceOS
here on the device. To use the house instead:

- the first start's **"Already have an assistant in the house?"**, or
- **⚙ → "Where should Emkay think?"** any time later,

then **"The OpenVoiceOS in your house"**: host, port, the access key and the
password. Emkay remembers the choice and starts as a satellite from then on.
If the house can't be reached, the form says why and offers **"Use Emkay on
this device instead"**, so a house that is down never locks Emkay out.

`?brain=hivemind` (or `?brain=local`) in the address picks a brain for that
one start, without changing the saved choice.

The connection can also be handed over in the address – a **pairing link** –
after `#hivemind=` as base64 JSON – the part after `#` never leaves the browser,
and Emkay removes it from the address once saved. Opening such a link (or
scanning it as a QR code) makes Emkay a satellite of that house straight
away, no questions asked:

```sh
echo -n '{"host":"ovos.local","port":5678,"ssl":true,"key":"…","password":"…"}' | base64 -w0
# → https://app.emkay.ai/#hivemind=<that>
```

Optional fields: `lang` (default: the browser's language), `stt`
(`"whisper"`, the default, or `"browser"`), `wakeWord` (e.g. `"hey_mycroft"`),
`path` (hivemind-core behind a reverse proxy, e.g. `"/hivemind"`), `siteId`.

## Speech in the house

An [Emkay Home](https://github.com/emkay-voice/emkay-home) on a strong
machine can hear and speak for its Emkays (emkay-voice/emkay-home#13): the
stock `ovos-stt-server` with Whisper and `ovos-tts-server` with Piper. Then
the recording goes to the house's STT and the answer comes back as the
house's voice; the wake word stays on the phone. Emkay learns where from the
pairing link (`speech: {"stt": "https://…/speech/stt/stt", "tts":
"https://…/speech/tts"}`) and asks again at every start
(`/api/house-info`), so a phone paired earlier finds out too. The HiveMind
key is the Bearer token. If the house doesn't answer within 20 s, the phone
does it itself, as before.

"Use the house for speech" under the house in "Where should Emkay think?"
turns it off for this phone (`houseSpeech: false`). With speech in the house
the phone's own Whisper and Piper are not downloaded until they are needed.

In this mode the ⚙ menu has no skill store or network log: those belong to
the OVOS in the browser. Skills are installed on the OVOS in the house. With
an Emkay Home, ⚙ → Control panel opens the house's own control panel (`panel` in
the pairing link and at `/api/house-info`), behind the house's password.

## Testing

- `tools/probes/hivemind_node.mjs` – the client (`web/brains/hivemind.js`)
  against a real hivemind-core: handshake, an answer, wrong password and
  wrong key refused.
- `tools/probes/hivemind_browser.mjs` – Emkay with `?brain=hivemind` in
  headless Chromium: boot, start, a typed question answered and spoken.
- `tools/probes/hivemind_responder.py` – a stand-in skill on the bus that
  answers every utterance, for when there is no full OVOS at hand.

A throw-away hivemind-core for the probes (in a venv; note
`bitstring<4.3` and `setuptools<81`, which hivemind-bus-client 0.4.4 and
hivemind-plugin-manager 0.5 still need):

```sh
python3 -m venv /tmp/hm && /tmp/hm/bin/pip install hivemind-core ovos-messagebus "bitstring<4.3" "setuptools<81"
export XDG_DATA_HOME=/tmp/hm-home/data XDG_CONFIG_HOME=/tmp/hm-home/config
/tmp/hm/bin/hivemind-core add-client --name emkay-test --access-key K --password P
/tmp/hm/bin/ovos-messagebus &  /tmp/hm/bin/hivemind-core listen &
/tmp/hm/bin/python tools/probes/hivemind_responder.py &
HM_KEY=K HM_PASSWORD=P node tools/probes/hivemind_node.mjs
```

## Not yet

- Skill pages (ovos-gui) from the house on the phone's screen – the face
  and its clock work; GUI pages need HiveMind to carry the GUI stream.
- The texts are in all of Emkay's languages, but only English and Danish
  were written by someone who speaks them; the rest need a native speaker's
  look (#10).
