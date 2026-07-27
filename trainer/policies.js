// The policies the game is scored against.
//
// C1 of design/panda-policy-net.md ships the three that need no information
// discipline at all — the shipped expert, and the two floors it has to beat. C2
// adds the ones the yardstick is actually made of (the privileged oracle, the
// memoryless twin, the exploit bots), which differ from each other ONLY in what
// they are allowed to read; keeping them in one file with one interface is what
// makes that claim checkable rather than rhetorical.
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
import { ACTION } from '../assets/pandas/engine/actions.js';

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

export const POLICIES = Object.freeze({ expert, still, random });

export function policyByName(name) {
  const p = POLICIES[name];
  if (!p) throw new Error(`unknown policy: ${name} (have ${Object.keys(POLICIES).join(', ')})`);
  return p;
}
