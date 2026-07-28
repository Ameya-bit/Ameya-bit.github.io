// Vectorized environments — E0's core, single process.
//
// BC trained from a static corpus; RL needs the live sim in the loop, and the sim
// is JS while the gradients are Python. This module is the JS half of that bridge:
// N episodes advancing in lockstep on `makeEpisodeStepper`, their decisions
// batched — observations out, actions in — at the 10 Hz decision clock. The
// worker pool (`vec-worker.js` / `vec-host.js`) shards one of these per thread,
// and `vec-serve.js` speaks it over a binary pipe to `trainer/py/vecenv.py`.
//
// Three contracts, all inherited rather than invented:
//
//  * **The reward is the game.** Each env scores through `scoreSink` — the same
//    ledger the C1–C5 gate reads — and the per-decision reward is the delta of
//    `ledgerScore` across the decision's ticks. Telescoping means the summed
//    rewards of an episode ARE its gate score (to float32, the wire's precision;
//    the episode return is the f64 ledger rounded once). There is no second
//    reward implementation to drift.
//  * **The observation is the sensor.** One `makeObserver` per env, slot memory
//    cold at each episode start (a policy joining mid-episode is cold too), one
//    `observe` per decision — the deployed cadence.
//  * **An episode is a pure function of its draw.** Env `i`'s episodes come off a
//    private PRNG stream seeded from (corpusSeed, absolute index), same recipe as
//    `configFactory`. Same corpusSeed, same worlds — across runs, and across any
//    sharding of envs into workers (`baseIndex` keeps the stream tied to the
//    absolute env, not the worker's slot).
//
// The action protocol is the seam's own: an integer 0..16, or `EXPERT_ACTION`
// (−1) to hand the decision to the rules expert — which is both the deploy-time
// fallback and how the first `delay` decisions of an episode behave while the
// pipeline fills. The delay contract itself lives on the *policy* side (the net
// answering at decision k+1 for the frame at k, as in `delayPolicy` and
// `data.py`); the env stays synchronous and is agnostic to it.
//
// Episode ends auto-reset: the returned observation is the FIRST frame of the
// next episode, `dones[i]` is 1, and `returns[i]` carries the finished episode's
// ledger total (score, not score/min). Staggering cuts env i's first episode
// short by a deterministic draw so a fleet does not reset in phase — without it,
// every env ends on the same decision and the batch is a wall of correlated
// resets.

import { makeEpisodeStepper, hatOf } from './rollout.js';
import { isValidAction } from '../assets/pandas/engine/actions.js';
import { makeObserver } from '../assets/pandas/engine/policy/obs.js';
import { scoreSink, ledgerScore } from './game.js';
import { SPECS } from './corpus.js';
import { Rng } from '../assets/pandas/engine/rng.js';
import { TICKS_PER_ACTION } from '../assets/pandas/engine/tick.js';

export const EXPERT_ACTION = -1;

// The shortest legal episode: enough ticks to hold at least one decision.
const MIN_EPISODE_TICKS = TICKS_PER_ACTION * 100;

export function makeVecEnv({
  envs,
  spec = 'wild',
  corpusSeed = 20260728,
  rules = {},
  ticks = 12000,
  obsParams = {},
  baseIndex = 0,
  stagger = true,
  // Test seam: override what an env's next episode is. (absIndex, episode, rng)
  // -> { seed, config, ticks }. The default draws from the spec stream.
  drawFor = null,
} = {}) {
  if (!(Number.isInteger(envs) && envs > 0)) throw new Error(`envs must be a positive integer, got ${envs}`);
  if (!SPECS[spec]) throw new Error(`unknown corpus spec: ${spec} (have ${Object.keys(SPECS)})`);

  const observer = makeObserver(obsParams); // params/layout only; each env has its own buffer+memory
  const { length } = observer.layout;

  const obs = new Float32Array(envs * length);
  const rewards = new Float32Array(envs);
  const dones = new Uint8Array(envs);
  const applied = new Int8Array(envs);
  const returns = new Float32Array(envs);

  const draw = drawFor ?? ((absIndex, episode, rng) => ({
    seed: rng.int(0xffffffff) | 0,
    config: SPECS[spec](rng),
    ticks,
  }));

  const lanes = [];
  for (let i = 0; i < envs; i++) {
    const absIndex = baseIndex + i;
    lanes.push({
      absIndex,
      episode: 0,
      rng: new Rng((corpusSeed ^ (absIndex * 0x9e3779b1)) | 0),
      observer: makeObserver(obsParams),
      mem: null, sink: null, stepper: null, at: null, prevScore: 0,
    });
  }

  const beginEpisode = (lane) => {
    const ep = draw(lane.absIndex, lane.episode, lane.rng);
    let epTicks = ep.ticks ?? ticks;
    // Stagger the fleet: the first episode is cut short by a deterministic draw.
    // An injected `drawFor` is authoritative about its ticks, so it is never cut.
    if (stagger && !drawFor && lane.episode === 0) {
      epTicks = Math.max(MIN_EPISODE_TICKS,
        Math.ceil((epTicks - lane.rng.int(epTicks)) / TICKS_PER_ACTION) * TICKS_PER_ACTION);
    }
    lane.episode += 1;
    lane.sink = scoreSink(rules);
    lane.stepper = makeEpisodeStepper({
      seed: ep.seed, config: ep.config, ticks: epTicks,
      stride: 1, warmup: 0, sink: lane.sink, rules: lane.sink.rules,
    });
    lane.mem = lane.observer.init();
    lane.prevScore = 0;
    lane.at = lane.stepper.start();
    if (!lane.at) throw new Error(`episode of ${epTicks} ticks held no decision`);
  };

  const encode = (lane, i) => {
    lane.observer.observe(lane.at.state, lane.mem, obs.subarray(i * length, (i + 1) * length));
    applied[i] = hatOf(lane.at.state).action;
  };

  for (let i = 0; i < envs; i++) { beginEpisode(lanes[i]); encode(lanes[i], i); }

  return {
    envs,
    layout: observer.layout,
    params: observer.params,
    spec,
    corpusSeed,
    rules: scoreSink(rules).rules,

    // The initial frames — valid until the first `step`. Same buffers as `step`
    // returns: they are reused every call, so copy anything you keep.
    reset() {
      rewards.fill(0); dones.fill(0); returns.fill(0);
      return { obs, rewards, dones, applied, returns };
    },

    // One decision for every env. `actions[i]` is 0..16, or EXPERT_ACTION (-1) /
    // anything out of range to let the rules expert drive that env's decision.
    step(actions) {
      if (actions.length !== envs) throw new Error(`expected ${envs} actions, got ${actions.length}`);
      for (let i = 0; i < envs; i++) {
        const lane = lanes[i];
        const a = actions[i];
        lane.at = lane.stepper.advance(isValidAction(a) ? a : null);
        const score = ledgerScore(lane.sink.ledger);
        rewards[i] = score - lane.prevScore;
        lane.prevScore = score;
        if (lane.at === null) {
          dones[i] = 1;
          returns[i] = score;
          lane.stepper.summary();
          beginEpisode(lane);
        } else {
          dones[i] = 0;
          returns[i] = 0;
        }
        encode(lane, i);
      }
      return { obs, rewards, dones, applied, returns };
    },
  };
}
