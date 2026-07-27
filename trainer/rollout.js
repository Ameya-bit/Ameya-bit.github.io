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
//
// Phase C adds the fourth: **a policy can drive.** `policy` is consulted once per
// decision tick and its action goes into `step(state, action)`; leaving it null is
// the expert, which is what every Phase-B corpus was cut with.

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

// Bind a policy to one episode. A policy is either a bare
//
//   (state, tick) -> action | null
//
// or an object with `init(ctx) -> actor` for anything that needs per-episode state
// (an observer's slot memory, its own PRNG). That mirrors `makeObserver`/`makeEngine`
// — a factory whose `init` mints the episode's scratch — so the three compose without
// a fourth convention. Returning null (or an out-of-range value) hands that tick back
// to the rules expert, which is also the seam's NaN-logit fallback in the engine.
export function bindPolicy(policy, ctx) {
  if (!policy) return null;
  if (typeof policy === 'function') return policy;
  if (typeof policy.init === 'function') return policy.init(ctx);
  throw new Error('policy must be a function (state, tick) -> action, or have init(ctx)');
}

// Run one episode. Returns the summary; the data goes to the sink.
export function runEpisode({ seed, config = {}, sink = null, policy = null, ...opts }) {
  const { ticks, stride, warmup } = { ...DEFAULT_ROLLOUT, ...opts };
  const engine = makeEngine(config);
  let state = engine.init(seed);

  const ctx = { seed, cfg: engine.cfg, ticks, stride, warmup };
  sink?.begin?.(ctx);
  const act = bindPolicy(policy, ctx);

  let samples = 0;
  for (let t = 1; t <= warmup + ticks; t++) {
    // The policy sees the state it is acting FROM — tick t-1 — and its action is
    // applied during the step that produces tick t. That is the only causally
    // available information set: an action chosen from tick t would have to know
    // where its own step landed. ⚠️ The Phase-B corpora pair the action applied at
    // tick t with the observation encoded AFTER that step, so a BC policy fed
    // `obs(t-1)` here is a tick off its training pairing. Noted, not resolved:
    // it is Phase D's to settle, and it cancels out of any comparison run here
    // (every policy reads the same states).
    const action = act && t % TICKS_PER_ACTION === 0 ? act(state, t) : null;
    // No action: the rules expert drives, and what it applied lands on hat.action.
    state = engine.step(state, action);
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
