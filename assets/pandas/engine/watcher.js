// The hat panda's brain — the rules "expert" that walks the line.
//
// A pure port of pandas.js's observe() + hatReflex() decision logic (map §7),
// wrapped to emit one of the 17 discrete actions (actions.js) per decision tick.
// It owns *where to be*: which subject is worth walking to, the vantage to hold,
// when to sidestep a drifter, and when to spend the one dive-roll. The engine
// (hat.js) executes whatever action this returns, so behaviour-cloning targets
// are exact: the logged action IS what moved him.
//
// All spatial reasoning uses the LOGICAL position (lx, ly) — the original read
// this.x / q.x, which are the stride-grid coordinates, while collision alone read
// the lagging rendered position. Keeping that split is what preserves the feel:
// he reasons a step ahead of where the glide has actually carried everyone.

import { AX, AY, DX, DY, wrapDir, headingDir } from './dirs.js';
import { hypot } from './mathx.js';
import { inBounds, crossesFence, detourCorner, strideTo } from './geometry.js';
import { MODE, ANIM, UNSET_GAP, POINT_SUBJECT } from './state.js';
import { ACTION, stepAction, rollAction } from './actions.js';

// ---- small lookups over the field (all in logical space) ----

export function subjectEntity(entities, id) {
  if (id < 0) return null;
  const e = entities.find((q) => q.id === id);
  return e && !e.hasHat ? e : null;
}

// What the hat is currently watching, as something with a logical position: either a
// panda, or the fixed spot a tier-3 cascade incident pinned (the origin of the
// carnage — no one body to blame). Everything downstream only reads `lx`/`ly`, so a
// spot and a panda are interchangeable to the observe loop.
export function watchedTarget(state, hat) {
  if (hat.subject === POINT_SUBJECT) return { lx: hat.subjPx, ly: hat.subjPy };
  return subjectEntity(state.entities, hat.subject);
}

// Summed proximity of other pandas to (x, y): 0 when clear, growing as they
// cluster within `avoidR`. Ignores self and transients (mid-fling / walking in).
export function crowdAt(x, y, self, entities, cfg) {
  let c = 0;
  const r = cfg.avoidR;
  for (const q of entities) {
    if (q.id === self.id || q.flying || q.entering) continue;
    const dx = q.lx - x;
    const dy = q.ly - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) c += 1 - Math.sqrt(d2) / r;
  }
  return c;
}

// Rough px/tick of a threat, so the reflex can tell a zoomies/skid (fast → roll)
// from a trudging roamer (slow → sidestep). Mirrors the original threatSpeed,
// re-denominated per tick.
export function threatSpeed(q, cfg) {
  if (q.mode === MODE.ZOOMIES) return cfg.zoomIncr / cfg.zoomEvery;
  if (q.mode === MODE.TUMBLER) return cfg.tripSlide / cfg.tripSkids / cfg.tripEvery;
  if (q.mode === MODE.KNOCKED) return cfg.impact / cfg.fallTicks;
  return cfg.step / q.moveSpeed;
}

// Pandas actively bearing down on the hat: moving, within radius R, and heading
// toward him. A planted/idle body (even close) is not a threat — nav avoidance
// handles static bodies; the roll is only for things coming *at* him.
export function threatsTo(self, R, entities, cfg) {
  const out = [];
  const r2 = R * R;
  for (const q of entities) {
    if (q.id === self.id || q.entering || q.flying || q.observer) continue;
    const dx = self.lx - q.lx;
    const dy = self.ly - q.ly;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    // Must be moving: a walker, a zoomies dash (anim walk), or a tumbler skid.
    const moving = q.anim === ANIM.WALK || q.mode === MODE.TUMBLER || q.mode === MODE.ZOOMIES;
    if (!moving) continue;
    const d = Math.sqrt(d2) || 1;
    if ((AX[q.dir] * dx + AY[q.dir] * dy) / d < cfg.hatClosingMin) continue;
    out.push(q);
  }
  return out;
}

// The escape heading: the landing spot (one of 8, `dist` px away) that stays on
// stage and maximises the minimum distance to every threat's *projected* next
// position. Returns -1 if every landing is off-stage/into the card.
export function bestEscape(self, threats, dist, avoidCrowd, entities, cfg) {
  let bi = -1;
  let bs = -Infinity;
  for (let i = 0; i < 8; i++) {
    const cx = self.lx + AX[i] * dist;
    const cy = self.ly + AY[i] * dist;
    if (!inBounds(cfg, cx, cy)) continue;
    let score = Infinity;
    for (const t of threats) {
      const tx = t.lx + AX[t.dir] * cfg.hatThreatLookahead;
      const ty = t.ly + AY[t.dir] * cfg.hatThreatLookahead;
      score = Math.min(score, hypot(cx - tx, cy - ty));
    }
    if (avoidCrowd) score -= cfg.hatStepCrowdW * crowdAt(cx, cy, self, entities, cfg);
    if (score > bs) {
      bs = score;
      bi = i;
    }
  }
  return bi;
}

// The vantage axis whose standoff point (td from the subject) is nearest the hat
// AND least crowded, on stage, with a clear line of sight. Falls back to the best
// on-stage one, then the least-bad by score. `avoid` forces a different approach
// angle on a re-vantage.
export function bestAxis(subject, hat, td, avoid, entities, cfg) {
  const lx = subject.lx;
  const ly = subject.ly;
  let bi = -1;
  let bs = Infinity;
  let oi = -1;
  let os = Infinity;
  let fi = 0;
  let fs = Infinity;
  for (let i = 0; i < 8; i++) {
    if (i === avoid) continue;
    const vx = lx + AX[i] * td;
    const vy = ly + AY[i] * td;
    const s = (vx - hat.lx) ** 2 + (vy - hat.ly) ** 2 + cfg.axisCrowdW * crowdAt(vx, vy, hat, entities, cfg);
    if (s < fs) {
      fs = s;
      fi = i;
    }
    if (!inBounds(cfg, vx, vy)) continue;
    if (s < os) {
      os = s;
      oi = i;
    }
    if (crossesFence(cfg, vx, vy, lx, ly)) continue;
    if (s < bs) {
      bs = s;
      bi = i;
    }
  }
  return bi >= 0 ? bi : oi >= 0 ? oi : fi;
}

// Weave toward (tx, ty) around the troupe: of the 8 grid steps, the one that best
// trades progress against crowding; routes around the card first. Returns the
// heading index, or -1 to HOLD (every step would only push deeper into a crowd —
// he stands a tick and lets a panda pass, never phasing through).
export function chooseWeaveDir(hat, tx, ty, entities, cfg) {
  let gx = tx;
  let gy = ty;
  if (crossesFence(cfg, hat.lx, hat.ly, tx, ty)) {
    [gx, gy] = detourCorner(cfg, hat.lx, hat.ly, tx, ty);
  }
  const sdx = gx - hat.lx;
  const sdy = gy - hat.ly;
  const gd = hypot(sdx, sdy) || 1;
  const ux = sdx / gd;
  const uy = sdy / gd;
  let bi = -1;
  let best = -cfg.weaveCrowdW * crowdAt(hat.lx, hat.ly, hat, entities, cfg) - cfg.weaveHoldBias;
  for (let i = 0; i < 8; i++) {
    const cx = hat.lx + DX[i] * cfg.step;
    const cy = hat.ly + DY[i] * cfg.step;
    if (!inBounds(cfg, cx, cy)) continue;
    const score = AX[i] * ux + AY[i] * uy - cfg.weaveCrowdW * crowdAt(cx, cy, hat, entities, cfg);
    if (score > best) {
      best = score;
      bi = i;
    }
  }
  return bi;
}

// ---- the incident queue: what the watcher attends to ----

// Live incidents this tick (expiry check mirrors pruneIncidents), skipping ones
// with no subject or that he already gave up reaching.
function isLive(inc, tick) {
  const hasSubject = inc.subject >= 0 || inc.subject === POINT_SUBJECT;
  return inc.expires > tick && hasSubject && !inc.abandoned;
}

// Where an incident is: its subject panda, or the spot it pinned. null = its subject
// has left the roster, so the incident is unreachable.
function incidentPos(state, inc) {
  if (inc.subject === POINT_SUBJECT) return { lx: inc.px, ly: inc.py };
  const subj = subjectEntity(state.entities, inc.subject);
  return subj ? { lx: subj.lx, ly: subj.ly } : null;
}

// Highest tier wins; within a tier, the incident nearest the hat (recency only
// breaks an exact distance tie). Nearest-first is what makes him read as
// overwhelmed rather than omniscient — he can't be everywhere.
export function topIncident(state, hat) {
  let best = null;
  let bestD = 0;
  for (const inc of state.incidents) {
    if (!isLive(inc, state.tick)) continue;
    const pos = incidentPos(state, inc);
    if (!pos) continue;
    const d = (pos.lx - hat.lx) ** 2 + (pos.ly - hat.ly) ** 2;
    if (
      !best ||
      inc.tier > best.tier ||
      (inc.tier === best.tier && d < bestD) ||
      (inc.tier === best.tier && d === bestD && inc.born > best.born)
    ) {
      best = inc;
      bestD = d;
    }
  }
  return best;
}

// A relaxed ambient subject: a panda out in the field, preferring ones he isn't
// already standing on top of. Returns an id, or -1 if the field is empty.
export function pickSubject(hat, entities, cfg, rng) {
  const free = entities.filter((q) => !q.hasHat && !q.entering && q.mode !== MODE.KNOCKED);
  const half = (cfg.ambientStandoff * 0.5) ** 2;
  const pool = free.filter((q) => (q.lx - hat.lx) ** 2 + (q.ly - hat.ly) ** 2 > half);
  if (pool.length) return rng.pick(pool).id;
  return free.length ? free[0].id : -1;
}

// What the hat should attend to this observe tick: the top live incident (held
// with a stickiness window so it doesn't flip between simultaneous events), else
// an ambient subject held for a dwell. Returns { subject, standoff, px, py } —
// px/py carry the spot when `subject` is POINT_SUBJECT, and are 0 otherwise.
export function pickWatchTarget(state, hat, cfg, rng) {
  const tick = state.tick;
  const top = topIncident(state, hat);
  let held = null;
  if (hat.incSubject >= 0) {
    held =
      state.incidents.find(
        (inc) => inc.subject === hat.incSubject && inc.born === hat.incBorn && isLive(inc, tick),
      ) || null;
  }
  let inc = held;
  if (top && top !== held && (!held || top.tier > held.tier || tick - hat.incidentSince >= cfg.stickyTicks)) {
    inc = top; // higher tier preempts at once; same/lower only after the sticky window
  }
  if (inc) {
    if (inc !== held) {
      hat.incSubject = inc.subject;
      hat.incBorn = inc.born;
      hat.incidentSince = tick;
    }
    hat.ambientTicks = 0; // leaving the incident later rerolls a fresh relax-subject
    return { subject: inc.subject, standoff: cfg.inspectNear, px: inc.px, py: inc.py };
  }
  // empty queue → ambient wander-watch, rerolled once its dwell runs out
  hat.incSubject = -1;
  hat.incBorn = -1;
  const subjValid = hat.subject >= 0 && !!subjectEntity(state.entities, hat.subject);
  if (!subjValid || --hat.ambientTicks <= 0) {
    hat.ambientTicks = Math.max(1, Math.round(rng.intBetween(cfg.dwellMin, cfg.dwellMax) / hat.moveSpeed));
    return {
      subject: pickSubject(hat, state.entities, cfg, rng),
      standoff: cfg.ambientStandoff,
      px: 0,
      py: 0,
    };
  }
  return { subject: hat.subject, standoff: cfg.ambientStandoff, px: 0, py: 0 };
}

// Begin a walk to a fresh vantage axis, resetting the stuck accounting that drives
// the hold → re-vantage → abandon escalation.
export function startRelocate(hat, axis) {
  hat.relocating = true;
  hat.vAxis = axis;
  hat.stuck = 0;
  hat.revantaged = false;
  hat.stuckPrev = UNSET_GAP;
}

// Mark the incident the hat is currently holding as abandoned, so topIncident
// won't re-grab it for the rest of its TTL (he honestly missed it).
function markAbandoned(state, hat) {
  if (hat.incSubject < 0) return;
  const inc = state.incidents.find((i) => i.subject === hat.incSubject && i.born === hat.incBorn);
  if (inc) inc.abandoned = true;
}

// ---- the policy: one action per decision tick ----

// The reflex tier — the emergency dive-roll. Checked every decision tick (fast),
// independent of the slower observe cadence. Returns a ROLL action or -1.
function reflexAction(state, hat, cfg) {
  if (state.tick < hat.rollReadyAt) return -1; // cooldown
  const ents = state.entities;
  const near = threatsTo(hat, cfg.hatDangerR, ents, cfg);
  if (!near.length) return -1;
  const fast = near.some((q) => threatSpeed(q, cfg) >= cfg.hatFastSpeed);
  const crowd = threatsTo(hat, cfg.hatRollR, ents, cfg).length >= 2;
  const panic = threatsTo(hat, cfg.hatPanicR, ents, cfg).length >= 1;
  if (!(fast || crowd || panic)) return -1;
  const dir = bestEscape(hat, near, cfg.rollDist, false, ents, cfg);
  return dir >= 0 ? rollAction(dir) : -1;
}

// One observe tick: refresh attention, then decide a single step (relocate weave,
// sidestep, or plant). Runs only when the stride cadence has elapsed.
function observeTick(state, hat, cfg, rng) {
  const ents = state.entities;
  const want = pickWatchTarget(state, hat, cfg, rng);
  // A pinned spot counts as a different target when the spot itself moved (a second
  // cascade elsewhere), even though the subject sentinel is unchanged.
  const movedSpot =
    want.subject === POINT_SUBJECT && (want.px !== hat.subjPx || want.py !== hat.subjPy);
  if (want.subject !== hat.subject || want.standoff !== hat.td || movedSpot) {
    hat.subject = want.subject;
    hat.subjPx = want.px;
    hat.subjPy = want.py;
    hat.td = want.standoff;
    const se = watchedTarget(state, hat);
    if (se) startRelocate(hat, bestAxis(se, hat, hat.td, -1, ents, cfg));
  }
  const s = watchedTarget(state, hat);
  if (!s) {
    // nobody to watch — amble gently (a plain wander stride; the bounce off a wall
    // is handled where the step is applied).
    hat.dir = wrapDir(hat.dir + rng.pick(cfg.turnOptions));
    return stepAction(hat.dir);
  }

  const ox = hat.lx - s.lx;
  const oy = hat.ly - s.ly;
  const dist = hypot(ox, oy) || 1;
  const losBlocked = crossesFence(cfg, hat.lx, hat.ly, s.lx, s.ly);
  let maxDot = -Infinity;
  for (let i = 0; i < 8; i++) {
    const d = (ox * AX[i] + oy * AY[i]) / dist;
    if (d > maxDot) maxDot = d;
  }
  const angleOff = maxDot < (hat.incSubject >= 0 ? cfg.axisCos : cfg.ambientAxisCos);
  const near = hat.td - cfg.step;
  const far = hat.td * cfg.standoffSlack;

  if (!hat.relocating) {
    if (dist > far || losBlocked) startRelocate(hat, bestAxis(s, hat, hat.td, -1, ents, cfg));
    else if (angleOff) startRelocate(hat, bestAxis(s, hat, Math.max(hat.td, dist), -1, ents, cfg));
  }

  if (hat.relocating) return relocateStep(state, hat, s, cfg, { dist, losBlocked, angleOff, near, far });
  return plantedStep(state, hat, s, cfg, { dist, far });
}

// Weave one step toward the vantage, then run the reached / settled / stuck
// escalation (re-vantage, then abandon) on the *prospective* landing — the engine
// applies the identical stride.
function relocateStep(state, hat, s, cfg, ctx) {
  const ents = state.entities;
  const tx = s.lx + AX[hat.vAxis] * hat.td;
  const ty = s.ly + AY[hat.vAxis] * hat.td;
  const dir = chooseWeaveDir(hat, tx, ty, ents, cfg);
  const land = dir >= 0 ? strideTo(cfg, hat.lx, hat.ly, dir) : { x: hat.lx, y: hat.ly };
  const rx = tx - land.x;
  const ry = ty - land.y;
  const gd2 = rx * rx + ry * ry;
  const reached = gd2 <= (cfg.step * 1.3) ** 2;
  const settled = !ctx.losBlocked && !ctx.angleOff && ctx.dist >= ctx.near && ctx.dist <= ctx.far;
  const progressed = gd2 < hat.stuckPrev - cfg.step;
  hat.stuckPrev = gd2;

  if (reached || settled) {
    hat.relocating = false;
    hat.stuck = 0;
    hat.revantaged = false;
  } else if (progressed) {
    hat.stuck = 0;
  } else if (++hat.stuck >= cfg.weaveStuck) {
    hat.stuck = 0;
    if (!hat.revantaged) {
      hat.revantaged = true;
      hat.vAxis = bestAxis(s, hat, hat.td, hat.vAxis, ents, cfg); // a fresh approach angle
      hat.stuckPrev = UNSET_GAP;
    } else {
      markAbandoned(state, hat); // still boxed → let this one go
      hat.incSubject = -1;
      hat.incBorn = -1;
      hat.subject = -1;
      hat.subjPx = 0;
      hat.subjPy = 0;
      hat.ambientTicks = 0;
      hat.relocating = false;
    }
  }
  return dir >= 0 ? stepAction(dir) : ACTION.HOLD;
}

// Planted at the vantage: a single slow drifter → step calmly aside; a crowded
// vantage → relocate to clearer air; otherwise hold and face the subject.
function plantedStep(state, hat, s, cfg, ctx) {
  const ents = state.entities;
  const drifters = threatsTo(hat, cfg.hatSidestepR, ents, cfg);
  const stepDir = drifters.length ? bestEscape(hat, drifters, cfg.step, true, ents, cfg) : -1;
  if (stepDir >= 0) return stepAction(stepDir);
  if (crowdAt(hat.lx, hat.ly, hat, ents, cfg) > cfg.crowdBump) {
    startRelocate(hat, bestAxis(s, hat, Math.max(hat.td, Math.min(ctx.far, ctx.dist)), -1, ents, cfg));
    return ACTION.HOLD; // begins relocating next observe tick
  }
  // Face the subject (deterministic). The gaze flourish — bystander glances, the
  // look-around — is presentation, layered on in M5.
  const fd = headingDir(s.lx - hat.lx, s.ly - hat.ly, 8);
  if (fd >= 0) hat.dir = fd;
  return ACTION.HOLD;
}

// The full rules expert for one decision tick: reflex first, then the observe
// cadence gate (one stride per interval, otherwise hold). Mutates the hat's brain
// and returns the chosen action. This is the function a trainer queries for exact
// behaviour-cloning targets.
export function rulesAction(state, hat, cfg, rng) {
  const roll = reflexAction(state, hat, cfg);
  if (roll >= 0) return roll;
  if (hat.moveTimer > 0) return ACTION.HOLD; // between strides — glide only
  const act = observeTick(state, hat, cfg, rng);
  const alert = threatsTo(hat, cfg.hatDangerR, state.entities, cfg).length > 0;
  hat.moveTimer = alert ? cfg.hatAlert : hat.moveSpeed;
  return act;
}
