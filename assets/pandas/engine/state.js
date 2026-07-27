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
import { inBounds, inForbid, applyPos } from './geometry.js';

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
  // The tier-2 stack's three roles (M4). All three are driven by stack.js, not by
  // the per-entity update, and all three are collision-special (see the flags).
  STACK_BASE: 12, // the bottom panda: `solid`, carries the tower
  MOUNTING: 13, // climbing: walking up to the base, then mid-hop (`flying` ghost)
  RIDING: 14, // seated above the base, pinned (`riding` ghost)
  // The entrance: walking on from off-stage, not yet part of the field. A ghost
  // (`entering`), excluded from every director's pool, and — uniquely — moving
  // with the bounds/fence clamp bypassed, since its whole corridor starts outside
  // the stage. Cleared for good on arrival; nothing ever re-enters.
  ENTERING: 15,
});
export const MODE_NAME = [
  'wander', 'knocked', 'sleeper', 'tumbler', 'spinner',
  'loop', 'starer', 'zoomies', 'moonwalk', 'hiccup',
  'observing', 'rolling', 'stackBase', 'mounting', 'riding', 'entering',
];

// Sentinel for the watcher's "distance to vantage last stride" when a relocate has
// just begun — a large finite value (not Infinity) so it hashes cleanly in golden
// traces and the first stride always reads as progress.
export const UNSET_GAP = 1e15;

// A subject that is a fixed point on the stage rather than a panda. The tier-3
// cascade posts one at the origin of the carnage (the original passed a bare
// `{x, y}` where every other incident passed a panda) — the watcher scrambles to
// the spot and stands among the bodies, because there is no one body to blame.
// Entity ids are >= 0, so a negative sentinel can never collide with one.
export const POINT_SUBJECT = -2;

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
//
// This is a port of a CSS transition, so it behaves like one. The browser starts a
// fresh `transition: transform 2s` every time the transform is written, animating
// from wherever the element currently *is* to the new value on the `ease` curve —
// and the original only writes the transform when the logical position changes.
// So a stride does not adjust a running chase; it REPLACES it, from here, with a
// full curve. That restart is why the walk reads as steps rather than a slide, and
// why a turn commits at once instead of coasting through the old heading.
//
// `gtx/gty` is the target the running transition was aimed at — comparing it to the
// logical position is how a write is detected without every mover having to
// announce one, exactly as the browser detects a changed computed value.
export function easeVisual(e, cfg) {
  if (e.lx !== e.gtx || e.ly !== e.gty) {
    e.g0x = e.x;
    e.g0y = e.y;
    e.gtx = e.lx;
    e.gty = e.ly;
    e.gT = 0;
  }
  if (e.gT >= cfg.glideTicks) return; // arrived; the transition has finished
  e.gT += 1;
  const p = cfg.glideCurve[e.gT];
  e.x = e.g0x + (e.gtx - e.g0x) * p;
  e.y = e.g0y + (e.gty - e.g0y) * p;
}

// The snap: `.stop` behaviours (knock slide, tumbler skid, zoomies dash, and any
// grounded phase) kill the glide, so the visual position tracks the logical one
// exactly. Any running transition is discarded with it — when `.stop` comes off,
// the next stride starts a new one from where the panda is standing.
export function snapVisual(e) {
  e.x = e.lx;
  e.y = e.ly;
  e.g0x = e.lx;
  e.g0y = e.ly;
  e.gtx = e.lx;
  e.gty = e.ly;
  e.gT = 0;
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
    // The running glide — the state of one CSS transition: where it started
    // (`g0`), what it is aimed at (`gt`), and how many ticks of its duration have
    // elapsed (`gT`). See easeVisual.
    g0x: x,
    g0y: y,
    gtx: x,
    gty: y,
    gT: 0,
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
    // True while this fall belongs to a cascade front (a steered domino rather than
    // an ordinary shove). It is what releases the panda's cascade claim on standing.
    cascadeFall: false,

    // Anomaly scratch — reused across the 8 tier-1 FSMs (each mode interprets
    // these in its own terms; see anomalies.js).
    aPhase: 0, // sub-phase within the anomaly
    aTimer: 0, // ticks until the next sub-phase event
    aCount: 0, // remaining reps (strides / staggers / hops / flips)
    aHeading: 0, // locked travel heading (zoomies, moonwalk, tumbler skid)
    aLie: 0, // grounded lie duration (ticks), for anomalies that end face-down
    aStep: 0, // in-cycle counter (hiccup strides before a pop)

    // Collision role flags. `solid` = an unstoppable force (the stack's base: knocks
    // non-solids, is never knocked, passes through other solids); `flying` = mid-arc;
    // `riding` = pinned above a base; `entering` = still walking in. The last three
    // are collision ghosts. Set/cleared by stack.js (M4).
    solid: false,
    flying: false,
    riding: false,
    entering: false,
    // Which tier of the tower this panda is: 0 = not a rider, 1 = first rider up, 2 =
    // the one above it. Drives seat height + the sway phase offset (presentation).
    stackLevel: 0,

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
    subject: -1, // id of the panda being watched, POINT_SUBJECT for a spot, or -1
    subjPx: 0, // that spot's coordinates — meaningful only when subject is POINT_SUBJECT
    subjPy: 0,
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

// Begin a knock: face the impact, drop into the fall phase, and carry a knockback
// slide across the fall cels. Lie time is drawn now, at onset. The one entry point
// for going down involuntarily — an ordinary collision (engine.js, slide = IMPACT px
// away from the struck side) and a cascade domino (cascade.js, slide = the steered
// gap to the next victim) differ only in the vector they hand in. A knock outranks
// any anomaly, so the FSM scratch is cleared.
export function beginKnock(e, cfg, rng, { faceDir, slideVx, slideVy, cascade = false }) {
  e.aPhase = 0;
  e.aTimer = 0;
  e.aCount = 0;
  e.aHeading = 0;
  e.aLie = 0;
  e.aStep = 0;
  e.mode = MODE.KNOCKED;
  e.knockPhase = KNOCK.FALL;
  e.knockTimer = cfg.fallTicks;
  e.knockLie = cfg.lieTimesTicks[rng.int(cfg.lieTimesTicks.length)];
  e.hit = faceDir;
  e.dir = faceDir; // faces the impact
  e.anim = ANIM.FALL;
  e.cascadeFall = cascade;
  // The slide starts from where the panda visually is; logical snaps to it.
  e.lx = e.x;
  e.ly = e.y;
  e.slideVx = slideVx;
  e.slideVy = slideVy;
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
  e.subjPx = 0;
  e.subjPy = 0;
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

// An off-stage start and the inward target it walks to, on a random edge whose
// lane is clear of the hero card. Entry runs perpendicular to the edge, so the
// straight transit never crosses the centred card. Falls back to an ordinary clear
// spot (i.e. simply appearing) if 40 tries can't find a lane — the original's
// behaviour, and only reachable on a stage the card nearly fills.
function pickEntry(rng, cfg, placed) {
  const off = cfg.entranceOff;
  const inset = cfg.entranceTargetIn;
  const w = cfg.width;
  const h = cfg.height;
  for (let i = 0; i < cfg.entranceTries; i++) {
    switch (rng.int(4)) {
      case 0: { // from the left, walking right
        const y = rng.float(0, Math.max(1, h - cfg.cell));
        const t = { x: inset, y };
        if (!inForbid(cfg.forbid, cfg.foot, cfg.cell, t.x, t.y)) return { sx: -off, sy: y, dir: 2, ...t };
        break;
      }
      case 1: { // from the right, walking left
        const y = rng.float(0, Math.max(1, h - cfg.cell));
        const t = { x: w - cfg.cell - inset, y };
        if (!inForbid(cfg.forbid, cfg.foot, cfg.cell, t.x, t.y)) return { sx: w + off - cfg.cell, sy: y, dir: 6, ...t };
        break;
      }
      case 2: { // from the top, walking down
        const x = rng.float(0, Math.max(1, w - cfg.cell));
        const t = { x, y: inset };
        if (!inForbid(cfg.forbid, cfg.foot, cfg.cell, t.x, t.y)) return { sx: x, sy: -off, dir: 4, ...t };
        break;
      }
      default: { // from the bottom, walking up
        const x = rng.float(0, Math.max(1, w - cfg.cell));
        const t = { x, y: h - cfg.cell - inset };
        if (!inForbid(cfg.forbid, cfg.foot, cfg.cell, t.x, t.y)) return { sx: x, sy: h + off - cfg.cell, dir: 0, ...t };
        break;
      }
    }
  }
  const spot = clearSpot(rng, cfg, placed, 90);
  return { sx: spot.x, sy: spot.y, dir: rng.int(8), x: spot.x, y: spot.y };
}

// Placement helper reused by init: build the starting roster. index 0 is the hat
// panda; one roamer (never the hat) is the oblivious one.
//
// With `cfg.entrance` the troupe starts off-stage and walks on — the hat panda
// alone first, then waves of `entranceWaveSize`. Everyone's arrival target doubles
// as their `home` (the oblivious one's patch is where it walked in to), exactly as
// the original had it. Without it, everyone simply starts at a clear spot.
export function spawnEntities(rng, cfg) {
  const n = cfg.pandaCount;
  const obliviousAt = n > 1 ? 1 + rng.int(n - 1) : -1;
  const entities = [];
  for (let i = 0; i < n; i++) {
    const hasHat = i === 0;
    const oblivious = i === obliviousAt;
    const moveSpeed = hasHat ? cfg.hatMove : rng.pick(cfg.moveSpeeds);
    const entry = cfg.entrance ? pickEntry(rng, cfg, entities) : null;
    const spot = entry ?? clearSpot(rng, cfg, entities, 90);
    const e = makeEntity(i, Math.round(entry ? entry.sx : spot.x), Math.round(entry ? entry.sy : spot.y), {
      hasHat,
      oblivious,
      moveSpeed,
      dir: entry ? entry.dir : rng.int(7), // original quirk: initial facing is 0..6, not 0..7
      defaultFallDir: rng.int(8),
    });
    if (entry) {
      // Walking on: park off-stage until this panda's wave is due, then stride to
      // the target. `home` carries the target, which is also the oblivious one's
      // patch once it arrives.
      e.mode = MODE.ENTERING;
      e.entering = true;
      e.anim = ANIM.WALK;
      e.home = [Math.round(entry.x), Math.round(entry.y)];
      e.aTimer = hasHat ? 0 : cfg.entranceLead + Math.floor((i - 1) / cfg.entranceWaveSize) * cfg.entranceWaveGap;
      e.moveTimer = 1;
    } else {
      if (oblivious) e.home = [e.x, e.y];
      e.moveTimer = rng.intBetween(1, moveSpeed); // stagger first strides
      if (hasHat) {
        // The hat panda starts in its watcher loop, hunting an ambient subject.
        e.mode = MODE.OBSERVING;
        resetObserveBrain(e, cfg);
      }
    }
    entities.push(e);
  }
  return entities;
}

// One tick of the walk-in: hold off-stage until this panda's wave is due, then
// stride toward the target at its own cadence. Movement here is UNCLAMPED — the
// corridor begins outside the stage, so the usual bounds/fence check would refuse
// the first step. Returns true on the tick it arrives; the caller decides what the
// panda becomes (a roamer, or the watcher).
export function advanceEntrance(e, cfg) {
  if (e.aTimer > 0) {
    e.aTimer -= 1;
    snapVisual(e); // parked off-stage, not drifting
    return false;
  }
  if (--e.moveTimer > 0) {
    easeVisual(e, cfg); // between strides — the glide, as for any other walk
    return false;
  }
  e.moveTimer = e.moveSpeed;

  const dx = e.home[0] - e.lx;
  const dy = e.home[1] - e.ly;
  if (Math.abs(dx) <= cfg.step && Math.abs(dy) <= cfg.step) {
    e.lx = e.home[0];
    e.ly = e.home[1];
    e.entering = false;
    e.aTimer = 0;
    e.moveTimer = 1;
    easeVisual(e, cfg);
    return true;
  }
  e.lx += dx > cfg.step ? cfg.step : dx < -cfg.step ? -cfg.step : 0;
  e.ly += dy > cfg.step ? cfg.step : dy < -cfg.step ? -cfg.step : 0;
  easeVisual(e, cfg);
  return false;
}
