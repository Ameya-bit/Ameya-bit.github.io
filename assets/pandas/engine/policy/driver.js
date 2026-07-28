// The policy seam's other end: a trained net, driving the hat panda.
//
// `watcher.js` is the rules expert and returns a 17-way action. This returns one too,
// from the same interface, which is the whole point of Phase A's action seam — the
// page, the trainer and the evaluator all call the same shape and none of them knows
// which brain is behind it.
//
// It owns everything an episode's worth of inference needs and nothing else: the
// observer and its slot memory, a ring of the last `frames` observations, its own
// PRNG, and the fallback bookkeeping.
//
// ## Three decisions worth stating
//
// **It samples; it never takes the argmax.** A deterministic policy reads as a drone
// — the same picture always producing the same stride, with none of the hesitation a
// living thing has. The BC-derived softmax already carries the expert's own variety,
// so sampling from it is character for free (the plan, "Deployment"). It also makes
// the 86%-HOLD mass do the right thing: the expert's pacing becomes a cadence rather
// than a threshold the argmax always rounds to a standstill.
//
// **Its PRNG is its own, not the sim's.** Drawing from `state.rng` would consume the
// engine's stream and change the world as a side effect of thinking, so two runs of
// the same seed would diverge on whether a policy was attached. The driver carries a
// separate generator, seeded from the episode, so a policy run is reproducible and a
// no-policy run is byte-identical to what it always was.
//
// **A bad forward pass hands the tick back, it does not guess.** Returning null gives
// the tick to the rules expert — already the seam's defined behaviour for an invalid
// action, already tested. So NaN logits degrade to the shipped character rather than
// to a frozen panda, and if it keeps happening the driver stops asking.

import { mulberry32Next } from '../rng.js';
import { ACTION, isValidAction } from '../actions.js';
import { makeObserver } from './obs.js';
import { exp } from '../mathx.js';

export const DEFAULT_DRIVER = Object.freeze({
  // Softmax temperature on the *family* choice — hold, step, or roll. 1 is the
  // trained distribution; below it sharpens toward the argmax, above it dithers.
  temperature: 1,
  // Softmax temperature on the *direction*, once a family is chosen.
  //
  // These are two knobs because the clone is good at one of these questions and bad
  // at the other, and one temperature cannot serve both. Measured on the eval corpus:
  // asked which of 8 directions the expert stepped, the clone is right 55.1% of the
  // time against 12.5% chance — it knows where to go. Asked *whether* to step at all
  // it is nearly blind, because the expert's stride timer (`moveTimer`) is internal
  // state no observation exposes, so the honest posterior over "step now?" is close
  // to the base rate.
  //
  // A single temperature couples them the wrong way round: sharpening to clean up the
  // wandering also collapses the family distribution onto HOLD, and the dive-roll —
  // 3.5% of the expert's actions and the entire point of Phase D's "does he still
  // dodge" — disappears first. Measured: at T=1 the clone rolls on 1.0% of ticks; at
  // T=0.6, 0.0%. So the family is sampled at the trained temperature, which keeps the
  // cadence and the reflex, and only the direction is sharpened.
  dirTemperature: 0.5,
  // Consecutive bad forward passes before the driver retires for the rest of the
  // visit. One is a hiccup worth surviving; a run of them is a broken weight file,
  // and asking again 10 times a second for an hour is worse than not asking.
  maxFailures: 8,
});

// Build a driver factory. Shaped like `makeObserver`/`makeEngine`: `init(ctx)` mints
// the per-episode scratch and returns the `(state, tick) -> action` the seam calls.
export function makePolicyDriver(net, options = {}) {
  const opts = { ...DEFAULT_DRIVER, ...options };
  const cfg = net.cfg;

  return {
    net,
    init(ctx = {}) {
      const observer = options.observer ?? makeObserver(options.obsParams ?? {});
      if (observer.layout.tokens !== cfg.tokens) {
        throw new Error(`policy: net wants ${cfg.tokens} tokens, observer emits ${observer.layout.tokens}`);
      }
      const frameLen = observer.layout.length;
      const mem = observer.init();
      const ring = Array.from({ length: cfg.frames }, () => new Float32Array(frameLen));
      const probs = new Float32Array(cfg.n_actions);

      let newest = -1; // no frame recorded yet
      let rng = (ctx.seed ?? 0) | 0;
      let failures = 0;
      let retired = false;
      const stats = { decisions: 0, fallbacks: 0, retired: false };

      const draw = () => {
        const next = mulberry32Next(rng);
        rng = next.state;
        return next.value;
      };

      return function act(state) {
        if (retired) return null;
        stats.decisions += 1;

        // Advance the ring. The first decision of an episode has no history, so the
        // new frame is copied into *every* slot — the "repeat the earliest frame"
        // rule the training windows were built with (trainer/py/data.py). Zero-fill
        // would be a different rule and a lie besides: an all-zero frame is a legal
        // observation meaning "nobody anywhere".
        newest = newest < 0 ? 0 : (newest + 1) % cfg.frames;
        const frame = observer.observe(state, mem);
        if (stats.decisions === 1) for (const slot of ring) slot.set(frame);
        else ring[newest].set(frame);

        const logits = net.forward(ring, newest);
        const action = sample(logits, probs, opts, draw);
        if (action === null) {
          failures += 1;
          stats.fallbacks += 1;
          if (failures >= opts.maxFailures) { retired = true; stats.retired = true; }
          return null; // the rules expert takes this tick
        }
        failures = 0;
        return action;
      };
    },
    // Read-only view for the debug overlay and the evaluator.
    describe: () => ({ ...cfg, temperature: opts.temperature }),
  };
}

// Sample an action from the logits in two stages: which *kind* of thing to do, then
// which way. Returns null — never a guess — if anything about the distribution is
// unusable, which is the seam's signal to hand the tick to the rules expert.
//
// The split follows the action space's own structure (hold / step x 8 / roll x 8) and
// exists because the two questions have different answer qualities — see
// `dirTemperature` above. It is a change to how the trained distribution is *read*,
// not to the distribution: at `dirTemperature = 1` this is exactly a softmax sample
// over all 17, and a test pins that.
export function sample(logits, probs, opts, draw) {
  const { temperature: T, dirTemperature: DT } = opts;
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i];
    if (!Number.isFinite(v)) return null; // NaN / Inf: the weights or the frame are bad
    if (v > max) max = v;
  }

  // Family marginals at the trained temperature. Softmax is shift-invariant, so
  // subtracting the global max keeps `exp` in range without changing any ratio.
  const invT = 1 / T;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const p = exp((logits[i] - max) * invT);
    probs[i] = p;
    sum += p;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return null;

  let hold = probs[ACTION.HOLD];
  let step = 0;
  let roll = 0;
  for (let d = 0; d < 8; d++) {
    step += probs[ACTION.STEP_BASE + d];
    roll += probs[ACTION.ROLL_BASE + d];
  }

  let target = draw() * sum;
  if ((target -= hold) <= 0) return ACTION.HOLD;
  const base = (target -= step) <= 0 ? ACTION.STEP_BASE : ACTION.ROLL_BASE;

  // Direction, from the conditional within the chosen family, re-tempered. The
  // logits are re-exponentiated rather than re-weighted from `probs`, because
  // raising an already-exponentiated probability to a power is the same arithmetic
  // with worse conditioning when the mass is concentrated.
  let dmax = -Infinity;
  for (let d = 0; d < 8; d++) if (logits[base + d] > dmax) dmax = logits[base + d];
  const invDT = 1 / DT;
  let dsum = 0;
  for (let d = 0; d < 8; d++) {
    const p = exp((logits[base + d] - dmax) * invDT);
    probs[base + d] = p;
    dsum += p;
  }
  if (!(dsum > 0) || !Number.isFinite(dsum)) return null;

  let pick = draw() * dsum;
  for (let d = 0; d < 8; d++) {
    if ((pick -= probs[base + d]) <= 0) {
      const a = base + d;
      return isValidAction(a) ? a : null;
    }
  }
  // Rounding left the target just past the accumulated total: take the last.
  return base + 7;
}
