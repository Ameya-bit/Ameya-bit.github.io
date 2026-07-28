// The policies the game is scored against.
//
// C1 shipped the three that need no information discipline at all — the shipped
// expert, and the two floors it has to beat. C2 adds the ones the yardstick is
// actually made of: the privileged oracle and the two memoryless twins, which are
// **one planner** (`planner.js`) over three beliefs (`percept.js`) and so differ
// from each other only in what they may read; plus the scripted exploit bots, whose
// whole job is to find a score the game did not mean to offer.
//
// A policy is `(state, tick) -> action | null`, or `{ init(ctx) -> that }` for
// anything holding per-episode scratch (see `bindPolicy` in rollout.js). Returning
// null hands the tick back to the rules expert — which is exactly how `expert` is
// implemented, and is also the engine's own fallback for a NaN logit.
//
// ⚠️ Every policy here must be a pure function of what it is handed. No
// `Math.random` (take a PRNG off the episode seed), no wall clock: a score that is
// not reproducible is not a measurement.

import { Rng } from '../assets/pandas/engine/rng.js';
import { ACTION, stepAction } from '../assets/pandas/engine/actions.js';
import { hypot } from '../assets/pandas/engine/mathx.js';

import { chooseWeaveDir } from '../assets/pandas/engine/watcher.js';
import { hatOf } from './rollout.js';
import { makePlanner } from './planner.js';
import { oracle, reactiveTruth, reactiveObs } from './percept.js';

// The shipped rules watcher — attention picker, weave, reflex, dive-roll. Not a
// baseline so much as the incumbent: it is what the site runs today, what Phase B's
// 17 GB of corpora recorded, and what the Phase-D clone is cloning. Passing no
// action is not a shortcut for it, it is the *definition* — `hat.action` is then
// what the expert applied, and re-deriving it through `rulesAction` would mutate
// the watcher's brain mid-episode (see rollout.js).
export const expert = {
  describe: 'the shipped rules watcher (engine default)',
  init: () => () => null,
};

// Never moves. The degenerate floor, and a more interesting one than it sounds:
// he spawns somewhere plausible and the field comes to him, so `still` is the
// score you get for *being in a crowd of pandas without deciding anything*. If a
// trained policy cannot clear this, nothing else in the phase means anything.
export const still = {
  describe: 'always HOLD — the do-nothing floor',
  init: () => () => ACTION.HOLD,
};

// Uniform over all 17 actions. Worse than `still` if the costs are priced right
// (it pays for strides and rolls it gets nothing for), which is the cheapest
// available check that the cost side of the ledger has any teeth.
export const random = {
  describe: 'uniform over the 17 actions',
  init: ({ seed }) => {
    // Off the episode seed, but not equal to it: sharing a stream with the sim
    // would correlate the policy's draws with the world's.
    const rng = new Rng((seed ^ 0x9e3779b1) | 0);
    return () => rng.int(ACTION.COUNT);
  },
};

// ---- the yardsticks (C2): one planner, three information sets ----

// The upper bound. True state, the incident feed, and every FSM's own countdown —
// so it knows what each thing is, how long it has been going, and how long it has
// left. No deployed policy will ever have any of that; the number exists to be the
// ceiling the gap is measured down from.
export const oraclePolicy = makePlanner({ percept: oracle });

// The **conservative** reactive ceiling: identical privilege, minus everything that
// can only be known by having watched. It strictly dominates any memoryless policy
// reading observations, so `oracle − reactiveTruth` is a lower bound on the memory
// gap — whatever that difference is, no 2-frame network can close it.
export const reactiveTruthPolicy = makePlanner({ percept: reactiveTruth });

// The **realistic** reactive ceiling, and the honest analogue of the plan's
// memoryless twin: one observation frame, visible slots only, no incident feed. It
// cannot tell a sleeper from a panda that was just run over, so it prices both at
// the measured base rate for "down". `oracle − reactiveObs` is the full gap.
export const reactiveObsPolicy = makePlanner({ percept: reactiveObs });

// ---- the exploit bots (C2): scripted attempts to break the game ----
//
// The plan's exit says every one of these should score much nearer the reactive
// ceiling than the oracle. Each targets a named degenerate optimum from the
// pre-training geometry audit; they are deliberately dumb, because an exploit that
// needs a clever bot is not an exploit.

// Go somewhere and stand there. Two details are not decoration: it **paces itself**
// at the hat's own cadence (the seam has no speed limit — see planner.js) and it
// has a **dead zone**, because a 50px stride cannot land on a point and a bot
// chasing an exact target oscillates across it forever, paying `stepCost` on every
// decision tick. The first draft of these bots did exactly that and scored −200 a
// minute, which looked like a damning verdict on camping and was a verdict on me.
function standAt(describe, site) {
  return {
    describe,
    init: () => {
      let nextStrideAt = 0;
      return (state, tick) => {
        const hat = hatOf(state);
        const cfg = state.cfg;
        const [tx, ty] = site(state, hat, cfg);
        if (hypot(tx - hat.lx, ty - hat.ly) < cfg.step * 1.5) return ACTION.HOLD;
        if (tick < nextStrideAt) return ACTION.HOLD;
        const dir = chooseWeaveDir(hat, tx, ty, state.entities, cfg);
        if (dir < 0) return ACTION.HOLD;
        nextStrideAt = tick + cfg.hatMove;
        return stepAction(dir);
      };
    },
  };
}

// The plan's spawn-centroid camper: incidents come to the middle, and standing in
// the middle collects a stream of *fresh* ones, each paying full early-arrival rate
// — the hole that per-incident diminishing returns cannot close.
export const camper = standAt(
  'walk to the middle of the stage and stay there',
  (state, hat, cfg) => [cfg.width / 2, cfg.height / 2],
);

// The R_VIEW-intersection parker: stand where the live incidents cluster, so one
// tick of standing is paid several times over (`payAll`). Privileged — it reads the
// feed — because an exploit bot's job is to find the ceiling of an exploit, not to
// be a plausible agent. The centroid is a cheap stand-in for the true
// maximum-overlap point: if even the centroid pays double, the exploit is real.
export const parker = standAt(
  'stand where the live incidents cluster (privileged)',
  (state, hat, cfg) => {
    const live = state.incidents.filter((i) => i.expires > state.tick);
    if (!live.length) return [hat.lx, hat.ly];
    const pts = live.map((i) => {
      const s = i.subject >= 0 ? state.entities.find((e) => e.id === i.subject) : null;
      return s ? { x: s.x, y: s.y } : { x: i.px, y: i.py };
    });
    return [
      pts.reduce((a, p) => a + p.x, 0) / pts.length,
      pts.reduce((a, p) => a + p.y, 0) / pts.length,
    ];
  },
);

// Get into a corner and stay out of everyone's way. The knockdown penalty's
// degenerate optimum: if being floored costs more than watching pays, the best play
// is to stop playing. This is the bot that says whether the +view/−hit ratio (D3)
// is set anywhere near right.
export const cowerer = standAt(
  'retreat to the nearest corner and stay out of the way',
  // The corner he is already nearest, so the exploit is not taxed by a trek across
  // the whole stage before it starts.
  (state, hat, cfg) => [
    hat.lx < cfg.width / 2 ? cfg.boundLower : cfg.width + cfg.boundLower,
    hat.ly < cfg.height / 2 ? cfg.boundLower : cfg.height + cfg.boundLower,
  ],
);

// The speed exploit, priced. `applyHatAction` executes a STEP immediately with no
// cadence check — pacing lives in the policy by design — so a policy that strides
// every decision tick travels 25 px/tick against the expert's 4.5, and nothing in
// the game charges for it (the movement cost is per stride, so per *pixel*). This
// is the oracle with the brake off; the difference between the two is what that
// hole is worth.
export const speeder = makePlanner({ percept: oracle, options: { strideEvery: 2 } });

// The roll exploit, priced — the same species as `speeder` and a worse one. The
// dive-roll's limiter (`rollReadyAt`, 52 ticks) is checked by the rules expert's
// own reflex and by nothing else, so `applyHatAction` will begin a roll on any
// decision tick a policy asks for one. A roll carries 92px over 5 ticks (18 px/tick
// against the expert's 4.5) and `engine.js` skips ROLLING in the collision pass, so
// a policy that simply travels by rolling is faster than the speed exploit *and*
// cannot be knocked down at all — it buys immunity to `knockPenalty` for 2 points.
// This is the oracle with that brake off. `strideEvery: 1` is not the speed hole
// smuggled back in — a policy that never strides is not throttled by the stride
// cadence, and asking every decision tick is what it takes to make the *cooldown*
// the only rule being broken. The roll's own 5 ticks are the throttle that remains.
export const roller = makePlanner({
  percept: oracle,
  options: { travel: 'roll', strideEvery: 1 },
});

export const POLICIES = Object.freeze({
  expert,
  still,
  random,
  oracle: oraclePolicy,
  reactiveTruth: reactiveTruthPolicy,
  reactiveObs: reactiveObsPolicy,
  camper,
  parker,
  cowerer,
  speeder,
  roller,
});

// The three arms the memory gap is computed from, in ceiling-first order.
export const YARDSTICKS = Object.freeze(['oracle', 'reactiveTruth', 'reactiveObs']);

// The exploit battery, in two families, because they fail for different reasons and
// a fix for one is no evidence about the other:
//
//   REWARD_EXPLOITS — degenerate optima of the *ledger*. Legal play; the question
//     is whether the game is shaped so that standing around beats watching.
//   ACTION_EXPLOITS — holes in the *action space*. These do not out-think the game,
//     they out-run it: they ask the body for something the shipped character can
//     never do, and the ledger has no term that could price it. C4 closes these in
//     the engine rather than the ledger; they stay in the battery as regression
//     bots, and a non-zero climb from either is now a bug in the limiter.
export const REWARD_EXPLOITS = Object.freeze(['camper', 'parker', 'cowerer', 'still']);
export const ACTION_EXPLOITS = Object.freeze(['speeder', 'roller']);
export const EXPLOITS = Object.freeze([...REWARD_EXPLOITS, ...ACTION_EXPLOITS]);

export function policyByName(name) {
  const p = POLICIES[name];
  if (!p) throw new Error(`unknown policy: ${name} (have ${Object.keys(POLICIES).join(', ')})`);
  return p;
}
