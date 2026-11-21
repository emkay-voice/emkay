// Emkay – the speech models are opened one at a time.
//
// Whisper (whisper.js) and Piper (piper.js) both start loading as soon as
// OVOS is up (speech.prewarm). Opening a model holds its download in
// JavaScript while ONNX Runtime copies it into WebAssembly memory and builds
// the session; two at once put both of those peaks on top of each other,
// which a phone's browser tab may not survive (Safari ends the tab, and the
// page starts over). WebAssembly memory never shrinks, but what one model
// frees after opening, the next one can use.
//
// Only the opening waits its turn; running a model that is open does not.

/**
 * ONNX Runtime's session options for the speech models: no memory arena and
 * no memory pattern. Both keep buffers sized for the biggest run so far,
 * per session, for speed on a server; here they cost memory a phone needs.
 */
export const LEAN = { enableCpuMemArena: false, enableMemPattern: false };

let tail = Promise.resolve();

/** Run `open` after every model asked for before it has been opened (or failed). */
export function oneAtATime(open) {
  const turn = tail.then(open, open);
  tail = turn.catch(() => {});
  return turn;
}
