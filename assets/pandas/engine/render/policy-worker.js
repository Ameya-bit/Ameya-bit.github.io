// The forward pass, off the main thread.
//
// Phase D measured the clone at p99 2 ms *in the page* against a 1 ms budget — Node's
// 567 µs mean flatters the tail ~3.5×, and on a visitor's five-year-old laptop the
// tail is worse still. The answer is not a faster kernel, it is a different thread:
// decisions are at 10 Hz and the renderer interpolates, so an action arriving one
// decision late is invisible, while a 2 ms stall on the main thread is a dropped
// frame. This worker owns the net and the frame ring; the main thread owns the
// observation encoder (it needs the live state) and the sampler (it owns the PRNG).
//
// The schedule is *pipelined, not raced*: the frame posted at decision k produces
// the action applied at decision k+1, whether the forward pass took 0.5 ms or 15.
// A fixed schedule is a contract training can share (`--delay 1` in trainer/py) —
// a race would make behaviour depend on the visitor's hardware, which is exactly
// the class of silent train/deploy skew D0 exists to warn about.
//
// Protocol (all messages carry `epoch` so a rebuilt episode ignores stale replies):
//   -> { type: 'init', manifest, blob }        blob: ArrayBuffer of policy.bin
//   <- { type: 'ready' } | { type: 'error', message }
//   -> { type: 'reset', epoch }                new episode: forget the ring
//   -> { type: 'frame', epoch, seq, frame }    one encoded observation
//   <- { type: 'logits', epoch, seq, logits } | { type: 'error', epoch, seq, message }
//   -> { type: 'bench', iters }                tools/policy-bench.html only
//   <- { type: 'bench', times }                per-call ms, measured in here
//
// This file is presentation-layer (render/): it owns a message loop and the wall
// clock the bench uses, which engine code may not. The arithmetic it *runs* is all
// engine code — `net.js` under the determinism lint — so the action a worker
// produces is the action the trainer's synchronous path would have produced from
// the same frames.

import { makeNet, decodeFloat16 } from '../policy/net.js';

let net = null;
let ring = null;
let newest = -1;

function primeOrAdvance(frame) {
  // The same rule as driver.js and trainer/py/data.py: the first decision of an
  // episode has no history, so the first frame fills every slot of the ring.
  if (newest < 0) {
    newest = 0;
    for (const slot of ring) slot.set(frame);
  } else {
    newest = (newest + 1) % ring.length;
    ring[newest].set(frame);
  }
}

onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      net = makeNet(msg.manifest, decodeFloat16(new Uint8Array(msg.blob)));
      const { tokens, obs_width: width, frames } = net.cfg;
      ring = Array.from({ length: frames }, () => new Float32Array(tokens * width));
      newest = -1;
      postMessage({ type: 'ready' });
    } else if (msg.type === 'reset') {
      newest = -1;
    } else if (msg.type === 'frame') {
      primeOrAdvance(msg.frame);
      const logits = net.forward(ring, newest);
      // A copy, because `forward` returns the net's own buffer and postMessage
      // does not snapshot until it serialises.
      postMessage({ type: 'logits', epoch: msg.epoch, seq: msg.seq, logits: Float32Array.from(logits) });
    } else if (msg.type === 'bench') {
      // Time raw forward passes where they actually run, over whatever history the
      // ring holds — the bench page posts real encoded frames first, so the input
      // has a live observation's sparsity. A bare ring gets a deterministic filler
      // instead. Reported per call so the page can print percentiles, which is
      // what a budget is written against.
      const synthetic = newest < 0;
      if (synthetic) {
        for (const slot of ring) for (let i = 0; i < slot.length; i++) slot[i] = (i % 7) / 7;
        newest = 0;
      }
      const iters = msg.iters ?? 500;
      for (let i = 0; i < 100; i++) net.forward(ring, i % ring.length); // warm-up
      const times = new Float64Array(iters);
      for (let i = 0; i < iters; i++) {
        const t0 = performance.now();
        net.forward(ring, i % ring.length);
        times[i] = performance.now() - t0;
      }
      if (synthetic) newest = -1; // leave no bench residue in a real episode's history
      postMessage({ type: 'bench', times });
    }
  } catch (err) {
    postMessage({ type: 'error', epoch: msg.epoch, seq: msg.seq, message: String(err?.message ?? err) });
  }
};
