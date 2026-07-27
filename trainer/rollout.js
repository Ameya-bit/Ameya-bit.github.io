// The rollout harness — one episode of the shipped engine, headless.
//
// Phase B's foundation (design/panda-policy-net.md). Everything downstream is a
// sink plugged into this: ground-truth logging, the observation encoder, corpus
// shards, and later the on-policy loop that swaps the expert for a network.
//
// Three properties this file exists to guarantee:
//
//  1. **It records the shipped machine.** The engine is imported from
//     ../assets/pandas/engine, not vendored. A corpus can never drift from the
//     hero the visitor sees, and the parity gate's promise (Node ≡ browser)
//     extends to every trajectory in it.
//  2. **An episode is a pure function of (seed, config).** No wall clock, no
//     Math.random. Re-running one reproduces it tick for tick, which is what makes
//     a corpus re-cuttable from a manifest instead of a 10 GB file.
//  3. **The action is read, never re-derived.** `step(state)` lets the built-in
//     rules expert decide and writes what it applied to `hat.action`. That value
//     IS the behaviour-cloning target. Calling `rulesAction` again to "ask what the
//     expert would do" would be wrong twice over: it mutates the watcher's brain
//     (it is the expert, not a dry run), and its answer need not match what the
//     engine actually applied on a non-decision tick or mid-roll.

import { makeEngine } from '../assets/pandas/engine/engine.js';
import { TICKS_PER_ACTION } from '../assets/pandas/engine/tick.js';

// A sink receives the episode. Every method is optional, so a bare `{}` is a
// legal (if useless) sink and a bench can pass nothing at all.
//
//   begin(ctx)          — ctx = { seed, cfg, ticks, stride }
//   sample(state, tick) — once per recorded tick (see `stride`)
//   end(summary)        — summary = { seed, ticks, samples }
//
// Sinks are called synchronously and must not mutate the state they are handed.

export const DEFAULT_ROLLOUT = Object.freeze({
  // How long an episode runs, in engine ticks. 12000 = 10 minutes of sim.
  ticks: 12000,
  // Record every `stride` ticks. The default is the policy's own clock: the hat
  // panda decides at 10 Hz, so a 20 Hz record would be half redundant frames and
  // twice the disk. Ground truth that must be per-tick can override it.
  stride: TICKS_PER_ACTION,
  // Ticks to run before recording starts. The entrance is ~12 s of walk-on during
  // which nobody collides; it is deliberately IN the corpus by default (it is the
  // calmest stretch a deployed policy meets, and where camping exploits live), so
  // this is 0 unless a corpus spec says otherwise.
  warmup: 0,
});

// Run one episode. Returns the summary; the data goes to the sink.
export function runEpisode({ seed, config = {}, sink = null, ...opts }) {
  const { ticks, stride, warmup } = { ...DEFAULT_ROLLOUT, ...opts };
  const engine = makeEngine(config);
  let state = engine.init(seed);

  sink?.begin?.({ seed, cfg: engine.cfg, ticks, stride, warmup });

  let samples = 0;
  for (let t = 1; t <= warmup + ticks; t++) {
    // No action argument: the rules expert drives, and what it applied lands on
    // hat.action. When a policy takes over, this is the one line that changes.
    state = engine.step(state);
    if (t > warmup && (t - warmup) % stride === 0) {
      sink?.sample?.(state, t - warmup);
      samples += 1;
    }
  }

  const summary = { seed, ticks, samples };
  sink?.end?.(summary);
  return summary;
}

// Run many episodes through one sink, in order. Deterministic given the seeds.
export function runEpisodes({ seeds, configFor = () => ({}), sink = null, ...opts }) {
  return seeds.map((seed, i) =>
    runEpisode({ seed, config: configFor(seed, i), sink, ...opts }));
}

// A sink that keeps everything in memory. For tests and small inspections only —
// a real corpus goes to shards.
export function arraySink(project = (state, tick) => ({ tick, action: hatOf(state).action })) {
  const rows = [];
  return {
    rows,
    begin(ctx) { this.ctx = ctx; },
    sample(state, tick) { rows.push(project(state, tick)); },
  };
}

// The hat panda — the one entity a policy drives. Identified by `hasHat` rather
// than by index, because the entrance shuffles spawn order.
export function hatOf(state) {
  return state.entities.find((e) => e.hasHat);
}
