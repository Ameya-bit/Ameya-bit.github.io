// What a policy is allowed to believe about the world.
//
// C2 of design/panda-policy-net.md, and the whole trick of the yardstick gate: the
// oracle, the memoryless twin and the exploit bots must differ **only** in what they
// are allowed to read. If they were three separately written bots, a gap between
// their scores would measure how hard I tried on each one. So there is one planner
// (`planner.js`) and three percepts, and the gap measures information.
//
// A percept is `{ describe, init(cfg) -> mem, read(state, mem) -> belief }` where
//
//   belief = {
//     self:       the hat, as the navigation primitives want him
//     field:      entity-shaped objects he may reason about (nav + threat)
//     candidates: [{ key, lx, ly, tier, p, age, remaining, certain, hazard }]
//   }
//
// `p` is the probability this candidate is currently paying, `age`/`remaining` are
// ticks (null = "no idea, use the prior"), `hazard` is the chance per visit of
// being floored by it. **`certain` says whether `remaining` is knowledge or a
// guess**, and it is not decoration: under a dwell the planner must treat an
// uncertain estimate as a distribution to bet against rather than a countdown to
// read off, or an arm with no clock refuses every trip it cannot prove will pay.
// Only the oracle sets it. The three percepts fill those in with, respectively: the
// truth; the truth minus everything temporal; and a base rate off the drawn pose.
//
// ## Coordinates
//
// Others are read at their **visual** position — the drawn body, which is what
// collides, what the reward is paid on, and what the observation encoder reports.
// The hat is read at his **logical** one: that is his own commanded position, which
// any policy has for free (it is a function of the actions it just took), and
// planning a stride from a gliding origin overshoots. Both are the same for all
// three percepts, so nothing about the gap turns on it. Note this differs from the
// rules expert, which reasons entirely on the logical grid and so sees everyone a
// step into the future — a privilege deliberately withheld here.
//
// ## One deliberate generosity
//
// All three percepts track how long *he* has been collecting from a candidate
// (`banked`, kept in `mem` by the planner). That is the policy's own bookkeeping
// rather than a belief about the world, and withholding it from the reactive
// variants would have them camp one body forever as its rate decayed to nothing —
// inflating the gap with something that is not world-model knowledge. Erring
// toward the reactive policies makes the measured gap conservative, which is the
// direction a gate should err in.

import { MODE, ANIM } from '../assets/pandas/engine/state.js';
import { PHASE } from '../assets/pandas/engine/anomalies.js';
import { PHASE as STACK_PHASE } from '../assets/pandas/engine/stack.js';
import { AX, AY } from '../assets/pandas/engine/dirs.js';
import { OBS_FIELDS, OBS_WIDTH, makeObserver } from '../assets/pandas/engine/policy/obs.js';
import { hatOf } from './rollout.js';
import { incidentActive } from './game.js';

// ---- shared shapes ----

// The hat, for the watcher's navigation primitives (they read lx/ly/dir/id).
const selfOf = (hat) => hat;

// A field entity as `crowdAt` / `threatsTo` / `chooseWeaveDir` want one. Positions
// are visual, under the logical field names those primitives read — see the header.
function fieldEntity(e, over = {}) {
  return {
    id: e.id,
    lx: e.x,
    ly: e.y,
    dir: e.dir,
    anim: e.anim,
    mode: e.mode,
    moveSpeed: e.moveSpeed,
    flying: !!e.flying,
    entering: !!e.entering,
    hasHat: !!e.hasHat,
    observer: !!e.observer,
    ...over,
  };
}

// How dangerous it is to stand next to one of these. Not tuned so much as ordered:
// the two that travel fast are the two that floor him, which is the plan's "danger
// asymmetry does classification pressure" — and it is information the reactive-obs
// percept does not have, because speed needs two frames.
const HAZARD = Object.freeze({
  [MODE.ZOOMIES]: 0.5,
  [MODE.TUMBLER]: 0.25,
  [MODE.SPINNER]: 0.1,
  [MODE.MOONWALK]: 0.1,
  [MODE.HICCUP]: 0.1,
  [MODE.LOOP]: 0.1,
  [MODE.STARER]: 0.05,
  [MODE.SLEEPER]: 0.05,
});
const DEFAULT_HAZARD = 0.12; // what you assume when you cannot tell what it is

// ---- how much longer will this pay? ----
//
// The tier the whole anticipation economy rests on, and the oracle's real
// privilege. Getting it from the FSM's scratch takes a per-kind formula, so this is
// a second implementation of arithmetic that lives in `anomalies.js` — the thing
// `truth.js`'s header warns against. Three things make it safe rather than
// reckless:
//
//  1. **`truth.js`'s answer is not available.** Its exact `ttl` comes from a second
//     pass over the *same* episode; an oracle acting on it would change the episode
//     the label was computed from. Everything below reads the entity at the tick,
//     so it survives being acted on.
//  2. **`aTimer` alone is wrong**, which is not obvious and cost a debugging round:
//     it is the *sub-phase* countdown, not the anomaly's life. For a loop it says 8
//     ticks when 200 remain, so an oracle using it skipped every loop, moonwalk and
//     spinner — and scored *below* the strictly-less-informed reactive arm.
//  3. **A test holds it to the truth.** `test/percept.test.js` compares this against
//     `truth.js`'s exact `ttl` across a real episode, per kind. The duplication is
//     checked, not trusted.
//
// It is still deliberately imperfect where the sim is genuinely unknowable in
// advance: a spinner draws its stagger count only when the spin ends (the mean is
// used), and a zoomies ends early on a wall (the wall is projected, but the fence
// is not). An oracle, not an omniscience.
const MODE_REMAINING = {
  [MODE.SLEEPER]: grounded,
  [MODE.TUMBLER]: (e, cfg) => (e.aPhase === PHASE.T_SKID
    ? e.aTimer + e.aCount * cfg.tripEvery + cfg.fallTicks + cfg.tripDownTicks + cfg.standTicks
    : grounded(e, cfg)),
  [MODE.SPINNER]: (e, cfg) => (e.aPhase === PHASE.SP_SPIN
    // The stagger count is drawn when the spin ends, so its mean is the best any
    // reader of the current tick can do.
    ? e.aTimer + (e.aCount - 1) * cfg.spinEvery
      + ((cfg.staggerMin + cfg.staggerMax) / 2 + 1) * cfg.staggerEvery
    : e.aTimer + e.aCount * cfg.staggerEvery),
  [MODE.LOOP]: (e, cfg) => e.aTimer + e.aCount * cfg.loopEvery,
  [MODE.STARER]: (e) => e.aTimer,
  [MODE.ZOOMIES]: (e, cfg) => {
    if (e.aPhase !== PHASE.Z_DASH) return grounded(e, cfg);
    const toWall = stepsToWall(e, cfg, e.aHeading, cfg.zoomIncr);
    const dashes = Math.min(e.aCount, toWall);
    const crash = toWall <= e.aCount;
    return e.aTimer + dashes * cfg.zoomEvery
      + (crash ? cfg.fallTicks + cfg.zoomTumbleTicks + cfg.standTicks : 0);
  },
  [MODE.MOONWALK]: (e, cfg) =>
    e.aTimer + Math.min(e.aCount, stepsToWall(e, cfg, e.aHeading, cfg.step)) * cfg.moonEvery,
  [MODE.HICCUP]: (e, cfg) => {
    const cycle = 3 * cfg.hiccupStrideEvery + cfg.hiccupHopTicks;
    if (e.aPhase === PHASE.H_POP) return e.aTimer + (e.aCount - 1) * cycle;
    return e.aTimer + (2 - e.aStep) * cfg.hiccupStrideEvery + cfg.hiccupHopTicks
      + (e.aCount - 1) * cycle;
  },
};

// The shared fall → lie → stand-up tail (sleeper, tumbler, crashed zoomies).
function grounded(e, cfg) {
  if (e.aPhase === PHASE.G_FALL) return e.aTimer + e.aLie + cfg.standTicks;
  if (e.aPhase === PHASE.G_LIE) return e.aTimer + cfg.standTicks;
  return e.aTimer; // G_STAND
}

// How many `incr`-px moves along heading `dir` before the stage clamp stops it
// dead. `applyPos` commits each axis independently, so a diagonal is only blocked
// once BOTH axes are pinned — hence the max, not the min. The hero card is not
// modelled: a zoomies stopped by the card is one of the places the oracle is wrong.
function stepsToWall(e, cfg, dir, incr) {
  const lo = cfg.boundLower;
  const hiX = cfg.width + cfg.boundLower;
  const hiY = cfg.height + cfg.boundLower;
  let n = 0;
  const axis = (p, dv, min, max) => {
    if (!dv) return -1; // no component on this axis: never the thing that pins it
    return Math.max(0, Math.floor((dv > 0 ? max - p : p - min) / (Math.abs(dv) * incr)));
  };
  n = Math.max(axis(e.lx, AX[dir], lo, hiX), axis(e.ly, AY[dir], lo, hiY));
  return n < 0 ? Infinity : n;
}

export function remainingOf(e, cfg, state = null) {
  if (e.mode === MODE.STACK_BASE) {
    // The tower's clock is on state.stack, not the entity — and only once it is
    // actually parading; during assembly the parade has not been drawn yet.
    const s = state?.stack;
    if (s && s.phase === STACK_PHASE.PARADE) return Math.max(0, s.life - (state.tick - s.born));
    return (cfg.paradeMin + cfg.paradeMax) / 2;
  }
  const f = MODE_REMAINING[e.mode];
  return f ? Math.max(0, f(e, cfg)) : 0;
}

// The live, still-paying incidents, as the referee counts them (game.js).
function liveIncidents(state) {
  const out = [];
  for (const inc of state.incidents) {
    if (inc.expires <= state.tick) continue;
    const subject = inc.subject >= 0 ? state.entities.find((e) => e.id === inc.subject) : null;
    if (!incidentActive(state, inc, subject)) continue;
    out.push({ inc, subject });
  }
  return out;
}

const keyOf = (inc) => `${inc.subject}:${inc.born}`;

// ---- (1) the oracle: everything ----

// True state plus the incident feed plus every FSM's countdown. This is the plan's
// "privileged oracle (true state as input)" and it exists to be an upper bound, not
// a candidate for shipping — it reads a feed no deployed policy will ever have.
export const oracle = {
  describe: 'true state + the incident feed + every FSM countdown',
  init: () => ({}),
  read(state) {
    const cfg = state.cfg;
    const hat = hatOf(state);
    return {
      self: selfOf(hat),
      field: state.entities.map((e) => fieldEntity(e)),
      candidates: liveIncidents(state).map(({ inc, subject }) => ({
        key: keyOf(inc),
        lx: subject ? subject.x : inc.px,
        ly: subject ? subject.y : inc.py,
        tier: inc.tier,
        p: 1,
        age: state.tick - inc.born,
        remaining: subject ? remainingOf(subject, cfg, state) : cfg.cascadeIncidentTtl,
        certain: true, // the oracle's real privilege — see the header on `certain`
        hazard: subject ? (HAZARD[subject.mode] ?? DEFAULT_HAZARD) : DEFAULT_HAZARD,
      })),
    };
  },
};

// ---- (2) the memoryless twin, privileged: everything true, nothing temporal ----

// The same true state and the same feed, with every quantity that can only be known
// by having *watched* stripped out: how long this has been going, how long it has
// left, how fast anything is moving. What is left is exactly what a single frame of
// perfect vision would tell you.
//
// It strictly dominates any memoryless policy reading observations, so
// `oracle - reactiveTruth` is a **lower bound** on the memory gap: whatever that
// difference is, no 2-frame network can close it. That is the conservative number
// the gate should be read on, and `reactiveObs` below is the realistic one.
export const reactiveTruth = {
  describe: 'true state + feed, minus everything temporal (no age, no time left)',
  init: () => ({}),
  read(state) {
    const b = oracle.read(state);
    return {
      ...b,
      candidates: b.candidates.map((c) => ({ ...c, age: null, remaining: null, certain: false })),
    };
  },
};

// ---- (3) the memoryless twin, honest: one observation frame ----

// What the deployed policy will actually see, minus memory: the current frame's
// **visible** slots only. No incident feed — so "is this worth walking to" is a base
// rate off the drawn pose, and the flagship discrimination is simply unavailable: a
// sleeper and a freshly knocked panda are the same pixels and get the same number.
//
// The base rates below are measured, not invented — 12 × 12000-tick episodes per
// spec, counting for each drawn pose how often that panda was a paying incident:
//
//   pose      P(paying) natural   wild     what it is
//   carrying     1.00             1.00     a tower is standing on it: unmistakable
//   lifted       0.97             0.97     mid-hiccup pop: also unmistakable
//   down         0.21             0.08     a nap, a trip, a crash — or just run over
//   still        0.18             0.21     a starer, or the oblivious one idling
//   walking      0.10             0.05     a loop/moonwalk/zoomies, or anyone at all
//   riding       0.00             0.00     riders never pay; the incident is the base
//
// Re-measure with scratch tooling against `incidentActive` if the roster or the
// director's cadence ever moves. `natural` is used because it is the eval
// distribution; the `wild` column is there because the training distribution is
// meaningfully different and a policy fitted to one will be miscalibrated on the
// other. The gap between `down` at 0.21 and a sleeper's true 1.0 is the flagship
// certificate expressed as money.
export const POSE_PRIOR = Object.freeze({
  carrying: { p: 1.0, remaining: 600, tier: 2 },
  lifted: { p: 0.97, remaining: 120, tier: 1 },
  down: { p: 0.21, remaining: 150, tier: 1 },
  still: { p: 0.18, remaining: 155, tier: 1 },
  walking: { p: 0.10, remaining: 85, tier: 1 },
  riding: { p: 0.0, remaining: 0, tier: 1 },
});

const AT = Object.fromEntries(OBS_FIELDS.map((f) => [f.name, f.at]));
const POSE_AT = AT.pose;
const FACING_AT = AT.facing;

// Which pose class a decoded token is in. Deliberately the same partition the base
// rates were measured over, and deliberately only fields the encoder emits.
function poseClassOf(tok) {
  if (tok.riding || tok.flying) return 'riding';
  if (tok.carrying) return 'carrying';
  if (tok.lift > 0) return 'lifted';
  if (tok.anim === ANIM.FALL || tok.anim === ANIM.FALLEN || tok.anim === ANIM.STAND_UP) return 'down';
  if (tok.anim === ANIM.IDLE || tok.anim === ANIM.STOP) return 'still';
  return 'walking';
}

function decodeSlot(frame, slot, params, hat) {
  const base = (1 + slot) * OBS_WIDTH;
  if (!frame[base + AT.visible]) return null; // memoryless: a remembered slot is not a sighting
  const oneHot = (at, n) => {
    for (let i = 0; i < n; i++) if (frame[base + at + i]) return i;
    return 0;
  };
  return {
    slot,
    x: hat.x + frame[base + AT.relX] * params.sightRange,
    y: hat.y + frame[base + AT.relY] * params.sightRange,
    dist: frame[base + AT.dist] * params.sightRange,
    lift: frame[base + AT.lift],
    riding: !!frame[base + AT.riding],
    flying: !!frame[base + AT.flying],
    carrying: !!frame[base + AT.carrying],
    dir: oneHot(FACING_AT, 8),
    anim: oneHot(POSE_AT, 7),
  };
}

export function makeReactiveObs(obsParams = {}) {
  const observer = makeObserver(obsParams);
  return {
    describe: 'one observation frame — visible slots only, no feed, no memory',
    observer,
    init: () => ({ mem: observer.init() }),
    read(state, mem) {
      const cfg = state.cfg;
      const hat = hatOf(state);
      const frame = observer.observe(state, mem.mem);
      const seen = [];
      for (let s = 0; s < observer.layout.slots; s++) {
        const tok = decodeSlot(frame, s, observer.params, hat);
        if (tok) seen.push(tok);
      }

      // Unknown kind, so unknown speed: every stranger is assumed to walk at the
      // mean cadence. A zoomies bearing down reads as an ordinary roamer, which is
      // precisely the reflex handicap that having no second frame imposes.
      const meanSpeed = Math.round(cfg.moveSpeeds.reduce((a, b) => a + b, 0) / cfg.moveSpeeds.length);
      const field = [
        fieldEntity(hat, { lx: hat.lx, ly: hat.ly }),
        ...seen.map((t) => ({
          id: 1000 + t.slot, // slots have no stable panda identity to a memoryless reader
          lx: t.x,
          ly: t.y,
          dir: t.dir,
          anim: t.anim,
          mode: t.anim === ANIM.FALLEN || t.anim === ANIM.FALL ? MODE.KNOCKED : MODE.WANDER,
          moveSpeed: meanSpeed,
          flying: t.flying,
          entering: false,
          hasHat: false,
          observer: false,
        })),
      ];

      const candidates = [];
      for (const t of seen) {
        const cls = poseClassOf(t);
        const prior = POSE_PRIOR[cls];
        if (prior.p <= 0) continue;
        candidates.push({
          key: `slot:${t.slot}`,
          lx: t.x,
          ly: t.y,
          tier: prior.tier,
          p: prior.p,
          age: null,
          // A measured base rate off the drawn pose, which is a guess and is flagged
          // as one — the pose says what this probably is, never how long it has left.
          remaining: prior.remaining,
          certain: false,
          hazard: DEFAULT_HAZARD,
        });
      }
      return { self: selfOf(hat), field, candidates };
    },
  };
}

export const reactiveObs = makeReactiveObs();

export const PERCEPTS = Object.freeze({ oracle, reactiveTruth, reactiveObs });
