// Constructed episodes — the controlled experiment a certificate is made of.
//
// C3 of design/panda-policy-net.md. Everything in Phase C up to here has been a
// *score over a corpus*: 24 draws of the live distribution, read as a mean and a
// standard error. That instrument answers "how much is this information worth on
// average" and it cannot answer the question C3 asks, which is "can this policy
// tell these two situations apart **at all**". For that you need two worlds that
// agree on every pixel and disagree on the answer, and the live distribution does
// not hand you those — you build them.
//
// So this module builds a stage rather than sampling one: a config, a hand-placed
// roster, the three directors silenced, and a script that injects the one event the
// experiment is about. Nothing here is a corpus, nothing here is training data; a
// scenario is an instrument, and the numbers it produces are certificates, not
// scores.
//
// ## Three properties the design hangs on
//
// 1. **It is the shipped engine.** `makeEngine` builds the state; the roster is the
//    ordinary `makeEntity` shape; the anomaly is started through `startAnomaly` and
//    the knock through `beginKnock`. A scenario that reimplemented a nap would be
//    measuring my arithmetic, not the sim's.
// 2. **The directors are silenced, not removed.** Their clocks are pushed past the
//    end of time (`QUIET`) rather than the machinery being bypassed, so a scenario
//    is a legal state that `step` treats exactly like any other — and if the tier-1
//    director ever grew a second entry point, this would still be a controlled
//    stage or would fail loudly.
// 3. **The hat is frozen until the decision tick.** The policy is consulted every
//    decision tick from the first — so a policy with memory sees the whole lead-in,
//    which is where the answer lives — but its action is discarded and replaced
//    with HOLD until `decideAt`. Without that the two arms would diverge during the
//    lead-in (in one of them there is already something worth walking to), and by
//    the decision tick the frames would no longer match. Freezing him is what makes
//    "identical in every current observable" a property that can be *asserted*
//    rather than hoped for.
//
// ## The measurement
//
// `approach` — the fraction of the closable distance to the site that the hat
// closed during the window. 1 = he arrived, 0 = he never moved toward it (or moved
// away). It is used in place of the game's own attendance for one reason: an arm
// can stop paying mid-window (a stale nap ends), and the certificate is about what
// he *committed to* at the decision tick, not about what the commitment turned out
// to be worth. Attendance is reported alongside it anyway, because a statistic with
// no second opinion is a statistic nobody checks.

import { makeEngine } from '../assets/pandas/engine/engine.js';
import { TICKS_PER_ACTION } from '../assets/pandas/engine/tick.js';
import { ACTION } from '../assets/pandas/engine/actions.js';
import {
  MODE, ANIM, makeEntity, resetObserveBrain,
} from '../assets/pandas/engine/state.js';
import { initDirector } from '../assets/pandas/engine/director.js';
import { initStack } from '../assets/pandas/engine/stack.js';
import { initCascade } from '../assets/pandas/engine/cascade.js';
import { makeObserver } from '../assets/pandas/engine/policy/obs.js';
import { hypot } from '../assets/pandas/engine/mathx.js';
import { bindPolicy, hatOf } from './rollout.js';
import { DEFAULT_RULES } from './game.js';

// A clock that never strikes. Used for the three directors' next-fire ticks and for
// a parked roamer's stride timer: a scenario runs for a few hundred ticks, so a
// value this far out is "never" without introducing an Infinity that would poison
// arithmetic elsewhere in state.
export const QUIET = 1e9;

// The stage every twin is built on. A bare room: no hero card (so nothing occludes
// and nothing has to be routed around), no entrance, and roomy enough that a 400px
// bearing in any of the 8 directions stays well inside the walls.
//
// `impact` is 85 rather than the shipped 80, and that is load-bearing. A knock
// carries its slide across `fallTicks` = 17 ticks as `slide / fallTicks` per tick;
// 85/17 = 5 exactly, so the knocked panda lands on precisely the pixel the sleeping
// twin was placed at, with no float residue to make the two frames differ in the
// last bit. The battery asserts the frames match rather than trusting this, but a
// scenario that has to be lucky is a scenario that will one day not be.
export const STAGE = Object.freeze({
  width: 1240,
  height: 900,
  forbid: null,
  entrance: false,
  impact: 85,
});

// ---- building a stage ----

// A state the engine will accept, with an empty field and every director asleep.
// `seed` only ever feeds the sim's own draws (collisions, the expert's brain); the
// scenario's own randomness lives on a separate stream, so the two arms of a twin
// can differ in what they inject without their sim streams drifting apart.
export function makeStage(overrides = {}, seed = 1) {
  const engine = makeEngine({ ...STAGE, ...overrides });
  const cfg = engine.cfg;
  const state = {
    tick: 0,
    rng: seed | 0,
    cfg,
    entities: [],
    director: { ...initDirector(cfg), nextAt: QUIET },
    stack: { ...initStack(cfg), nextAt: QUIET },
    cascade: { ...initCascade(cfg), nextArmAt: QUIET },
    incidents: [],
  };
  return { engine, state, cfg };
}

// The hat panda, planted and watching. `dir` is his initial facing, which matters
// more here than anywhere else in the project: the observation cone is 120° about
// it, so a subject placed behind him is a subject no memoryless arm can price.
export function addHat(state, x, y, dir = 0) {
  const cfg = state.cfg;
  const hat = makeEntity(state.entities.length, x, y, {
    hasHat: true, moveSpeed: cfg.hatMove, dir,
  });
  hat.mode = MODE.OBSERVING;
  hat.anim = ANIM.IDLE;
  resetObserveBrain(hat, cfg);
  state.entities.push(hat);
  return hat;
}

// An ordinary roamer. `parked` is the default: its stride timer is set past the end
// of time, so it stands where it was placed and — the part that matters — draws
// nothing from the sim's PRNG. A scenario with a wandering extra in it is a
// scenario whose two arms drift apart for reasons that have nothing to do with the
// experiment.
export function addRoamer(state, x, y, { dir = 0, parked = true, moveSpeed = 18 } = {}) {
  const e = makeEntity(state.entities.length, x, y, { dir, moveSpeed });
  e.mode = MODE.WANDER;
  e.anim = parked ? ANIM.IDLE : ANIM.WALK;
  e.moveTimer = parked ? QUIET : moveSpeed;
  state.entities.push(e);
  return e;
}

// ---- running one ----

// One constructed episode. `script(state, tick)` runs immediately after each step
// and may mutate the fresh state — that is how an event is injected at an exact
// tick, and the only way a scenario differs from an ordinary rollout.
//
// `freezeUntil` holds the hat at HOLD through the lead-in while still consulting
// the policy, so a policy that remembers has seen everything by the time it is
// allowed to move. `onTick` is called after the script with the settled state.
export function runScenario({
  engine, state: state0, policy = null, ticks, script = null, freezeUntil = 0, onTick = null,
}) {
  const ctx = { seed: state0.rng, cfg: engine.cfg, ticks, stride: 1, warmup: 0 };
  const act = bindPolicy(policy, ctx);
  let state = state0;
  for (let t = 1; t <= ticks; t++) {
    let action = null;
    if (act && t % TICKS_PER_ACTION === 0) {
      const chosen = act(state, t);
      // Consulted either way — the policy's own memory advances on the lead-in it
      // is not allowed to act on. Frozen means the hand is held, not the eyes shut.
      action = t <= freezeUntil ? ACTION.HOLD : chosen;
    } else if (t <= freezeUntil) {
      action = ACTION.HOLD;
    }
    state = engine.step(state, action);
    if (script) script(state, t);
    if (onTick) onTick(state, t);
  }
  return state;
}

// ---- the measurement ----

// Watch one arm and report what the hat did about `site` over the measurement
// window. `site` is a fixed point, captured at the decision tick rather than
// tracked: in more than one twin the subject gets up and walks off mid-window, and
// a statistic that followed it would be measuring the world's behaviour instead of
// the policy's.
export function siteTracker(site, { from, to, viewRadius = DEFAULT_RULES.viewRadius }) {
  let d0 = null;
  let dmin = Infinity;
  let dend = null;
  let inRadius = 0;
  let ticks = 0;
  return {
    tick(state, t) {
      if (t < from || t > to) return;
      const hat = hatOf(state);
      const d = hypot(hat.x - site.x, hat.y - site.y);
      if (d0 === null) d0 = d;
      if (d < dmin) dmin = d;
      dend = d;
      if (d <= viewRadius) inRadius += 1;
      ticks += 1;
    },
    report() {
      // The closable distance: how much of the trip is actually his to make. A site
      // he is already standing on has none, so the ratio is defined to 1 there —
      // he has already arrived, and there is nothing to fail to do.
      const closable = Math.max(0, (d0 ?? 0) - viewRadius);
      const closed = Math.max(0, (d0 ?? 0) - dmin);
      return {
        startDist: d0 ?? 0,
        minDist: dmin === Infinity ? 0 : dmin,
        endDist: dend ?? 0,
        approach: closable <= 0 ? 1 : Math.min(1, closed / closable),
        attend: ticks ? inRadius / ticks : 0,
        inRadius,
        ticks,
      };
    },
  };
}

// ---- the identity check ----
//
// A twin's whole claim is that its two arms are the same picture. That claim is
// worth exactly as much as the check behind it, so the battery re-derives it on
// every run rather than resting on the geometry having been right when it was
// written. Both arms are run with the hat held still for the whole episode — the
// policy under test is not in the loop, because a policy that has already
// discriminated moves, and a moved hat sees a different frame for an honest reason.

export function frameAt({ build, decideAt }) {
  const observer = makeObserver();
  const mem = observer.init();
  let frame = null;
  const { engine, state, script } = build();
  runScenario({
    engine,
    state,
    script,
    ticks: decideAt,
    freezeUntil: decideAt,
    policy: { init: () => () => ACTION.HOLD },
    onTick: (s, t) => {
      // Advance the sensor every decision tick, so slot memory is bound exactly as
      // a policy's would be, and keep the frame from the tick under test.
      if (t % TICKS_PER_ACTION !== 0) return;
      const f = observer.observe(s, mem);
      if (t === decideAt) frame = f.slice();
    },
  });
  if (!frame) {
    throw new Error(`decideAt=${decideAt} is not a decision tick (must be a multiple of ${TICKS_PER_ACTION})`);
  }
  return frame;
}

// Where two frames first disagree, as `{ token, field, a, b }`, or null if they
// are identical. Naming the field is the difference between a failing assertion
// and a debuggable one.
export function frameDiff(a, b, layout) {
  if (a.length !== b.length) return { token: -1, field: 'length', a: a.length, b: b.length };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const token = Math.floor(i / layout.width);
    const off = i - token * layout.width;
    const f = layout.fields.find((x) => off >= x.at && off < x.at + x.size);
    return {
      token,
      field: f ? (f.size > 1 ? `${f.name}[${off - f.at}]` : f.name) : `col${off}`,
      a: a[i],
      b: b[i],
    };
  }
  return null;
}
