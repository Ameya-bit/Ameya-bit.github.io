// The 8 tier-1 anomalies, as explicit per-tick FSMs.
//
// Ported from pandas.js's continuation-passing (setTimeout) implementations
// (map §5). Each anomaly is an entity `mode`; its progress lives in the shared
// aPhase/aTimer/aCount/aHeading/aLie/aStep scratch fields. `startAnomaly` sets a
// panda going and returns the incident TTL; `updateAnomaly` advances it one tick
// and flips the panda back to WANDER (via `endAnomaly`) when it finishes.
//
// The "grounded" tail (fall → lie → stand-up) is shared by the anomalies that end
// face-down (sleeper, tumbler, a crashed zoomies), reusing the same fall/stand
// durations as a collision knock.

import { MODE, ANIM, easeVisual, snapVisual } from './state.js';
import { DX, DY, AX, AY, wrapDir } from './dirs.js';
import { applyPos } from './geometry.js';

// The tier-1 kinds, in the original ANOMALIES order. The director indexes into
// this; index → mode via KIND_MODE.
export const ANOMALY_KINDS = [
  'sleeper', 'tumbler', 'spinner', 'loop', 'starer', 'zoomies', 'moonwalk', 'hiccup',
];
const KIND_MODE = [
  MODE.SLEEPER, MODE.TUMBLER, MODE.SPINNER, MODE.LOOP,
  MODE.STARER, MODE.ZOOMIES, MODE.MOONWALK, MODE.HICCUP,
];

// Sub-phase constants (distinct across all modes so a phase check never needs the
// mode). Grounded phases are shared.
const G_FALL = 10;
const G_LIE = 11;
const G_STAND = 12;
const T_SKID = 1;
const SP_SPIN = 2;
const SP_STAGGER = 3;
const Z_DASH = 4;
const H_STRIDE = 5;
const H_POP = 6;

// ---- helpers ----

function resetScratch(e) {
  e.aPhase = 0;
  e.aTimer = 0;
  e.aCount = 0;
  e.aHeading = 0;
  e.aLie = 0;
  e.aStep = 0;
}

// Return to ordinary wandering. Used both when an anomaly finishes and by a
// collision knock overriding an anomaly (via startKnock's reset).
export function endAnomaly(e) {
  e.mode = MODE.WANDER;
  e.anim = ANIM.WALK;
  e.hit = -1;
  resetScratch(e);
  e.moveTimer = 1; // stride again promptly
}

// Drop into the grounded tail with a given lie duration.
function enterGrounded(e, lieTicks, cfg) {
  e.aPhase = G_FALL;
  e.anim = ANIM.FALL;
  e.aTimer = cfg.fallTicks;
  e.aLie = lieTicks;
  snapVisual(e);
}

function advanceGrounded(e, cfg) {
  snapVisual(e);
  if (--e.aTimer > 0) return;
  if (e.aPhase === G_FALL) {
    e.aPhase = G_LIE;
    e.anim = ANIM.FALLEN;
    e.aTimer = e.aLie;
  } else if (e.aPhase === G_LIE) {
    e.aPhase = G_STAND;
    e.anim = ANIM.STAND_UP;
    e.aTimer = cfg.standTicks;
  } else {
    endAnomaly(e);
  }
}

// Step the LOGICAL position one full stride (STEP px/axis) along heading `dir`.
// Returns true if it actually moved (false = blocked by wall/fence).
function strideLogical(e, dir, cfg) {
  const candX = e.lx + DX[dir] * cfg.step;
  const candY = e.ly + DY[dir] * cfg.step;
  const moved = applyPos(cfg, e.lx, e.ly, candX, candY);
  const did = moved.x !== e.lx || moved.y !== e.ly;
  e.lx = moved.x;
  e.ly = moved.y;
  return did;
}

// ---- start ----

// Begin `kindIdx` on entity `e`. Mutates `e`. Returns the incident TTL (ticks).
export function startAnomaly(e, kindIdx, cfg, rng) {
  resetScratch(e);
  e.mode = KIND_MODE[kindIdx];
  const linger = cfg.aftermathLinger;

  switch (e.mode) {
    case MODE.SLEEPER: {
      const nap = rng.intBetween(cfg.sleepMin, cfg.sleepMax);
      enterGrounded(e, nap, cfg);
      return cfg.fallTicks + nap + cfg.standTicks + linger;
    }
    case MODE.TUMBLER: {
      e.aPhase = T_SKID;
      e.aTimer = cfg.tripEvery;
      e.aCount = cfg.tripSkids;
      e.aHeading = e.dir; // skid along the current heading
      e.anim = ANIM.STOP; // hold one cel; the facing-flips are the motion
      return cfg.tripSkids * cfg.tripEvery + cfg.fallTicks + cfg.tripDownTicks + cfg.standTicks + linger;
    }
    case MODE.SPINNER: {
      e.aPhase = SP_SPIN;
      e.aTimer = cfg.spinEvery;
      e.aCount = cfg.spinFlips;
      e.anim = ANIM.STOP;
      return cfg.spinFlips * cfg.spinEvery + cfg.staggerMax * cfg.staggerEvery + linger;
    }
    case MODE.LOOP: {
      const laps = rng.intBetween(cfg.loopLapsMin, cfg.loopLapsMax);
      e.aCount = laps * 8;
      e.aTimer = cfg.loopEvery;
      e.anim = ANIM.WALK;
      return e.aCount * cfg.loopEvery + linger;
    }
    case MODE.STARER: {
      e.dir = nearestEdgeDir(e, cfg);
      e.anim = ANIM.IDLE; // the settled stare
      e.aTimer = rng.intBetween(cfg.stareMin, cfg.stareMax);
      return e.aTimer + linger;
    }
    case MODE.ZOOMIES: {
      e.dir = rng.int(8);
      e.aHeading = e.dir;
      e.aPhase = Z_DASH;
      e.aTimer = cfg.zoomEvery;
      e.aCount = cfg.zoomFuseTicks;
      e.anim = ANIM.WALK;
      return cfg.zoomFuseTicks * cfg.zoomEvery + cfg.fallTicks + cfg.zoomTumbleTicks + cfg.standTicks + linger;
    }
    case MODE.MOONWALK: {
      const travel = rng.int(8);
      e.aHeading = travel;
      e.dir = wrapDir(travel + 4); // face the opposite way
      e.aCount = rng.intBetween(cfg.moonStepsMin, cfg.moonStepsMax);
      e.aTimer = cfg.moonEvery;
      e.anim = ANIM.WALK;
      return e.aCount * cfg.moonEvery + linger;
    }
    case MODE.HICCUP: {
      e.aCount = rng.intBetween(cfg.hiccupMin, cfg.hiccupMax);
      e.aPhase = H_STRIDE;
      e.aStep = 0;
      e.aTimer = cfg.hiccupStrideEvery;
      e.anim = ANIM.WALK;
      return e.aCount * (2 * cfg.hiccupStrideEvery + cfg.hiccupHopTicks) + linger;
    }
    default:
      return linger;
  }
}

// Face whichever stage edge is nearest the body centre.
function nearestEdgeDir(e, cfg) {
  const cx = e.x + cfg.cell / 2;
  const cy = e.y + cfg.cell / 2;
  const dl = cx;
  const dr = cfg.width - cx;
  const dt = cy;
  const db = cfg.height - cy;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return 6; // left
  if (m === dr) return 2; // right
  if (m === dt) return 0; // up
  return 4; // down
}

// ---- update (dispatch by mode) ----

export function updateAnomaly(e, cfg, rng) {
  switch (e.mode) {
    case MODE.SLEEPER:
      advanceGrounded(e, cfg);
      break;
    case MODE.TUMBLER:
      e.aPhase === T_SKID ? tumblerSkid(e, cfg) : advanceGrounded(e, cfg);
      break;
    case MODE.SPINNER:
      e.aPhase === SP_SPIN ? spinnerSpin(e, cfg, rng) : spinnerStagger(e, cfg, rng);
      break;
    case MODE.LOOP:
      loopStep(e, cfg);
      break;
    case MODE.STARER:
      starerHold(e, cfg);
      break;
    case MODE.ZOOMIES:
      e.aPhase === Z_DASH ? zoomiesDash(e, cfg) : advanceGrounded(e, cfg);
      break;
    case MODE.MOONWALK:
      moonwalkStep(e, cfg);
      break;
    case MODE.HICCUP:
      e.aPhase === H_STRIDE ? hiccupStride(e, cfg, rng) : hiccupPop(e, cfg);
      break;
    default:
      break;
  }
}

function tumblerSkid(e, cfg) {
  snapVisual(e);
  if (--e.aTimer > 0) return;
  e.aTimer = cfg.tripEvery;
  if (e.aCount-- <= 0) {
    enterGrounded(e, cfg.tripDownTicks, cfg);
    return;
  }
  e.dir = wrapDir(e.dir + 1); // quick facing flips
  const nx = e.lx + AX[e.aHeading] * (cfg.tripSlide / cfg.tripSkids);
  const ny = e.ly + AY[e.aHeading] * (cfg.tripSlide / cfg.tripSkids);
  const moved = applyPos(cfg, e.lx, e.ly, nx, ny);
  e.lx = moved.x;
  e.ly = moved.y;
  snapVisual(e);
}

function spinnerSpin(e, cfg, rng) {
  snapVisual(e); // planted, cycling facings
  if (--e.aTimer > 0) return;
  e.aTimer = cfg.spinEvery;
  e.dir = wrapDir(e.dir + 1);
  if (--e.aCount <= 0) {
    // spin done → stagger a couple of steps and walk on
    e.aPhase = SP_STAGGER;
    e.anim = ANIM.WALK;
    e.aCount = rng.intBetween(cfg.staggerMin, cfg.staggerMax);
    e.aTimer = cfg.staggerEvery;
  }
}

function spinnerStagger(e, cfg, rng) {
  if (--e.aTimer > 0) {
    easeVisual(e, cfg);
    return;
  }
  e.aTimer = cfg.staggerEvery;
  if (e.aCount-- <= 0) {
    endAnomaly(e);
    return;
  }
  e.dir = rng.int(8);
  strideLogical(e, e.dir, cfg);
  easeVisual(e, cfg);
}

function loopStep(e, cfg) {
  if (--e.aTimer > 0) {
    easeVisual(e, cfg);
    return;
  }
  e.aTimer = cfg.loopEvery;
  if (e.aCount-- <= 0) {
    endAnomaly(e);
    return;
  }
  e.dir = wrapDir(e.dir + 1); // +1 each stride closes the octagon
  strideLogical(e, e.dir, cfg);
  easeVisual(e, cfg);
}

function starerHold(e, cfg) {
  snapVisual(e); // planted, facing an edge
  if (--e.aTimer <= 0) endAnomaly(e);
}

function zoomiesDash(e, cfg) {
  if (--e.aTimer > 0) {
    snapVisual(e);
    return;
  }
  e.aTimer = cfg.zoomEvery;
  if (e.aCount-- <= 0) {
    endAnomaly(e); // fuse — never found a wall, just stop
    return;
  }
  const nx = e.lx + AX[e.aHeading] * cfg.zoomIncr;
  const ny = e.ly + AY[e.aHeading] * cfg.zoomIncr;
  const bx = e.lx;
  const by = e.ly;
  const moved = applyPos(cfg, e.lx, e.ly, nx, ny);
  e.lx = moved.x;
  e.ly = moved.y;
  if (moved.x === bx && moved.y === by) {
    enterGrounded(e, cfg.zoomTumbleTicks, cfg); // wall dead ahead → crash and tumble
    return;
  }
  snapVisual(e);
}

function moonwalkStep(e, cfg) {
  if (--e.aTimer > 0) {
    easeVisual(e, cfg);
    return;
  }
  e.aTimer = cfg.moonEvery;
  if (e.aCount-- <= 0) {
    endAnomaly(e);
    return;
  }
  const did = strideLogical(e, e.aHeading, cfg); // travel one way, keep facing the other
  if (!did) {
    endAnomaly(e); // backed into a wall — snaps out
    return;
  }
  easeVisual(e, cfg);
}

function hiccupStride(e, cfg, rng) {
  if (--e.aTimer > 0) {
    easeVisual(e, cfg);
    return;
  }
  e.aTimer = cfg.hiccupStrideEvery;
  if (e.aStep >= 2) {
    // two strides done → the pop
    e.aPhase = H_POP;
    e.aTimer = cfg.hiccupHopTicks;
    easeVisual(e, cfg);
    return;
  }
  e.aStep++;
  if (rng.chance(cfg.hiccupWanderP)) e.dir = rng.int(8); // a gentle wander, not a metronome
  strideLogical(e, e.dir, cfg);
  easeVisual(e, cfg);
}

// How high off the ground a hiccupping panda is drawn right now (px, 0 when it is
// not mid-pop). The pop moves nothing in the sim — it is a pocket parabola over
// `hiccupHopTicks`, peaking at `hiccupRise` — but the phase and its clock ARE
// state, so the renderer reads the height from here rather than inventing its own
// hop (the same arrangement as stack.js's `riderSway`).
export function hiccupLift(e, cfg) {
  if (e.mode !== MODE.HICCUP || e.aPhase !== H_POP) return 0;
  const k = 1 - e.aTimer / cfg.hiccupHopTicks; // 0 at take-off, 1 at landing
  return cfg.hiccupRise * 4 * k * (1 - k);
}

function hiccupPop(e, cfg) {
  easeVisual(e, cfg); // the vertical hop is a presentation flourish; no horizontal move
  if (--e.aTimer > 0) return;
  if (--e.aCount <= 0) {
    endAnomaly(e);
    return;
  }
  e.aPhase = H_STRIDE;
  e.aStep = 0;
  e.aTimer = cfg.hiccupStrideEvery;
}
