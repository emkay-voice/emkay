// Emkay – a HiveMind client in plain JavaScript (issue #11).
//
// Speaks the HiveMind protocol to a hivemind-core over a WebSocket, the way
// hivemind-bus-client does in Python, with the browser's own WebCrypto, so
// a satellite needs no Pyodide. Runs in a browser and in Node 22+ (global
// WebSocket and crypto.subtle) – tools/probes/hivemind_node.mjs tests it
// against a real hivemind-core.
//
// Two handshakes, picked by what the hub offers (#120):
//
// hivemind-core 5 – protocol v3, Noise (HIVEMIND-CRYPTO-1 §3.4):
//   1. connect to ws(s)://host:port[/path]?authorization=base64("useragent:accessKey")
//   2. server → HELLO {pubkey, peer, node_id}
//   3. server → HANDSHAKE {max_protocol_version: 3, noise: {patterns, suites}, ...}
//   4. client → HANDSHAKE {noise: {pattern, suite, msg}}   Noise_XXpsk2 message 1
//   5. server → HANDSHAKE {noise: {msg}}                   message 2
//   6. client → HANDSHAKE {noise: {msg}}                   message 3, then Split()
//   7. from here on every frame is a binary Noise transport message
//   8. client → HELLO {session, site_id}, then {msg_type: "bus", ...} both ways
//   The prologue binds the cleartext HELLO and HANDSHAKE, so a downgrade or a
//   tampered offer fails. The PSK is argon2id(password, SHA-256(node_id))
//   (t=3, 64 MiB): seconds on an old phone, so it is saved per house (the
//   "keys" event), or comes ready-made in Emkay Home's pairing link (`psk`).
//   The hub pins this client's static X25519 key on first use, so it is saved
//   per house too (`noiseKey`), and the hub's key is pinned here (`serverKey`).
//   The Noise state machine and its crypto are Jarbas' HiveMind-js
//   (byte-verified against Python's poorman_handshake), loaded only here,
//   only when a hub asks for Noise; Emkay keeps the socket, the path behind a
//   proxy, its session and site in HELLO, and its own errors.
//
// hivemind-core 4 – the password handshake (protocol V1):
//   3. server → HANDSHAKE {password: true, encodings, ciphers, ...}
//   4. client → HANDSHAKE {envelope, encodings, ciphers, binarize}
//        envelope = hex(iv8 + sha256(iv8 + password))[:48]   (poorman_handshake)
//   5. server → HANDSHAKE {envelope, encoding, cipher}
//        salt = our iv XOR their iv; key = PBKDF2-SHA256(password, salt, 100000) → 32 bytes
//   6. from here on every frame is {"ciphertext","tag","nonce"} (AES-GCM,
//      16-byte nonce, 16-byte tag), each field in the agreed encoding
//   A house that once did Noise is never accepted with this one again
//   (`noise: true` in the saved settings).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------- encodings
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
function toB64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const CODECS = {
  "JSON-B64": [toB64, fromB64],
  "JSON-HEX": [toHex, fromHex],
};
/** Encodings and ciphers we offer, in the order we prefer them. */
export const ENCODINGS = Object.keys(CODECS);
export const CIPHERS = ["AES-GCM"];

/** An Error with a code the page can turn into its own words (hivemind.err.<code>). */
const fail_ = (code, message) => Object.assign(new Error(message), { code });

const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// ------------------------------------------------- password handshake
/** poorman_handshake's hSub: hex(iv + sha256(iv + text)), cut to `len` digits. */
async function hsub(text, iv, len = 48) {
  const hash = new Uint8Array(await subtle.digest("SHA-256", concat(iv, enc.encode(text))));
  return toHex(concat(iv, hash)).slice(0, len);
}

/** Does the server's envelope prove it knows the password too? */
async function matches(envelope, password) {
  if (envelope.length < 48 || envelope.length > 80) return false;
  return (await hsub(password, fromHex(envelope.slice(0, 16)), envelope.length)) === envelope;
}

async function deriveKey(password, salt) {
  const base = await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ------------------------------------------------------- Noise (protocol v3)
// Where the site keeps HiveMind-js and the two @noble primitives it needs
// (tools/build_site.py add_hivemind); Node takes them from node_modules.
const VENDOR = "../hivemind-js/";
const inNode = !!globalThis.process?.versions?.node;
let noiseLib = null;

/** HiveMind-js and argon2idAsync, loaded the first time a hub asks for Noise. */
function loadNoise() {
  noiseLib ||= (async () => {
    const at = (p) => new URL(VENDOR + p, import.meta.url).href;
    const [{ chacha20poly1305 }, { argon2idAsync }] = await Promise.all(inNode
      ? [import("@noble/ciphers/chacha.js"), import("@noble/hashes/argon2.js")]
      : [import(at("noble/ciphers/chacha.js")), import(at("noble/hashes/argon2.js"))]);
    // HiveMind-js reads its ChaCha20-Poly1305 from here when it encrypts
    globalThis.HiveMindNoble ||= { chacha20poly1305 };
    const lib = inNode ? await import("hivemind-js") : await import(at("hivemind.mjs"));
    return { lib: lib.default || lib, argon2idAsync };
  })().catch((e) => { noiseLib = null; throw e; });
  return noiseLib;
}

/** Can this browser do X25519 at all (Chrome 133+, Firefox 130+, Safari 17+)? */
async function hasX25519() {
  try {
    await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch { return false; }
}

/**
 * The Noise PSK from the password, as hivemind-core derives it
 * (poorman_handshake.noise.derive_psk): argon2id(password, SHA-256(node_id),
 * t=3, m=64 MiB, p=1, 32 bytes). The async variant lets the page breathe –
 * the face keeps moving – while it works.
 */
async function derivePsk(argon2idAsync, password, nodeId) {
  const salt = new Uint8Array(await subtle.digest("SHA-256", enc.encode(nodeId || "")));
  return argon2idAsync(enc.encode(password), salt, { t: 3, m: 64 * 1024, p: 1, dkLen: 32, asyncTick: 25 });
}

// ------------------------------------------------------------ the client
/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=5678]
 * @param {string} [opts.path=""]  behind a reverse proxy, e.g. "/hivemind" (Emkay Home, #33)
 * @param {boolean} [opts.ssl=true]  wss:// – an https page can't open ws:// on the LAN
 * @param {string} opts.key          access key from `hivemind-core add-client`
 * @param {string} opts.password     its password
 * @param {string} [opts.psk]        Noise PSK (hex), from the pairing link or saved
 * @param {string} [opts.pskNode]    the hub's node_id that `psk` was derived for
 * @param {string} [opts.noiseKey]   this Emkay's static X25519 private key (hex)
 * @param {string} [opts.serverKey]  the hub's static Noise key (hex), pinned
 * @param {boolean} [opts.noise]     this hub did Noise before: refuse the old handshake
 * @param {string} [opts.siteId]
 * @param {string} [opts.sessionId]  must not be "default"
 * @param {string} [opts.lang]
 * @param {string} [opts.useragent="Emkay"]
 *
 * Events: "message" (an OVOS bus message), "hive" (other HiveMind messages),
 * "close", and "keys" after a Noise handshake: {psk, pskNode, noiseKey,
 * serverKey, noise: true} – what to save with the house, so the next
 * connect is quick and the hub knows this Emkay again.
 */
export class HiveMindClient extends EventTarget {
  constructor(opts) {
    super();
    this.opts = { port: 5678, path: "", ssl: true, useragent: "Emkay", siteId: "emkay", lang: "en-US", ...opts };
    this.opts.sessionId ||= globalThis.crypto.randomUUID();
    if (this.opts.sessionId === "default") throw new Error('session "default" is for admins');
    this.key = null;        // CryptoKey once the old handshake is done
    this.noise = null;      // NoiseTransport once the Noise handshake is done
    this.protocol = null;   // 1 or 3, once connected
    this.encoding = "JSON-HEX";
    this.peer = null;       // how the server knows us
    this.nodeId = null;     // the server's name
    this.ws = null;
    this._iv = null;
    this._serverHello = null;   // the server's HELLO payload, for the Noise prologue
    this._shaking = null;   // the Noise handshake in flight
    this._queue = Promise.resolve();   // frames handled one at a time, in order
  }

  get url() {
    const { host, port, path, ssl, useragent, key } = this.opts;
    const auth = btoa(`${useragent}:${key}`);
    const p = path ? "/" + String(path).replace(/^\/+/, "") : "";
    return `${ssl ? "wss" : "ws"}://${host}:${port}${p}?authorization=${encodeURIComponent(auth)}`;
  }

  get ready() { return !!(this.key || this.noise); }

  /** What to call the hub on screen: its node_id where that is a name
   * (hivemind-core 4: "master:0.0.0.0"), else the host (hivemind-core 5's
   * node_id is its whole public key, PEM). */
  get nodeName() {
    const id = String(this.nodeId || "");
    return id && id.length <= 64 && !/\s|BEGIN/.test(id) ? id : this.opts.host;
  }

  /** How long a Noise connection waits for the hub to object before it
   * counts as connected: in XX the hub checks this Emkay's static key only
   * after our last handshake message, and says no by closing (1008). */
  static SETTLE_MS = 1000;

  /** Connect and finish the handshake; resolves when bus messages can flow. */
  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      // argon2id on a slow device may take a while: the timer waits for it
      let timer = setTimeout(() => fail(fail_("timeout", "HiveMind handshake timed out")), timeoutMs);
      const fail = (e) => { clearTimeout(timer); this.close(); reject(e); };
      this._pause = (ms) => { clearTimeout(timer); timer = setTimeout(() => fail(fail_("timeout", "HiveMind handshake timed out")), ms); };
      this._ready = () => { clearTimeout(timer); resolve(this); };
      this._fail = fail;
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onmessage = (ev) => {
        if (this._settling) this._settled?.();   // the hub talks to us: it took our key
        this._queue = this._queue.then(() => this._receive(ev.data)).catch((e) => this._fail?.(e));
      };
      this.ws.onerror = () => this._fail?.(fail_("unreachable", `can't reach ${this.opts.host}:${this.opts.port}`));
      this.ws.onclose = (ev) => {
        const wasReady = this.ready;
        this.key = null;
        this.noise = null;
        if (!wasReady || this._settling) {
          // 1008 during Noise: the hub refused the PSK – the password; right
          // after it: the hub knows this Emkay by another static key
          const code = this._settling && ev.code === 1008 ? "pinned"
            : this._shaking && ev.code === 1008 ? "password" : "closed";
          this._fail?.(fail_(code, `HiveMind closed the connection (${ev.code}) – wrong key or password?`));
        }
        this.dispatchEvent(Object.assign(new Event("close"), { code: ev.code }));
      };
    });
  }

  close() {
    this._fail = null;
    try { this.ws?.close(); } catch {}
  }

  /** Send an OVOS bus message to the hive. */
  async emit(type, data = {}, context = {}) {
    const ctx = {
      source: this.peer || "emkay", destination: "HiveMind",
      session: { session_id: this.opts.sessionId, lang: this.opts.lang, site_id: this.opts.siteId },
      ...context,
    };
    await this._send({ msg_type: "bus", payload: { type, data, context: ctx } });
  }

  async _send(hive) {
    const msg = { metadata: {}, route: [], node: null, target_site_id: null, target_pubkey: null,
                  source_peer: null, ...hive };
    const text = JSON.stringify(msg);
    if (this.noise) {
      // HiveMind-js keeps the nonces in order; the frames leave in that order
      return this.ws.send(await this.noise.encryptFrame(text));
    }
    if (!this.key) return this.ws.send(text);   // only the handshake goes in the clear
    const nonce = random(16);
    const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 },
      this.key, enc.encode(text)));
    const [encode] = CODECS[this.encoding];
    this.ws.send(JSON.stringify({
      ciphertext: encode(sealed.subarray(0, sealed.length - 16)),
      tag: encode(sealed.subarray(sealed.length - 16)),
      nonce: encode(nonce),
    }));
  }

  async _open(frame) {
    const [, decode] = CODECS[this.encoding];
    const sealed = concat(decode(frame.ciphertext), frame.tag ? decode(frame.tag) : new Uint8Array());
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: decode(frame.nonce), tagLength: 128 },
      this.key, sealed);
    return JSON.parse(dec.decode(plain));
  }

  async _receive(raw) {
    let msg;
    if (typeof raw !== "string") {
      const bytes = new Uint8Array(raw instanceof Blob ? await raw.arrayBuffer() : raw);
      if (!this.noise) throw new Error("a binary frame outside a Noise session");
      const plain = await this.noise.decryptFrame(bytes);
      if (typeof plain !== "string") return;   // binary payloads: not used by Emkay
      msg = JSON.parse(plain);
    } else {
      msg = JSON.parse(raw);
      if (msg.ciphertext) {
        if (!this.key) throw new Error("encrypted message before the handshake");
        msg = await this._open(msg);
      } else if (this.noise && msg.msg_type !== "shake") {
        throw new Error("a cleartext message inside a Noise session");
      }
    }
    switch (msg.msg_type) {
      case "hello": return this._hello(msg.payload);
      case "shake": return this._shake(msg.payload || {});
      case "bus": return this._bus(msg.payload);
      default:
        this.dispatchEvent(Object.assign(new Event("hive"), { message: msg }));
    }
  }

  _hello(p) {
    if (this.nodeId) return;   // other nodes may say HELLO later; the first one is the server
    this._serverHello = p;
    this.nodeId = p.node_id || "";
    this.peer = p.peer || null;
  }

  async _shake(p) {
    if (this.ready) return;
    if (p.noise?.msg) return this._noiseReply(p.noise.msg);
    if ("envelope" in p) return this._passwordReply(p);
    // the server asks us to start: Noise where it offers it
    if ((p.max_protocol_version || 1) >= 3 && p.noise) return this._noiseStart(p);
    if (this.opts.noise) throw fail_("downgrade", "this house did Noise before and now offers only the old handshake");
    if (!p.password) throw fail_("no_password", "this hivemind-core offers no password handshake");
    this._iv = random(8);
    await this._send({ msg_type: "shake", payload: {
      binarize: false, encodings: ENCODINGS, ciphers: CIPHERS,
      envelope: await hsub(this.opts.password, this._iv),
    } });
  }

  // ---------------------------------------------------------- Noise
  async _noiseStart(p) {
    if (!(await hasX25519())) throw fail_("noise_unsupported", "this browser has no X25519 (Web Crypto)");
    const { lib, argon2idAsync } = await loadNoise();
    // XXpsk2 always (the hub's key is checked below, after the handshake)
    const sel = lib.selectNoiseOptions(p.noise.patterns, p.noise.suites, null);
    if (!sel) throw fail_("noise_unsupported", `no Noise pattern/suite in common (${JSON.stringify(p.noise)})`);
    const o = this.opts;
    let psk = o.psk && (!o.pskNode || o.pskNode === this.nodeId) ? fromHex(o.psk) : null;
    if (!psk) {
      if (!o.password) throw fail_("password", "no password to derive the Noise PSK from");
      const kdf = p.noise.kdf || {};
      this._pause(120000);   // a slow device: give argon2id its time
      psk = /^PBKDF2/.test(kdf.name || "")
        ? await lib.derivePskPBKDF2(o.password, this.nodeId || "", kdf.iterations)
        : await derivePsk(argon2idAsync, o.password, this.nodeId);
      this._pause(15000);
    }
    this._psk = psk;
    this._noiseKey = o.noiseKey ? fromHex(o.noiseKey) : random(32);
    const name = `Noise_${sel.pattern}_${sel.suite}`;
    const hs = await lib.NoiseHandshake.create({
      pattern: sel.pattern, suite: sel.suite, psk, staticPriv: this._noiseKey,
      prologue: lib.buildNoisePrologue(this._serverHello, p, name),
    });
    const msg1 = await hs.writeMessage(enc.encode(lib.canonicalJson({ binarize: false, encodings: ["JSON-HEX"] })));
    this._shaking = hs;
    await this._send({ msg_type: "shake", payload: { noise: { pattern: sel.pattern, suite: sel.suite, msg: toHex(msg1) } } });
  }

  async _noiseReply(hexMsg) {
    const hs = this._shaking;
    if (!hs) throw new Error("a Noise reply this client did not ask for");
    const { lib } = await loadNoise();
    try {
      await hs.readMessage(fromHex(hexMsg));
      if (!hs.finished) {
        const msg3 = await hs.writeMessage(new Uint8Array(0));
        await this._send({ msg_type: "shake", payload: { noise: { msg: toHex(msg3) } } });
      }
    } catch (e) {
      // a wrong PSK fails here, cryptographically
      throw fail_("password", `Noise handshake failed – wrong password? (${e.message})`);
    }
    const transport = new lib.NoiseTransport(hs);
    if (this.opts.serverKey && transport.remoteStaticKey !== this.opts.serverKey) {
      throw fail_("server_key", "the house's Noise key changed since it was paired");
    }
    this._shaking = null;
    this.noise = transport;
    this.protocol = 3;
    await this._sayHello();
    // wait for the hub to accept our static key (or for its first frame)
    this._settling = true;
    await new Promise((r) => { this._settled = r; setTimeout(r, HiveMindClient.SETTLE_MS); });
    this._settling = false;
    if (!this.noise) return;   // it closed: onclose has failed the connect
    this.dispatchEvent(Object.assign(new Event("keys"), { keys: {
      psk: toHex(this._psk), pskNode: this.nodeId, noiseKey: toHex(this._noiseKey),
      serverKey: transport.remoteStaticKey, noise: true,
    } }));
    this._done();
  }

  // ------------------------------------------------- the old handshake
  async _passwordReply(p) {
    if (!this._iv) throw new Error("a handshake reply this client did not ask for");
    if (!(await matches(p.envelope, this.opts.password))) throw fail_("password", "HiveMind's answer doesn't match the password");
    if (p.cipher && !CIPHERS.includes(p.cipher)) throw new Error(`cipher ${p.cipher} not supported`);
    if (p.encoding && !CODECS[p.encoding]) throw new Error(`encoding ${p.encoding} not supported`);
    this.encoding = p.encoding || "JSON-HEX";
    const theirs = fromHex(p.envelope.slice(0, 16));
    const salt = this._iv.map((b, i) => b ^ theirs[i]);
    this.key = await deriveKey(this.opts.password, salt);
    this.protocol = 1;
    await this._sayHello();
    this._done();
  }

  async _sayHello() {
    await this._send({ msg_type: "hello", payload: {
      session: { session_id: this.opts.sessionId, lang: this.opts.lang, site_id: this.opts.siteId },
      site_id: this.opts.siteId,
    } });
  }

  _done() {
    this._fail = null;
    this._ready?.();
  }

  _bus(payload) {
    const message = typeof payload === "string" ? JSON.parse(payload) : payload;
    this.dispatchEvent(Object.assign(new Event("message"), { message }));
  }
}
