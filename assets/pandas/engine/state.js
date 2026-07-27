// Entity model + shared enums for the sim state.
//
// One explicit shape per entity, declared up front (the map flagged the original's
// lazily-first-written `_`-fields as a smell). The mutual-exclusion flags the
// original spread across `anomaly`/`solid`/`riding`/`flying`/`entering` collapse
// into a single integer `mode`; ghost/solid flags remain as booleans because
// collision reads them directly.
//
// Modes and anims are integers (not strings) so `encode()` stays a flat number
// list and determinism breaks are cheap to hash. The presentation layer maps them
// back to sprite rows / CSS classes via the name tables below.

import { Rng } from './rng.js';
import { hypot } from './mathx.js';
import { inBounds, applyPos } from './geometry.js';

// Entity modes. The mutual-exclusion "what drives this panda" tag. Stack/cascade
// modes slot in here in later milestones.
export const MODE = Object.freeze({
  WANDER: 0,
  KNOCKED: 1,
  SLEEPER: 2,
  TUMBLER: 3,
  SPINNER: 4,
  LOOP: 5,
  STARER: 6,
  ZOOMIES: 7,
  MOONWALK: 8,
  HICCUP: 9,
  // The hat panda's two modes (M3). It is never a director candidate, so these
  // never collide with the tier-1 anomaly modes above.
  OBSERVING: 10, // navigating to / holding a vantage, studying a subject
  ROLLING: 11, // mid dive-roll (his one fast escape) — i-frames active
});
export const MODE_NAME = [
  'wander', 'knocked', 'sleeper', 'tumbler', 'spinner',
  'loop', 'starer', 'zoomies', 'moonwalk', 'hiccup',
  'observing', 'rolling',
];

// Sentinel for the watcher's "distance to vantage last stride" when a relocate has
// just begun — a large finite value (not Infinity) so it hashes cleanly in golden
// traces and the first stride always reads as progress.
export const UNSET_GAP = 1e15;

// Animation names — which sprite cel-cycle the presentation plays.
export const ANIM = Object.freeze({
  WALK: 0,
  STOP: 1,
  IDLE: 2,
  FALL: 3,
  FALLEN: 4,
  STAND_UP: 5,
  ROLL: 6,
});
export const ANIM_NAME = ['walk', 'stop', 'idle', 'fall', 'fallen', 'standUp', 'roll'];

// Knock sub-phases.
export const KNOCK = Object.freeze({
  NONE: 0,
  FALL: 1,
  LIE: 2,
  STAND_UP: 3,
});

// Is this panda on the ground (fall / lie / stand-up), from any cause — a knock,
// a nap, a trip, a zoomies crash? Grounded pandas are still obstacles (they knock
// others) but can't themselves be re-knocked, exactly like the original's
// `knocked` guard. Keyed on the animation so every grounded cause is covered.
export function isDown(e) {
  return e.anim === ANIM.FALL || e.anim === ANIM.FALLEN || e.anim === ANIM.STAND_UP;
}

// The glide: the visual position eases toward the logical one (used by wander and
// the glided anomalies — loop, moonwalk, spinner's stagger, hiccup strides).
export function easeVisual(e, cfg) {
  e.x += (e.lx - e.x) * cfg.glideK;
  e.y += (e.ly - e.y) * cfg.glideK;
}

// The snap: `.stop` behaviours (knock slide, tumbler skid, zoomies dash, and any
// grounded phase) kill the glide, so the visual position tracks the logical one
// exactly.
export function snapVisual(e) {
  e.x = e.lx;
  e.y = e.ly;
}

export function makeEntity(id, x, y, opts = {}) {
  return {
    id,
    // Visual position — collision + rendering use this. It eases toward the
    // logical position each tick (the glide).
    x,
    y,
    // Logical position — the stride grid, clamped by bounds/fence. Wander steps
    // this; the visual position chases it.
    lx: x,
    ly: y,
    dir: opts.dir ?? 0,
    anim: opts.hasHat ? ANIM.IDLE : ANIM.WALK,
    mode: MODE.WANDER,

    // Wander cadence.
    moveSpeed: opts.moveSpeed ?? 18,
    moveTimer: opts.moveTimer ?? 1,

    // Knock / recovery.
    knockPhase: KNOCK.NONE,
    knockTimer: 0,
    knockLie: 0, // lie-down duration (ticks), drawn at knock onset
    slideVx: 0,
    slideVy: 0,
    hit: -1, // heading index of the last contact, or -1

    // Anomaly scratch — reused across the 8 tier-1 FSMs (each mode interprets
    // these in its own terms; see anomalies.js).
    aPhase: 0, // sub-phase within the anomaly
    aTimer: 0, // ticks until the next sub-phase event
    aCount: 0, // remaining reps (strides / staggers / hops / flips)
    aHeading: 0, // locked travel heading (zoomies, moonwalk, tumbler skid)
    aLie: 0, // grounded lie duration (ticks), for anomalies that end face-down
    aStep: 0, // in-cycle counter (hiccup strides before a pop)

    // Collision role flags (all false in Milestone 1; wired by later milestones).
    solid: false,
    flying: false,
    riding: false,
    entering: false,

    // Identity / role.
    hasHat: !!opts.hasHat,
    observer: !!opts.hasHat,
    oblivious: !!opts.oblivious,
    home: opts.home ?? null,
    defaultFallDir: opts.defaultFallDir ?? 0,

    // ---- the hat panda's watcher brain (M3) ----
    // Meaningful only for the hat; carried (as defaults) by everyone so the entity
    // shape is uniform and shallow-cloning `{...e}` stays correct. All primitives —
    // no nested object to deep-copy. The picker/policy in watcher.js reads/writes
    // these; encode() serialises them for the hat only.
    subject: -1, // id of the panda being watched, or -1
    td: 0, // current standoff distance to keep
    relocating: false, // walking to a vantage (vs. planted)
    vAxis: 0, // which of the 8 sprite axes he's approaching on
    stuck: 0, // consecutive boxed-in strides with no headway
    revantaged: false, // already tried a fresh approach angle this attempt
    stuckPrev: UNSET_GAP, // gap^2 to the vantage last stride (progress accounting)
    incSubject: -1, // subject id of the incident he's currently holding, or -1
    incBorn: -1, // that incident's born-tick, to re-find it across ticks
    incidentSince: 0, // tick he grabbed the current incident (stickiness window)
    ambientTicks: 0, // dwell countdown on an ambient (no-incident) subject
    rollReadyAt: 0, // tick the dive-roll cooldown expires
    action: 0, // last 17-way action applied (for BC logging + golden traces)
  };
}

// Advance a KNOCKED entity's fall -> lie -> stand-up skid one tick. Returns true
// on the tick recovery completes (the caller decides the post-recovery mode: a
// roamer rejoins the wander, the hat returns to observing). Shared by the engine's
// roamer path and the hat path so the knock physics live in exactly one place.
export function advanceKnock(e, cfg) {
  // The `.stop` class kills the glide, so the visual position tracks the logical
  // one and the knockback slide moves them together across the fall cels.
  if (e.knockPhase === KNOCK.FALL) {
    const nx = e.lx + e.slideVx / cfg.fallTicks;
    const ny = e.ly + e.slideVy / cfg.fallTicks;
    const moved = applyPos(cfg, e.lx, e.ly, nx, ny);
    e.lx = moved.x;
    e.ly = moved.y;
  }
  snapVisual(e);

  if (--e.knockTimer > 0) return false;

  switch (e.knockPhase) {
    case KNOCK.FALL:
      e.knockPhase = KNOCK.LIE;
      e.anim = ANIM.FALLEN;
      e.knockTimer = e.knockLie;
      return false;
    case KNOCK.LIE:
      e.knockPhase = KNOCK.STAND_UP;
      e.anim = ANIM.STAND_UP;
      e.knockTimer = cfg.standTicks;
      return false;
    case KNOCK.STAND_UP:
    default:
      // Recovered — common resets; the caller sets mode + anim.
      e.knockPhase = KNOCK.NONE;
      e.knockTimer = 0;
      e.slideVx = 0;
      e.slideVy = 0;
      e.hit = -1;
      e.moveTimer = 1;
      return true;
  }
}

// Reset the watcher brain to a fresh ambient search — called when the hat enters
// observing (spawn) and after a knock recovery (it re-picks a subject from scratch,
// exactly as the original's knock() -> observe() did). The roll cooldown persists.
export function resetObserveBrain(e, cfg) {
  e.subject = -1;
  e.td = cfg.ambientStandoff;
  e.relocating = true;
  e.vAxis = 0;
  e.stuck = 0;
  e.revantaged = false;
  e.stuckPrev = UNSET_GAP;
  e.incSubject = -1;
  e.incBorn = -1;
  e.incidentSince = 0;
  e.ambientTicks = 0;
  e.moveTimer = 1;
}

// A clear placement, farthest-point style — try `tries` seeded candidates, return
// the first that clears `minSep` from everything placed, else the roomiest seen.
// Deterministic: all randomness comes from the passed Rng.
export function clearSpot(rng, cfg, placed, minSep, tries = 60) {
  const lo = cfg.boundLower + 10;
  const hiX = cfg.width - cfg.boundUpper - 10;
  const hiY = cfg.height - cfg.boundUpper - 10;
  let best = null;
  let bestD = -1;
  for (let i = 0; i < tries; i++) {
    const x = rng.float(lo, hiX);
    const y = rng.float(lo, hiY);
    if (!inBounds(cfg, x, y)) continue;
    let d = Infinity;
    for (const p of placed) d = Math.min(d, hypot(p.x - x, p.y - y));
    if (d === Infinity) return { x, y };
    if (d > bestD) {
      bestD = d;
      best = { x, y };
    }
    if (d >= minSep) return { x, y };
  }
  return best ?? { x: cfg.width / 2, y: cfg.height / 2 };
}

// Placement helper reused by init: build the starting roster. index 0 is the hat
// panda; one roamer (never the hat) is the oblivious one.
export function spawnEntities(rng, cfg) {
  const n = cfg.pandaCount;
  const obliviousAt = n > 1 ? 1 + rng.int(n - 1) : -1;
  const entities = [];
  for (let i = 0; i < n; i++) {
    const hasHat = i === 0;
    const oblivious = i === obliviousAt;
    const spot = clearSpot(rng, cfg, entities, 90);
    const moveSpeed = hasHat ? cfg.hatMove : rng.pick(cfg.moveSpeeds);
    const e = makeEntity(i, Math.round(spot.x), Math.round(spot.y), {
      hasHat,
      oblivious,
      moveSpeed,
      dir: rng.int(7), // original quirk: initial facing is 0..6, not 0..7
      defaultFallDir: rng.int(8),
    });
    if (oblivious) e.home = [e.x, e.y];
    e.moveTimer = rng.intBetween(1, moveSpeed); // stagger first strides
    if (hasHat) {
      // The hat panda starts in its watcher loop, hunting an ambient subject.
      e.mode = MODE.OBSERVING;
      resetObserveBrain(e, cfg);
    }
    entities.push(e);
  }
  return entities;
}
