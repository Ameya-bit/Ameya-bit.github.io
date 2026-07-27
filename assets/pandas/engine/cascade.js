// Tier 3: the cascade — the chain-reaction knockout, the field's jackpot.
//
// Cartoon physics: outcome-authored, physics-flavoured. The director ARMS on a long
// jittered clock and then does nothing — while unarmed every collision is ordinary.
// Once armed, the next natural collision (or a stack topple, per the coupling rule)
// IGNITES: the felled pandas become the fronts of a greedy nearest-neighbour sweep.
// Each faller, on landing, claims its nearest standing neighbour and — a short
// stagger later — topples it toward *that* neighbour's own nearest, so it lands
// overlapping the next domino and the ripple keeps going. Coverage is capped at
// 70-90%: a full clear reads scripted, so the oblivious one is structurally spared
// and a couple of out-of-range stragglers survive. That's the joke.
//
// All the rarity lives in the arming clock, never in the trigger (map §5, tier 3).
//
// The port's one structural change: the original's recursive `victim.after(hop, ...)`
// timers become a `pending` queue of scheduled falls on state, processed by tick
// number. Same staggered ripple, no wall clock.

import { AX, AY, headingDir } from './dirs.js';
import { MODE, POINT_SUBJECT, isDown, beginKnock } from './state.js';
import { emitIncident } from './director.js';
import { round, max } from './mathx.js';

export function initCascade(cfg) {
  return {
    armed: false, // the flag the next collision escalates through
    active: false, // a sweep is propagating (blocks re-ignition)
    nextArmAt: cfg.cascadeKick, // the arming clock — where the rarity lives
    forceAt: -1, // liveness backstop: manufacture an ignition at this tick (-1 = none)
    endAt: -1, // the machinery resets here (propagation + recovery done)
    lock: [], // ids claimed by a front: an ordinary collision must not pre-empt them
    felled: 0, // claims made so far this sweep
    target: 0, // …and the coverage cap they stop at
    pending: [], // scheduled falls: [{ victim: id, at: tick }]
  };
}

// The cascade's universe: an ordinary roamer. The watcher only observes, the
// oblivious one is immune, and set-piece members / transients aren't part of the
// field. Coverage is measured against this, so those exclusions plus the uncapped
// remainder are the guaranteed survivors.
export const isRoamer = (e) =>
  !e.hasHat && !e.oblivious && !e.entering && !e.solid && !e.riding && !e.flying;

const byId = (state, id) => state.entities.find((e) => e.id === id);
const isLocked = (c, id) => c.lock.indexOf(id) >= 0;

// A front's next domino: the nearest still-standing roamer within `chainRange` that
// no other front has already claimed. null → the front dies out, and that panda
// survives (which is how the coverage cap gets its stragglers).
export function nearestStandingNeighbour(state, from, cfg) {
  const c = state.cascade;
  let best = null;
  let bd = cfg.chainRange * cfg.chainRange;
  for (const q of state.entities) {
    if (q.id === from.id || !isRoamer(q) || isDown(q) || isLocked(c, q.id)) continue;
    const d = (q.lx - from.lx) ** 2 + (q.ly - from.ly) ** 2;
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

// A cascade fall: an ordinary knock recovery, but the slide is a *steered* vector
// aimed at the next domino with magnitude = the actual gap, so the faller lands
// overlapping it. Facing snaps to the nearest of the 8; a vector too short to name a
// heading falls back to the panda's default. `cascadeFall` is what releases its
// claim when it stands up again (engine.js).
export function cascadeKnock(e, vx, vy, cfg, rng) {
  // Already on the ground when its turn came — a tier-1 anomaly (a nap, a trip) put
  // it there between the claim and the fall. Nothing to knock; the front carries on
  // from where it lies, exactly as the original's `if (this.knocked) return` did.
  if (isDown(e)) return;
  const fd = headingDir(vx, vy);
  beginKnock(e, cfg, rng, {
    faceDir: fd >= 0 ? fd : e.defaultFallDir,
    slideVx: vx,
    slideVy: vy,
    cascade: true,
  });
}

// The steered fall vector for `faller`: the gap to its own nearest neighbour, or —
// when the front is about to die out — a plain shove along its facing.
function steerFrom(state, faller, cfg) {
  const t = nearestStandingNeighbour(state, faller, cfg);
  return t
    ? { vx: t.lx - faller.lx, vy: t.ly - faller.ly }
    : { vx: AX[faller.dir] * cfg.impact, vy: AY[faller.dir] * cfg.impact };
}

// Propagate one front from a panda that has just fallen: claim its nearest standing
// neighbour and schedule that neighbour's own fall a short stagger later. Claiming
// happens NOW so the other front (and ordinary collisions) can't take it.
function fellNext(state, from, cfg, rng) {
  const c = state.cascade;
  if (!c.active || c.felled >= c.target) return;
  const victim = nearestStandingNeighbour(state, from, cfg);
  if (!victim) return; // front dies out — a straggler survives
  c.lock.push(victim.id);
  c.felled += 1;
  c.pending.push({
    victim: victim.id,
    at: state.tick + rng.intBetween(cfg.cascadeHopMin, cfg.cascadeHopMax),
  });
}

// Ignite from one or more seeds — the parties to the igniting collision, or a
// toppled stack's base. A seed already down (a natural collision) stands as its own
// fall; a standing seed (a topple or a forced ignition) is felled first. A tier-3
// incident at the origin pulls the watcher in to find the wreck: he arrives late (it
// propagates faster than he can cross the field) and scans, overwhelmed.
export function igniteCascade(state, seedIds, cfg, rng) {
  const c = state.cascade;
  if (c.active) return;
  const fronts = seedIds.map((id) => byId(state, id)).filter((e) => e && isRoamer(e));
  if (!fronts.length) return;

  c.active = true;
  c.armed = false;
  c.forceAt = -1;
  const total = state.entities.filter(isRoamer).length;
  c.target = max(
    fronts.length,
    round(rng.float(cfg.cascadeCoverMin, cfg.cascadeCoverMax) * total),
  );
  c.felled = 0;
  c.lock = [];
  c.pending = [];

  let cx = 0;
  let cy = 0;
  for (const seed of fronts) {
    cx += seed.lx;
    cy += seed.ly;
    c.lock.push(seed.id);
    c.felled += 1;
    if (!isDown(seed)) {
      const { vx, vy } = steerFrom(state, seed, cfg);
      cascadeKnock(seed, vx, vy, cfg, rng);
    }
    fellNext(state, seed, cfg, rng);
  }

  // A stationary tier-3 subject at the origin — outranks every tier-1/2, so the
  // watcher scrambles into the carnage and stands amid the bodies, with no one body
  // to study (the "doesn't know where to start" beat).
  emitIncident(
    state,
    POINT_SUBJECT,
    3,
    cfg.cascadeIncidentTtl,
    round(cx / fronts.length),
    round(cy / fronts.length),
  );
  c.endAt = state.tick + cfg.cascadeDuration;
}

// The director stages the cascade to erupt where the watcher ISN'T looking, so he
// turns to find the field already going down. Hold the arm if the igniting collision
// is right under his gaze.
export function cascadeElsewhere(state, seedIds, cfg) {
  const hat = state.entities.find((e) => e.hasHat);
  if (!hat) return true;
  const r2 = (cfg.inspectNear * cfg.cascadeStageSlack) ** 2;
  for (const id of seedIds) {
    if (id === hat.subject) return false;
    const s = byId(state, id);
    if (!s) continue;
    if ((s.lx - hat.lx) ** 2 + (s.ly - hat.ly) ** 2 < r2) return false;
  }
  return true;
}

// Liveness backstop: armed too long without a natural collision → manufacture the
// ignition from the standing roamer farthest from the watcher (so it still erupts
// "elsewhere") and let it chain from there.
function forceIgnite(state, cfg, rng) {
  const c = state.cascade;
  if (!c.armed || c.active) return;
  const uni = state.entities.filter((e) => isRoamer(e) && !isDown(e));
  if (uni.length < 2) {
    c.armed = false; // nothing to topple — drop the arm and re-arm later
    return;
  }
  const hat = state.entities.find((e) => e.hasHat);
  let seed = uni[0];
  if (hat) {
    const far = (q) => (q.lx - hat.lx) ** 2 + (q.ly - hat.ly) ** 2;
    for (const q of uni) if (far(q) > far(seed)) seed = q;
  }
  igniteCascade(state, [seed.id], cfg, rng);
}

// Fire every fall whose stagger has elapsed: topple the victim toward ITS own
// nearest, then continue the front from there. Newly-scheduled falls are always at
// least `cascadeHopMin` ticks out, so they never fire in the same pass.
function advanceFronts(state, cfg, rng) {
  const c = state.cascade;
  const due = c.pending.filter((p) => p.at <= state.tick);
  if (!due.length) return;
  c.pending = c.pending.filter((p) => p.at > state.tick);
  for (const p of due) {
    if (!c.active) return;
    const victim = byId(state, p.victim);
    if (!victim) continue;
    // It joined a tower between the claim and the fall (tier 2 recruits from the same
    // pool). Don't yank a rider out of mid-air: drop the claim and let this front die.
    if (!isRoamer(victim)) {
      releaseClaim(state, victim.id);
      continue;
    }
    const { vx, vy } = steerFrom(state, victim, cfg);
    cascadeKnock(victim, vx, vy, cfg, rng);
    fellNext(state, victim, cfg, rng);
  }
}

// Advance the whole tier-3 machine one tick: expiry, the arming clock, the liveness
// backstop, then the scheduled falls. Ignition itself is external — fired by a
// natural armed collision (engine.js) or a stack topple (stack.js).
export function runCascade(state, cfg, rng) {
  const c = state.cascade;

  if (c.active && state.tick >= c.endAt) {
    c.active = false;
    c.lock = [];
    c.pending = [];
    c.endAt = -1;
    c.felled = 0;
    c.target = 0;
  }

  if (state.tick >= c.nextArmAt) {
    c.nextArmAt = state.tick + rng.intBetween(cfg.cascadeArmMin, cfg.cascadeArmMax);
    if (!c.active && !c.armed) {
      c.armed = true;
      c.forceAt = state.tick + cfg.cascadeArmTimeout;
    }
  }

  if (c.forceAt >= 0 && state.tick >= c.forceAt) {
    c.forceAt = -1;
    forceIgnite(state, cfg, rng);
  }

  advanceFronts(state, cfg, rng);
}

// A cascade-felled panda holds its claim exactly as long as it is down; standing up
// releases it (the original's `cascadeLock.delete(this)` on recovery). Called by the
// knock FSM, which is the only place that knows recovery happened.
export function releaseClaim(state, id) {
  const c = state.cascade;
  const i = c.lock.indexOf(id);
  if (i >= 0) c.lock.splice(i, 1);
}

// Has a front already claimed this panda? An ordinary collision must leave it alone
// — it falls on schedule, steered, and a plain knock here would pre-empt that.
// (Unclaimed bystanders still get knocked: a felled panda landing on a survivor is
// honest spillover.)
export const claimed = (state, id) => isLocked(state.cascade, id);

// Should this fresh knock escalate into a cascade? Only while armed, idle, and the
// victim is part of the field. Collected by engine.js's collision pass.
export const isIgnitionSeed = (state, e) =>
  state.cascade.armed && !state.cascade.active && isRoamer(e) && e.mode === MODE.KNOCKED;
