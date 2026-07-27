// Tier 2: the stack — a tower parading as one entity, until it isn't.
//
// The bottom panda is the only real actor: it wanders as an unstoppable `solid`
// (knocks roamers aside, never knocked). The riders are ghosts pinned above it,
// holding a seated pose with a sway that *grows* the longer it parades, foreshadowing
// the fall. It topples when the parade clock runs out — or when something kinetic
// strikes it (a zoomies runaway into the tower is a gift). A topple drops the riders
// onto the base so all three hitboxes overlap and lets the ordinary collision logic
// knock the pile apart: three pandas fall and scatter, each recovering on its own.
//
// A topple is a self-contained payoff, NOT a cascade — *unless* the tier-3 director
// is armed, in which case it serves as the ignition (map §5, tier 2; the coupling
// rule). Rarity stays pinned to the arming clock.
//
// The port: the original's nested `setTimeout` assembly (walk → throwArc → next
// mounter → parade) becomes one explicit phase machine on `state.stack`, advanced a
// tick at a time. Riders mount as `flying` ghosts and the base is `solid` from the
// first frame, so the tower can't be jostled apart while forming.

import { AX, AY, wrapDir, opposite, headingDir, dirIndex } from './dirs.js';
import { applyPos } from './geometry.js';
import { MODE, ANIM, easeVisual, snapVisual } from './state.js';
import { emitIncident, isFreeRoamer } from './director.js';
import { igniteCascade, claimed } from './cascade.js';
import { sin, hypot, clamp, round, min, max, PI } from './mathx.js';

// Assembly phases. MOUNT = the current climber is walking up; FLIGHT = it is mid-hop;
// PARADE = the finished tower is on the move.
export const PHASE = Object.freeze({ MOUNT: 0, FLIGHT: 1, PARADE: 2 });

export function initStack(cfg) {
  return {
    nextAt: cfg.stackKick, // the director clock: one tower forms this often
    baseId: -1, // -1 = no tower alive (at most one, ever)
    phase: PHASE.MOUNT,
    mounters: [], // ids still to climb, nearest-first
    mountIdx: 0, // which of them is climbing right now
    riders: [], // ids already seated, bottom-first
    timer: 0, // ticks to the climber's next walk-up stride
    steps: 0, // …and how many it has spent (mountMaxSteps forces the hop)
    flight: 0, // ticks into the current hop
    flightDir0: 0, // the climber's facing at launch (it tumbles from there)
    fx0: 0, // the hop's start and landing, and its arc height
    fy0: 0,
    fx1: 0,
    fy1: 0,
    peak: 0,
    born: 0, // the tick the parade began…
    life: 0, // …and how long it lasts before the wobble maxes out
    baseDir: 0, // the tower's heading (drives the riders' facing too)
    incBorn: -1, // the tier-2 incident's born tick, to shorten it on topple
  };
}

const byId = (state, id) => state.entities.find((e) => e.id === id);

// A rider's teeter at `tick`, in [-1, 1]. A pure function of the tick count and the
// tier — never the wall clock, which is what let the original's `performance.now()`
// sway survive the refactor. The engine uses it to shift the seats (that is state);
// the presentation layer multiplies it by `sitTiltDeg` for the visible tilt, so both
// read the same wobble.
export const riderSway = (tick, level, cfg) =>
  sin((tick * 2 * PI) / cfg.sitWobbleTicks - level * 0.9);

// Advance tier 2 one tick: the director clock, then the live tower (if any).
// The reschedule gap is drawn before the recruitment picks — see the draw-order note
// on `runDirector` in director.js for why that differs from the original and why it
// costs nothing.
export function runStack(state, cfg, rng) {
  const s = state.stack;
  if (state.tick >= s.nextAt) {
    s.nextAt = state.tick + rng.intBetween(cfg.stackGapMin, cfg.stackGapMax);
    if (s.baseId < 0) formStack(state, cfg, rng); // at most one alive
  }
  if (s.baseId >= 0) advanceTower(state, cfg, rng);
}

// ---- the director: recruit a base and its riders ----

function formStack(state, cfg, rng) {
  // A panda a cascade front has already claimed is still WANDER (its steered fall is
  // a few ticks out), so it reads as free. Recruiting it would put a rider mid-air
  // when that fall lands — leave claimed pandas to tier 3.
  const pool = state.entities.filter((e) => isFreeRoamer(e) && !claimed(state, e.id));
  if (pool.length < 3) return; // a base + 1-2 riders, and leave a field behind
  // The base needs headroom overhead for a 3-high tower (y grows downward).
  const bases = pool.filter((e) => e.ly >= 2 * cfg.riderRise + 20);
  if (!bases.length) return;

  const base = rng.pick(bases);
  const nRiders = rng.chance(cfg.stackRiders2P) ? 2 : 1; // 3-high or 2-high
  const d2 = (e) => (e.lx - base.lx) ** 2 + (e.ly - base.ly) ** 2;
  const mounters = pool
    .filter((e) => e.id !== base.id)
    .sort((a, b) => d2(a) - d2(b)) // the nearest join — short, snappy walk-ups
    .slice(0, nRiders);

  base.mode = MODE.STACK_BASE;
  base.solid = true; // unstoppable + never knocked, from the first frame
  base.anim = ANIM.IDLE; // hold still during assembly
  base.moveTimer = 0;

  const s = state.stack;
  s.baseId = base.id;
  s.mounters = mounters.map((m) => m.id);
  s.riders = [];
  s.mountIdx = -1; // beginMount steps this to 0
  s.incBorn = state.tick;
  // One long-lived tier-2 incident on the base from the outset — it outranks every
  // tier-1, so the watcher comes to study the tower forming and swaying.
  emitIncident(state, base.id, 2, cfg.stackIncidentTtl);
  beginMount(state, cfg, rng);
}

// ---- assembly ----

function beginMount(state, cfg, rng) {
  const s = state.stack;
  s.mountIdx += 1;
  if (s.mountIdx >= s.mounters.length) {
    beginParade(state, cfg, rng);
    return;
  }
  const m = byId(state, s.mounters[s.mountIdx]);
  m.mode = MODE.MOUNTING;
  m.flying = true; // ghost through the field on the way up
  m.anim = ANIM.WALK;
  m.moveTimer = 0;
  s.phase = PHASE.MOUNT;
  s.timer = cfg.mountWalkEvery;
  s.steps = 0;
  s.flight = 0;
}

// One walk-up stride toward the base, or the hop if close enough (or out of patience).
function mountWalk(state, base, m, cfg) {
  const s = state.stack;
  if (--s.timer > 0) {
    easeVisual(m, cfg);
    return;
  }
  s.timer = cfg.mountWalkEvery;

  const dx = base.lx - m.lx;
  const dy = base.ly + 20 - m.ly;
  if (hypot(dx, dy) <= cfg.mountNear || ++s.steps > cfg.mountMaxSteps) {
    beginHop(state, base, m, cfg);
    return;
  }
  const d = headingDir(dx, dy);
  if (d >= 0) m.dir = d;
  const moved = applyPos(
    cfg,
    m.lx,
    m.ly,
    m.lx + clamp(dx, -cfg.step, cfg.step),
    m.ly + clamp(dy, -cfg.step, cfg.step),
  );
  m.lx = moved.x;
  m.ly = moved.y;
  easeVisual(m, cfg);
}

// Launch the parabolic hop onto the head above the last rider.
function beginHop(state, base, m, cfg) {
  const s = state.stack;
  const level = s.mountIdx + 1;
  s.fx0 = m.lx;
  s.fy0 = m.ly;
  s.fx1 = base.lx;
  s.fy1 = base.ly - level * cfg.riderRise;
  const dist = hypot(s.fx1 - s.fx0, s.fy1 - s.fy0);
  s.peak = min(cfg.mountArcPeakMax, cfg.mountArcPeakBase + dist * cfg.mountArcPeakPerPx);
  s.flightDir0 = m.dir;
  s.flight = 0;
  s.phase = PHASE.FLIGHT;
}

// One tick of flight: travel the chord linearly, ride the parabola visually, tumble
// through ~2 full turns of facing, then seat the rider.
function advanceHop(state, base, m, cfg, rng) {
  const s = state.stack;
  s.flight += 1;
  const k = min(1, s.flight / cfg.mountHopTicks);
  m.lx = s.fx0 + (s.fx1 - s.fx0) * k;
  m.ly = s.fy0 + (s.fy1 - s.fy0) * k;
  m.x = m.lx;
  m.y = m.ly - s.peak * 4 * k * (1 - k); // arc height: 0 at both ends, peak at k=0.5
  m.dir = wrapDir(s.flightDir0 + round(k * 16));
  if (k < 1) return;

  // Landed: `flying` clears, and it becomes a pinned ghost instead.
  m.flying = false;
  m.riding = true;
  m.mode = MODE.RIDING;
  m.anim = ANIM.IDLE;
  m.dir = dirIndex('down'); // the parade re-faces it to the tower's heading
  m.stackLevel = s.mountIdx + 1;
  m.lx = s.fx1;
  m.ly = s.fy1;
  snapVisual(m);
  s.riders.push(m.id);
  beginMount(state, cfg, rng);
}

// ---- the parade ----

function beginParade(state, cfg, rng) {
  const s = state.stack;
  const base = byId(state, s.baseId);
  s.phase = PHASE.PARADE;
  base.anim = ANIM.WALK;
  snapVisual(base); // driven tick-by-tick (no glide) so the riders track it exactly
  s.born = state.tick;
  s.life = rng.intBetween(cfg.paradeMin, cfg.paradeMax);
  s.baseDir = rng.int(8);
}

// A runaway ploughs into the tower → bring it down early.
function struck(state, base, cfg) {
  const r2 = cfg.toppleHitR ** 2;
  for (const q of state.entities) {
    if (q.mode !== MODE.ZOOMIES) continue;
    if ((q.lx - base.lx) ** 2 + (q.ly - base.ly) ** 2 < r2) return true;
  }
  return false;
}

function paradeTick(state, base, cfg, rng) {
  const s = state.stack;
  if (rng.chance(cfg.baseTurnP)) s.baseDir = wrapDir(s.baseDir + rng.pick(cfg.turnOptions));
  // The heading is read once and shared: the base's facing, the riders' facing, and
  // the step all use this tick's value, so a bounce below only takes effect next tick
  // (otherwise the riders would face one way and the tower the other).
  const facing = s.baseDir;
  base.dir = facing;

  // Wander the base a small step along its heading; reverse if a wall/fence boxes it.
  // The floor keeps the whole tower on stage — the riders extend upward from here.
  const bx = base.lx;
  const by = base.ly;
  const floor = s.riders.length * cfg.riderRise + 10;
  const moved = applyPos(
    cfg,
    base.lx,
    base.ly,
    round(base.lx + AX[facing] * cfg.baseStep),
    max(floor, round(base.ly + AY[facing] * cfg.baseStep)),
  );
  base.lx = moved.x;
  base.ly = moved.y;
  snapVisual(base);
  if (base.lx === bx && base.ly === by) s.baseDir = opposite(facing);

  // The riders: seated, facing the heading, with a foot-pivoted teeter whose head
  // shift accumulates up the tower (the base leads, each rider above lags, so the
  // wobble travels upward).
  let acc = 0;
  for (let i = 0; i < s.riders.length; i++) {
    const r = byId(state, s.riders[i]);
    if (!r) continue;
    const level = i + 1;
    const sway = riderSway(state.tick, level, cfg);
    r.dir = facing;
    r.stackLevel = level;
    r.lx = base.lx + acc;
    r.ly = base.ly - level * cfg.riderRise;
    snapVisual(r);
    acc += sway * cfg.sitTravel; // this rider's head shift → the next rider's seat
  }

  if (state.tick - s.born >= s.life || struck(state, base, cfg)) topple(state, cfg, rng);
}

// The whole tower comes down together: drop the riders onto the base so all three
// hitboxes overlap, drop every stack flag, and let the ordinary collision logic take
// over — within a tick it knocks the coincident pile apart, so all three fall and
// scatter (no fling-off), each recovering on its own schedule.
function topple(state, cfg, rng) {
  const s = state.stack;
  const base = byId(state, s.baseId);

  // The watcher lingers on the wreck, then moves on.
  const inc = state.incidents.find((i) => i.subject === s.baseId && i.born === s.incBorn);
  if (inc) inc.expires = state.tick + cfg.aftermathLinger;

  base.solid = false;
  base.mode = MODE.WANDER;
  base.anim = ANIM.WALK;
  base.moveTimer = 1;

  s.riders.forEach((id, idx) => {
    const r = byId(state, id);
    if (!r) return;
    r.riding = false;
    r.flying = false;
    r.mode = MODE.WANDER;
    r.anim = ANIM.WALK;
    r.stackLevel = 0;
    r.moveTimer = 1;
    r.lx = base.lx + (idx ? 8 : -8); // a hair apart so the knocks fan them out
    r.ly = base.ly;
    snapVisual(r);
  });

  s.baseId = -1;
  s.mounters = [];
  s.riders = [];
  s.mountIdx = 0;
  s.phase = PHASE.MOUNT;
  s.incBorn = -1;

  // The coupling rule: a topple is just a topple — unless the tier-3 director is
  // armed, in which case it is the cascade's ignition. The rarest, best
  // co-occurrence: the watcher is already here studying the tower when it falls.
  if (state.cascade.armed && !state.cascade.active) {
    igniteCascade(state, [base.id], cfg, rng);
  }
}

function advanceTower(state, cfg, rng) {
  const s = state.stack;
  const base = byId(state, s.baseId);
  if (!base) {
    s.baseId = -1; // the base left the roster (a resize/respawn) — abandon the tower
    return;
  }
  if (s.phase === PHASE.PARADE) {
    paradeTick(state, base, cfg, rng);
    return;
  }
  // Assembly: the base holds still (its glide simply settles) while one panda climbs.
  easeVisual(base, cfg);
  const m = byId(state, s.mounters[s.mountIdx]);
  if (!m) return;
  if (s.phase === PHASE.FLIGHT) advanceHop(state, base, m, cfg, rng);
  else mountWalk(state, base, m, cfg);
}
