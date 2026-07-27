// The hat panda's per-tick update — the engine side of the policy seam.
//
// Splits cleanly from watcher.js: watcher.js DECIDES (returns a 17-way action),
// this module EXECUTES. That separation is the whole point of the seam — swap the
// decider (rules expert now, a trained net later) and everything here is unchanged.
//
// The hat runs on three modes: OBSERVING (deciding + stepping), ROLLING (a
// committed multi-tick dive-roll with i-frames), and KNOCKED (the shared fall
// cycle, recovering back into observing). A decision is taken at 10 Hz (every
// TICKS_PER_ACTION engine ticks); between decisions the visual position just
// glides, so motion stays smooth at 20 Hz.

import { AX, AY, opposite } from './dirs.js';
import { applyPos, strideTo } from './geometry.js';
import {
  MODE, ANIM, advanceKnock, resetObserveBrain, easeVisual, snapVisual, advanceEntrance,
} from './state.js';
import { ACTION, isRoll, isStep, isValidAction, stepDirOf, rollDirOf } from './actions.js';
import { rulesAction } from './watcher.js';
import { TICKS_PER_ACTION } from './tick.js';

// Advance the hat one tick. `action` is an optional externally-supplied action
// (the trainer / NN driving the seam); when null the built-in rules expert
// decides. Mutates the hat entity in place (it is this step's fresh clone).
export function updateHat(state, cfg, rng, action = null) {
  const hat = state.entities.find((e) => e.hasHat);
  if (!hat) return;

  if (hat.mode === MODE.KNOCKED) {
    if (advanceKnock(hat, cfg)) {
      hat.mode = MODE.OBSERVING;
      hat.anim = ANIM.WALK;
      resetObserveBrain(hat, cfg); // re-hunt a subject from scratch, as the original did
    }
    return;
  }

  if (hat.mode === MODE.ENTERING) {
    // His solo beat: he walks on alone, ahead of the troupe, and starts watching
    // the moment he arrives — there is nothing to watch yet, which is the joke.
    if (advanceEntrance(hat, cfg)) {
      hat.mode = MODE.OBSERVING;
      hat.anim = ANIM.WALK;
      resetObserveBrain(hat, cfg);
    }
    return;
  }

  if (hat.mode === MODE.ROLLING) {
    advanceRoll(hat, cfg); // owns his motion for the roll's ~5 ticks; i-frames on
    return;
  }

  // OBSERVING. Count down the stride cadence every tick so the interval is measured
  // in real engine ticks; the expert reads it and resets it on an observe tick.
  if (hat.moveTimer > 0) hat.moveTimer -= 1;

  if (state.tick % TICKS_PER_ACTION === 0) {
    const a = action != null && isValidAction(action) ? action : rulesAction(state, hat, cfg, rng);
    hat.action = a;
    applyHatAction(state, hat, a, cfg);
  } else {
    easeVisual(hat, cfg); // hold between decisions — glide only
  }
}

// Execute one 17-way action on the hat: hold (plant), step (one stride), or roll
// (begin the committed escape). Pure position/animation mechanics — the brain is
// already updated by rulesAction; a provided action skips that and just moves.
function applyHatAction(state, hat, a, cfg) {
  if (isRoll(a)) {
    startRoll(hat, rollDirOf(a), cfg, state.tick);
    return;
  }
  if (isStep(a)) {
    const dir = stepDirOf(a);
    const land = strideTo(cfg, hat.lx, hat.ly, dir);
    const blocked = land.x === hat.lx && land.y === hat.ly;
    hat.lx = land.x;
    hat.ly = land.y;
    // Weave/sidestep steps are pre-checked in-bounds so never fully block; only a
    // no-subject amble can walk into a wall — then bounce (turn around) for next time.
    hat.dir = blocked ? opposite(dir) : dir;
    hat.anim = ANIM.WALK;
    easeVisual(hat, cfg);
    return;
  }
  // HOLD: relocating-but-boxed still reads as walking; a settled plant is idle.
  hat.anim = hat.relocating ? ANIM.WALK : ANIM.IDLE;
  easeVisual(hat, cfg);
}

// Begin a dive-roll: a committed escape along `dir`. `.stop` semantics (snapVisual)
// kill the glide so the travel is driven tick by tick, and the cooldown is stamped
// at the start. i-frames span the whole roll (the collision pass skips ROLLING).
export function startRoll(hat, dir, cfg, tick) {
  hat.mode = MODE.ROLLING;
  hat.anim = ANIM.ROLL;
  hat.dir = dir;
  hat.aHeading = dir;
  hat.aCount = cfg.rollCels * cfg.rollFrameTicks; // ticks of roll travel
  hat.rollReadyAt = tick + cfg.rollCooldownTicks;
  hat.stopped = true;
  snapVisual(hat);
}

// Advance an in-progress roll one tick: carry rollDist / total-ticks along the
// locked heading, then pop back up into observing when the cels run out.
function advanceRoll(hat, cfg) {
  const total = cfg.rollCels * cfg.rollFrameTicks;
  const per = cfg.rollDist / total;
  const moved = applyPos(cfg, hat.lx, hat.ly, hat.lx + AX[hat.aHeading] * per, hat.ly + AY[hat.aHeading] * per);
  hat.lx = moved.x;
  hat.ly = moved.y;
  snapVisual(hat);
  if (--hat.aCount <= 0) {
    hat.mode = MODE.OBSERVING;
    hat.anim = ANIM.WALK;
    hat.stopped = false; // pops straight up — `.stop` off, the glide resumes
    hat.aCount = 0;
    hat.aHeading = 0;
    hat.moveTimer = 1; // stride again promptly
  }
}
