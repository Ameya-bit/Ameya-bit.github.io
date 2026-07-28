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
//   begin(ctx)          — ctx = { seed, cfg, ticks, stride, rules }
//   decide(state, tick) — at every decision tick, BEFORE the step, with the state
//                         the decider is acting from. `tick` is the tick the action
//                         will land on, so it pairs with the `sample` that follows.
//   sample(state, tick) — once per recorded tick (see `stride`)
//   end(summary)        — summary = { seed, ticks, samples }
//
// Sinks are called synchronously and must not mutate the state they are handed.
//
// `decide` exists because the two hooks see different worlds and a recorder needs
// the first one. `sample` runs after the step, so its state already contains the
// action's consequences — including, on the hat's own token, the facing he turned
// to and the cel he started. See `truth.js` for what that was measured to be worth
// to a clone (it is most of the direction label) and why recording happens here.

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

// Wrap a policy in the deployed decision-delay contract.
//
// On the page the forward pass runs in a Web Worker: the frame encoded at decision
// tick k is posted to the worker, and the action it produces is applied at decision
// tick k+1 — one decision interval (100 ms) later. That is a *pipelined* delay, not a
// race: the schedule is fixed, so behaviour does not depend on how fast the visitor's
// machine happens to be. This wrapper is the same contract for a headless episode, so
// the trainer can score — and Phase E can train — the timing a deployed policy
// actually lives under. D0 is the reason this exists before any RL does: a one-tick
// misalignment between what a policy sees and when its action lands was worth 93.3%
// of the direction label, so the deploy-time shift has to be in the training loop,
// not discovered after it.
//
// The inner policy is still consulted at every decision tick (its frame ring must
// stay a run of consecutive observations); only the *application* of its answer is
// shifted. The first `delay` decisions return null — the rules expert drives while
// the pipeline fills, exactly as the page behaves while the first result is in
// flight.
export function delayPolicy(policy, delay = 1) {
  if (!(Number.isInteger(delay) && delay >= 0)) {
    throw new Error(`delay must be a non-negative integer, got ${delay}`);
  }
  if (delay === 0) return policy;
  return {
    describe: `${policy.describe ?? 'policy'} (delayed ${delay} decision${delay > 1 ? 's' : ''})`,
    init(ctx) {
      const act = bindPolicy(policy, ctx);
      const queue = new Array(delay).fill(null);
      return (state, tick) => {
        queue.push(act(state, tick));
        return queue.shift();
      };
    },
  };
}

// Run one episode. Returns the summary; the data goes to the sink.
export function runEpisode({ seed, config = {}, sink = null, policy = null, rules = null, ...opts }) {
  const { ticks, stride, warmup } = { ...DEFAULT_ROLLOUT, ...opts };
  const engine = makeEngine(config);
  let state = engine.init(seed);

  // `rules` is the scoring rules this episode is being run under, handed to the
  // policy through `ctx` so that a yardstick prices the game it is actually paid
  // out of. Null for a plain recording rollout, which has no referee at all.
  const ctx = { seed, cfg: engine.cfg, ticks, stride, warmup, rules };
  sink?.begin?.(ctx);
  const act = bindPolicy(policy, ctx);

  let samples = 0;
  for (let t = 1; t <= warmup + ticks; t++) {
    // The policy sees the state it is acting FROM — tick t-1 — and its action is
    // applied during the step that produces tick t. That is the only causally
    // available information set: an action chosen from tick t would have to know
    // where its own step landed. The recorder is handed this same state through
    // `decide`, so a corpus row is the decision as it was actually faced.
    const decision = t % TICKS_PER_ACTION === 0;
    if (decision) sink?.decide?.(state, t);
    const action = act && decision ? act(state, t) : null;
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
