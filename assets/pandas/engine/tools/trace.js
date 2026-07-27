// Golden-trace runner — engine-agnostic.
//
// Given a deterministic engine (init/step/encode) it produces per-tick state
// checksums and folds them into a per-seed digest, then a whole-batch digest.
// The same module runs in Node (this is the reference) and in the browser
// (tools/golden.html); identical digests are the proof that the shipped engine
// and the trainer's engine are the same machine.
//
// An "engine" here is any object of the shape:
//   init(seed: number)          -> state          (pure; seed fully determines it)
//   step(state, action?)        -> state          (pure; no clock, no Math.random)
//   encode(state)               -> number[]       (flat, fixed-order state numbers)
// `actions` is optional — a function (tick, state) -> action, for driving the
// hat panda's 17-way interface later. Absent, the engine free-runs.

import { hashNumbers, foldHashes } from './checksum.js';

// Run one seed for `ticks` steps. Returns the per-seed digest and, optionally,
// the full per-tick hash stream (used by tests and bisection; skipped by default
// to keep 10k-tick runs cheap on memory).
export function runSeed({ engine, seed, ticks, actions = null, keepStream = false }) {
  let state = engine.init(seed);
  const stream = keepStream ? new Uint32Array(ticks + 1) : null;
  // Hash the initial state too, so a seeding bug is caught at tick 0.
  let digest = hashNumbers(engine.encode(state));
  if (stream) stream[0] = digest;
  const hashes = keepStream ? null : [digest];

  for (let t = 1; t <= ticks; t++) {
    const action = actions ? actions(t, state) : undefined;
    state = engine.step(state, action);
    const h = hashNumbers(engine.encode(state));
    if (stream) stream[t] = h;
    else hashes.push(h);
  }

  const seedDigest = stream ? foldHashes(stream) : foldHashes(hashes);
  return { seed, ticks, digest: seedDigest, stream };
}

// Run a batch of seeds. Returns each seed's digest plus a batch digest folding
// them all — the single number Phase A compares between Node and the browser.
export function runTrace({ engine, seeds, ticks, actions = null }) {
  const results = seeds.map((seed) => {
    const { digest } = runSeed({ engine, seed, ticks, actions });
    return { seed, digest };
  });
  const batch = foldHashes(results.map((r) => r.digest));
  return { ticks, seeds: results, batch };
}

// The Phase-A seed set: 32 seeds. Fixed and explicit so Node and browser trace
// exactly the same rollouts.
export const PHASE_A_SEEDS = Array.from({ length: 32 }, (_, i) => (i + 1) * 0x9e3779b1 | 0);

// Find the first tick at which two per-tick hash streams diverge — the bisection
// tool for when a refactor breaks determinism. Returns -1 if identical.
export function firstDivergence(streamA, streamB) {
  const n = Math.min(streamA.length, streamB.length);
  for (let t = 0; t < n; t++) {
    if (streamA[t] !== streamB[t]) return t;
  }
  return streamA.length === streamB.length ? -1 : n;
}
