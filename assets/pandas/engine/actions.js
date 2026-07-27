// The hat panda's 17-way discrete action interface — the policy seam.
//
// This is change #3 of the Phase-A plan: the sim accepts one discrete action per
// decision tick (10 Hz) for the hat panda, and the shipped rules watcher+dodge is
// wrapped to emit through the *same* interface. Expert and future NN policy become
// plug-swappable, and behaviour-cloning targets are exact by construction (the
// logged action IS what the engine applied).
//
// The 17 actions, as a flat integer:
//   0        HOLD          plant / hold position (glide + gaze only)
//   1..8     STEP + dir    one wander stride (STEP px/axis) along heading dir-1
//   9..16    ROLL + dir    a dive-roll (committed, multi-tick escape) along dir-9
//
// Locomotion + evasion only. Attention (which subject, where to gaze) is NOT in
// the action space — the policy owns *where to be*, and the presentation layer
// owns the gaze flourish (design/panda-policy-net.md, D1 + the map §7).

import { DIRS } from './dirs.js';

export const ACTION = Object.freeze({
  HOLD: 0,
  STEP_BASE: 1, // + dir(0..7) => 1..8
  ROLL_BASE: 9, // + dir(0..7) => 9..16
  COUNT: 17,
});

// Build a STEP / ROLL action for a heading index (0..7).
export const stepAction = (dir) => ACTION.STEP_BASE + dir;
export const rollAction = (dir) => ACTION.ROLL_BASE + dir;

// Classify + decode an action integer.
export const isHold = (a) => a === ACTION.HOLD;
export const isStep = (a) => a >= ACTION.STEP_BASE && a < ACTION.ROLL_BASE;
export const isRoll = (a) => a >= ACTION.ROLL_BASE && a < ACTION.COUNT;
export const stepDirOf = (a) => a - ACTION.STEP_BASE;
export const rollDirOf = (a) => a - ACTION.ROLL_BASE;

// Is `a` a well-formed action index? Guards the policy seam against a NaN /
// out-of-range logit from a future NN (the plan's `?policy=nn` auto-fallback).
export const isValidAction = (a) =>
  Number.isInteger(a) && a >= 0 && a < ACTION.COUNT;

// Names for the 17 actions, indexed by the action itself. Nothing in the sim reads
// these — they exist so a printed action is legible: the corpus manifest's action
// vocabulary, the JSONL sample, and later a policy debug overlay.
export const ACTION_NAME = Object.freeze([
  'hold',
  ...DIRS.map((d) => `step:${d}`),
  ...DIRS.map((d) => `roll:${d}`),
]);

export const actionName = (a) => (isValidAction(a) ? ACTION_NAME[a] : `invalid(${a})`);
