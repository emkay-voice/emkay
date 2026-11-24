// web/brains/hivemind.js against a real hivemind-core (issues #11, #120), in Node.
//
// Needs a running ovos-messagebus + hivemind-core, a client made with
//   hivemind-core add-client --name emkay-test --access-key K --password P
//   (hivemind-core 5: also --allow recognizer_loop:utterance --allow speak …)
// and something on the bus that answers an utterance (a real ovos-core, or
// tools/probes/hivemind_responder.py). Then:
//
//   HM_HOST=127.0.0.1 HM_PORT=5678 HM_KEY=K HM_PASSWORD=P node tools/probes/hivemind_node.mjs
//
// Logs: the handshake (and which protocol), an utterance answered by
// `speak`, that a wrong password and a wrong key are both refused, and on
// hivemind-core 5: a second connect with the saved keys (no argon2id, the
// same static key, the hub's key pinned), a connect with only the PSK from
// a pairing link, another static key refused (the hub pinned ours), and a
// hub whose key changed refused. HM_PSK=<hex> checks
// the PSK against Python's derive_psk.
import { HiveMindClient } from "../../web/brains/hivemind.js";

const base = {
  host: process.env.HM_HOST || "127.0.0.1", port: +(process.env.HM_PORT || 5678),
  ssl: process.env.HM_SSL === "1", key: process.env.HM_KEY, password: process.env.HM_PASSWORD,
};
const log = (m) => console.log(m);
let bad = 0;
const check = (ok, what) => { log(`${ok ? "ok  " : "BAD "} ${what}`); if (!ok) bad++; };

async function ask(hm, question = process.env.QUESTION || "what time is it") {
  const said = new Promise((resolve) => hm.addEventListener("message", (e) => {
    const m = e.message;
    if ((m.type === "speak" || m.type === "ovos.utterance.speak") && m.data?.utterance) resolve(m.data.utterance);
  }));
  await hm.emit("recognizer_loop:utterance", { utterances: [question], lang: "en-US" });
  return Promise.race([said, new Promise((r) => setTimeout(() => r(null), 15000))]);
}

async function session(opts, label) {
  const hm = new HiveMindClient(opts);
  let keys = null;
  hm.addEventListener("keys", (e) => { keys = e.keys; });
  const t0 = performance.now();
  await hm.connect(30000);
  const ms = Math.round(performance.now() - t0);
  log(`${label}: connected in ${ms} ms – protocol ${hm.protocol}, node ${String(hm.nodeId).slice(0, 40).replace(/\n/g, " ")}`);
  const answer = await ask(hm);
  check(!!answer, `${label}: speak – ${answer ?? "(nothing in 15 s)"}`);
  hm.close();
  return { keys, ms, protocol: hm.protocol };
}

const first = await session(base, "first connect");

for (const [what, opts] of [["wrong password", { password: "not-it" }], ["wrong key", { key: "not-it" }]]) {
  try {
    await new HiveMindClient({ ...base, ...opts }).connect(20000);
    check(false, `${what}: accepted`);
  } catch (e) {
    check(true, `${what}: refused [${e.code}] ${e.message}`);
  }
}

if (first.protocol === 3) {
  const k = first.keys;
  check(!!k && k.psk.length === 64 && k.noiseKey.length === 64 && !!k.serverKey, "keys event: psk, noiseKey, serverKey");
  if (process.env.HM_PSK) check(k.psk === process.env.HM_PSK, `PSK as Python's derive_psk (${k.psk.slice(0, 16)}…)`);

  // as Emkay starts the next time: everything saved with the house
  const again = await session({ ...base, ...k }, "saved keys");
  check(again.keys.noiseKey === k.noiseKey, "same static key the second time");
  check(again.ms < first.ms, `no argon2id the second time (${again.ms} ms < ${first.ms} ms)`);

  // a pairing link from Emkay Home: the PSK, no password needed for Noise
  await session({ ...base, password: "", psk: k.psk, noiseKey: k.noiseKey }, "psk from the link");

  // the hub pinned this Emkay's static key: another one (a browser that
  // forgot it) is told so, not left "connected" to a hub that said no
  try {
    await new HiveMindClient({ ...base, ...k, noiseKey: "11".repeat(32) }).connect(20000);
    check(false, "another static key: accepted");
  } catch (e) {
    check(e.code === "pinned", `another static key: refused [${e.code}]`);
  }

  // the hub's key is pinned: another key is refused
  try {
    await new HiveMindClient({ ...base, ...k, serverKey: "00".repeat(32) }).connect(20000);
    check(false, "changed server key: accepted");
  } catch (e) {
    check(e.code === "server_key", `changed server key: refused [${e.code}]`);
  }
} else {
  // a v4 hub: a house that once did Noise is not accepted with the old handshake
  try {
    await new HiveMindClient({ ...base, noise: true }).connect(20000);
    check(false, "downgrade after Noise: accepted");
  } catch (e) {
    check(e.code === "downgrade", `downgrade after Noise: refused [${e.code}]`);
  }
}

log(bad ? `${bad} failed` : "all good");
process.exit(bad ? 1 : 0);
