// The engine — pure, fixed-tick `step(state) -> state`.
//
// The whole sim: a field of pandas that wander (with the oblivious one keeping to
// its patch), a model-space collision → knock → fall → lie → stand-up → recover
// cycle, the tier-1 anomaly director and its 8 FSMs, the hat-panda watcher behind
// the 17-way action seam, the tier-2 stack, and the tier-3 cascade.
//
// State is a plain, serialisable object; every tick is a pure function of the one
// before it, so any tick can be snapshotted, hashed (golden traces), or resumed.
// Config lives inside state so `step(state)` needs nothing else. Randomness is the
// mulberry32 seed threaded through state.rng; draw order is entity-id order, then
// the three directors, then the hat, then collision — identical in Node and the
// browser.

import { Rng } from './rng.js';
import { makeConfig, DEFAULT_CONFIG } from './config.js';
import { DX, DY, wrapDir, opposite, dirName, eightWay } from './dirs.js';
import { applyPos } from './geometry.js';
import { sq } from './mathx.js';
import { detectCollisions } from './collision.js';
import {
  MODE, ANIM, spawnEntities, isDown, easeVisual, advanceKnock, beginKnock, advanceEntrance,
} from './state.js';
import { updateAnomaly } from './anomalies.js';
import { initDirector, runDirector, pruneIncidents } from './director.js';
import { updateHat } from './hat.js';
import { initStack, runStack } from './stack.js';
import {
  initCascade, runCascade, igniteCascade, cascadeElsewhere,
  claimed, isIgnitionSeed, releaseClaim,
} from './cascade.js';

// ---- per-entity update (movement + knock FSM) ----

// Advance one entity by one tick. Returns a NEW entity object (input untouched).
// `state` is this step's partially-built next state — the knock FSM needs it to
// release a cascade claim on recovery.
function updateEntity(e, cfg, rng, state) {
  if (e.mode === MODE.WANDER) return updateWander(e, cfg, rng);
  if (e.mode === MODE.KNOCKED) return updateKnocked(e, cfg, state);
  if (e.mode === MODE.ENTERING) return updateEntering(e, cfg);
  // Stack roles are driven wholesale by runStack (one machine owns the tower), and
  // the hat panda by updateHat — both only need a clone here.
  if (e.mode === MODE.STACK_BASE || e.mode === MODE.MOUNTING || e.mode === MODE.RIDING) {
    return { ...e };
  }
  // An anomaly mode: advance its FSM on a clone.
  const next = { ...e };
  updateAnomaly(next, cfg, rng);
  return next;
}

// Walking on from off-stage. On arrival it simply joins the wander — no fanfare,
// which is the point: by the time you notice it, it is one of the troupe.
function updateEntering(e, cfg) {
  const next = { ...e };
  if (advanceEntrance(next, cfg)) {
    next.mode = MODE.WANDER;
    next.anim = ANIM.WALK;
  }
  return next;
}

function updateWander(e, cfg, rng) {
  const next = { ...e };

  // A stride fires when the cadence timer elapses.
  if (--next.moveTimer <= 0) {
    if (next.oblivious && rng.chance(cfg.obliviousIdleP)) {
      // The oblivious one often just idles in place — logical position holds.
      next.anim = ANIM.IDLE;
      next.moveTimer = rng.intBetween(cfg.obliviousIdleMin, cfg.obliviousIdleMax);
    } else {
      next.anim = ANIM.WALK;
      wanderStep(next, cfg, rng); // advances the logical position (lx, ly)
      next.moveTimer = next.moveSpeed;
    }
  }

  // Every tick, the visual position eases toward the logical one — the glide.
  easeVisual(next, cfg);
  return next;
}

// One wander stride: turn a little (or head home if the oblivious one strayed),
// step STEP px on the LOGICAL position, and bounce (turn around) if a wall/fence
// blocks both axes. Mutates the already-cloned `e`.
function wanderStep(e, cfg, rng) {
  const strayed =
    e.oblivious &&
    e.home &&
    sq(e.lx - e.home[0]) + sq(e.ly - e.home[1]) > sq(cfg.obliviousRadius);

  if (strayed) {
    e.dir = eightWay(e.home[0] - e.lx, e.home[1] - e.ly);
  } else {
    e.dir = wrapDir(e.dir + rng.pick(cfg.turnOptions));
  }

  const candX = e.lx + DX[e.dir] * cfg.step;
  const candY = e.ly + DY[e.dir] * cfg.step;
  const moved = applyPos(cfg, e.lx, e.ly, candX, candY);
  const blocked = moved.x === e.lx && moved.y === e.ly;
  e.lx = moved.x;
  e.ly = moved.y;
  if (blocked) e.dir = opposite(e.dir); // walk away from the wall, don't moonwalk into it
}

function updateKnocked(e, cfg, state) {
  const next = { ...e };
  // Shared fall → lie → stand-up skid (state.advanceKnock). A roamer that finishes
  // recovering rejoins the wander; the hat panda's knock is advanced in updateHat
  // instead, which routes recovery back into observing.
  if (advanceKnock(next, cfg)) {
    next.mode = MODE.WANDER;
    next.anim = ANIM.WALK;
    // Standing up releases a cascade claim — it has played its part as a domino and
    // is fair game for the next front (or an ordinary collision) again.
    if (next.cascadeFall) {
      next.cascadeFall = false;
      releaseClaim(state, next.id);
    }
  }
  return next;
}

// ---- collision → knocks ----

// Apply this tick's collisions to the freshly-updated entities (mutating them in
// place — they are this step's own new objects, not shared with the input state).
// A panda already down is left alone; a fresh contact starts its knock. While the
// cascade director is armed, the collisions that land here are its ignition.
function applyCollisions(state, cfg, rng) {
  const entities = state.entities;
  const hits = detectCollisions(entities, cfg);
  if (hits.length === 0) return;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const seeds = [];
  for (const { id, hit } of hits) {
    const e = byId.get(id);
    if (isDown(e)) continue; // already on the ground (knock, nap, trip, crash) — can't re-knock
    if (e.mode === MODE.ROLLING) continue; // dive-roll i-frames — the committed escape is invulnerable
    if (claimed(state, e.id)) continue; // a cascade front owns this fall; don't pre-empt it
    startKnock(e, hit, cfg, rng); // a real knock overrides an in-progress anomaly
    if (isIgnitionSeed(state, e)) seeds.push(e.id);
  }
  // Ignition: while armed, the next natural collision between ordinary roamers
  // escalates into a cascade — but only if it erupts away from the watcher's gaze
  // (else hold the arm for a farther one).
  if (seeds.length && cascadeElsewhere(state, seeds, cfg)) {
    igniteCascade(state, seeds, cfg, rng);
  }
}

// An ordinary shove: the slide is IMPACT px away from the struck side.
function startKnock(e, hit, cfg, rng) {
  const name = dirName(hit);
  beginKnock(e, cfg, rng, {
    faceDir: hit,
    slideVx: (name.includes('left') ? cfg.impact : 0) - (name.includes('right') ? cfg.impact : 0),
    slideVy: (name.includes('up') ? cfg.impact : 0) - (name.includes('down') ? cfg.impact : 0),
  });
}

// ---- the public engine ----

export function makeEngine(userConfig = {}) {
  const cfg = makeConfig(userConfig);

  const init = (seed) => {
    const rng = new Rng(seed);
    const entities = spawnEntities(rng, cfg);
    return {
      tick: 0,
      rng: rng.state,
      cfg,
      entities,
      director: initDirector(cfg),
      stack: initStack(cfg),
      cascade: initCascade(cfg),
      incidents: [],
    };
  };

  const step = (state, action = null) => {
    const rng = new Rng(state.rng);
    const c = state.cfg;
    // Everything mutable is copied up front so the input state is never touched
    // (purity at the tick boundary). The arrays inside stack/cascade hold ids and
    // small records, so a shallow copy per array is enough.
    const next = {
      tick: state.tick + 1,
      rng: 0,
      cfg: c,
      entities: [],
      director: { ...state.director },
      stack: { ...state.stack, mounters: [...state.stack.mounters], riders: [...state.stack.riders] },
      cascade: {
        ...state.cascade,
        lock: [...state.cascade.lock],
        pending: state.cascade.pending.map((p) => ({ ...p })),
      },
      // The hat may mark an incident abandoned and a topple shortens one, so these
      // are copied too.
      incidents: state.incidents.map((inc) => ({ ...inc })),
    };
    // The hat panda is updated separately (updateHat), after the directors, so it
    // reasons about this tick's positions and the freshest incident queue — here it
    // is only cloned.
    next.entities = state.entities.map((e) => (e.hasHat ? { ...e } : updateEntity(e, c, rng, next)));
    // Order: roamers/anomalies → tier-1 director (may start an anomaly + emit an
    // incident) → tier 2 (the stack: assembly, parade, topple) → tier 3 (the cascade:
    // the arming clock and the scheduled domino falls) → the hat (reads incidents,
    // emits its 17-way action) → collisions (may knock, overriding an anomaly, and
    // are the cascade's ignition while armed; the hat's roll is i-framed) → prune.
    runDirector(next, c, rng);
    runStack(next, c, rng);
    runCascade(next, c, rng);
    updateHat(next, c, rng, action);
    applyCollisions(next, c, rng);
    pruneIncidents(next);
    next.rng = rng.state;
    return next;
  };

  const encode = (state) => {
    const s = state.stack;
    const cc = state.cascade;
    const out = [
      state.tick, state.rng, state.director.nextAt, state.director.last, state.incidents.length,
      // tier 2 — the stack machine
      s.nextAt, s.baseId, s.phase, s.mountIdx, s.mounters.length, s.riders.length,
      s.timer, s.steps, s.flight, s.born, s.life, s.baseDir,
      // tier 3 — the cascade machine
      cc.armed ? 1 : 0, cc.active ? 1 : 0, cc.nextArmAt, cc.forceAt, cc.endAt,
      cc.felled, cc.target, cc.lock.length, cc.pending.length,
    ];
    for (const e of state.entities) {
      out.push(
        e.x, e.y, e.lx, e.ly, e.dir, e.mode, e.anim, e.moveTimer,
        // The running glide (state.js easeVisual) — it feeds every following tick's
        // visual position, and the visual position is what collides.
        e.g0x, e.g0y, e.gtx, e.gty, e.gT,
        e.knockPhase, e.knockTimer, e.slideVx, e.slideVy,
        e.aPhase, e.aTimer, e.aCount, e.aHeading, e.aLie, e.aStep,
        // set-piece roles: the collision flags and the tower tier
        e.solid ? 1 : 0, e.flying ? 1 : 0, e.riding ? 1 : 0, e.stackLevel,
        e.cascadeFall ? 1 : 0,
      );
    }
    // The hat panda's watcher brain — only the hat carries meaningful values, so
    // append them once rather than per entity. All of it feeds future ticks, so
    // the golden trace must cover it.
    const h = state.entities.find((e) => e.hasHat);
    if (h) {
      out.push(
        h.subject, h.subjPx, h.subjPy, h.td, h.relocating ? 1 : 0, h.vAxis, h.stuck,
        h.revantaged ? 1 : 0, h.stuckPrev, h.incSubject, h.incBorn, h.incidentSince,
        h.ambientTicks, h.rollReadyAt, h.action,
      );
    }
    return out;
  };

  return { init, step, encode, cfg };
}

// The action the built-in expert actually applied each tick is recorded on the hat
// entity as `hat.action` (encode() serialises it) — that is the exact, side-effect-
// free behaviour-cloning target for Phase B: just read it off the stepped state.
// The raw `rulesAction` (which MUTATES the hat's brain — it *is* the expert, not a
// dry-run query) and the ACTION vocabulary are re-exported for the trainer/NN seam.
export { ACTION } from './actions.js';
export { rulesAction } from './watcher.js';

// Default engine (live-site config) — the module the golden-trace CLI loads.
const defaultEngine = makeEngine(DEFAULT_CONFIG);
export const init = defaultEngine.init;
export const step = defaultEngine.step;
export const encode = defaultEngine.encode;
