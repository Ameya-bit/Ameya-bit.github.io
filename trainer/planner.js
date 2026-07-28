// One planner, run on three different beliefs — the body of the yardstick gate.
//
// C2 of design/panda-policy-net.md. The plan wants a privileged oracle and a
// memoryless twin whose score difference is the **memory gap**, the quantity that
// says how much of this game can only be won by inferring hidden state. The danger
// in building two bots is that the gap you measure is the gap between how well you
// wrote them. So there is one bot here, and it is handed a `belief` by a percept
// (`percept.js`); the three percepts differ only in what they may read.
//
// It plays the game `game.js` scores rather than imitating the watcher: it prices
// every candidate as an expected number of points, walks to the best one, and
// leaves when the arithmetic says to. Character is not a consideration — this is an
// instrument, not a ship candidate. If a yardstick ever ends up on the homepage,
// something has gone badly wrong.
//
// ## The wager
//
// For each candidate, with travel time t and `banked` ticks already collected:
//
//   mult  = tau / (tau + age + t)              the arrival multiplier it will lock in
//   dwell = min(remaining - t, dwellCap)        how long it will still be paying
//   pay   = p * mult * dh * ln((dh + banked + dwell) / (dh + banked))
//   cost  = stepCost * (dist / step) + knockPenalty * hazard
//   value = pay - cost
//
// `pay` is the exact integral of the game's own diminishing-returns curve, so the
// planner is not approximating the reward it is scored on — it is reading it. That
// is the point: the oracle must be limited by *information*, not by a mismatch
// between what it optimises and what it is paid.
//
// Everything that varies between the three arms enters through `p`, `age`,
// `remaining` and `hazard`. With no `age` it substitutes the mean age of a live
// incident; with no `remaining`, the pose prior. It never finds out whether the
// substitution was right — which is what not having a world model means.
//
// ## ⚠️ It paces itself, because nothing else will
//
// `applyHatAction` executes a STEP as one 50px stride, immediately, with no cadence
// check: pacing lives in the policy by design (the engine README says so). The
// consequence, measured: a policy that emits STEP every decision tick travels **25
// px/tick — 5.5× the expert and 2.5× a zoomies** — and no term in the game prices
// it, because the movement cost is per stride and so per *pixel*, not per second.
// A yardstick that exploited that would be measuring a different game from the one
// the deployed policy plays, so `strideEvery` holds it to the expert's cadence. The
// exploit itself is real and is measured separately (`speeder` in policies.js).

import { hypot } from '../assets/pandas/engine/mathx.js';
import { AX, AY } from '../assets/pandas/engine/dirs.js';
import { ACTION, stepAction, rollAction } from '../assets/pandas/engine/actions.js';
import {
  bestAxis, bestEscape, chooseWeaveDir, threatsTo, threatSpeed,
} from '../assets/pandas/engine/watcher.js';
import { makeRules } from './game.js';

export const DEFAULT_PLANNER = Object.freeze({
  // Standoff to hold. Inside `viewRadius` with room to spare, so a subject drifting
  // a little does not stop the pay.
  standoff: 140,
  // How long one visit is worth planning for. Past ~15 s the decay curve has
  // flattened and the honest answer is "and then I will re-decide".
  dwellCap: 300,
  // A rival must beat the held target by this many points to steal it. Without it
  // the planner dithers between two near-equal candidates and walks between them,
  // scoring less than either would have paid. (`stickyTicks` is the expert's
  // version of the same idea.)
  switchMargin: 6,
  // Ticks between strides. null = the hat's own cadence (`cfg.hatMove`, 11) — see
  // the header. A number overrides it, which is how the speed exploit is priced.
  strideEvery: null,
  // Substituted when the percept cannot supply the real thing.
  priorAge: 120, // mean age of a live incident, in ticks
  priorRemaining: 150,
});

// Expected points from `dwell` ticks at multiplier `mult`, starting `banked` ticks
// in — the integral of the game's `1 / (1 + banked/dh)` decay. Closed form, so
// pricing a 300-tick visit costs no more than a 1-tick one.
function payFor(rules, mult, banked, dwell) {
  const dh = rules.diminishHalf;
  return rules.viewPay * mult * dh * Math.log((dh + banked + dwell) / (dh + banked));
}

// The dive-roll, on the same trigger the expert uses — but reading the *belief's*
// field, not the world. That is where the reactive-obs arm pays for having no
// second frame: a zoomies it cannot identify reads as an ordinary roamer, `fast`
// never fires, and it only rolls once something is already on top of it.
function reflex(belief, state, cfg) {
  const hat = belief.self;
  if (state.tick < hat.rollReadyAt) return -1;
  const near = threatsTo(hat, cfg.hatDangerR, belief.field, cfg);
  if (!near.length) return -1;
  const fast = near.some((q) => threatSpeed(q, cfg) >= cfg.hatFastSpeed);
  const crowd = threatsTo(hat, cfg.hatRollR, belief.field, cfg).length >= 2;
  const panic = threatsTo(hat, cfg.hatPanicR, belief.field, cfg).length >= 1;
  if (!(fast || crowd || panic)) return -1;
  const dir = bestEscape(hat, near, cfg.rollDist, false, belief.field, cfg);
  return dir >= 0 ? rollAction(dir) : -1;
}

// Price one candidate. Returns null when the trip cannot pay at all.
function appraise(c, hat, cfg, rules, opts, banked) {
  const dist = hypot(c.lx - hat.lx, c.ly - hat.ly);
  const walk = Math.max(0, dist - opts.standoff);
  // Travel time at his own stride cadence. Not the weave's true path length (which
  // detours around bodies and the card), but the error is identical across arms.
  const travel = walk / (cfg.step / hat.moveSpeed);
  const age = (c.age ?? opts.priorAge) + travel;
  const remaining = (c.remaining ?? opts.priorRemaining) - travel;
  if (remaining <= 0) return null; // over before he arrives

  const mult = Math.max(rules.minArrivalMult, rules.anticipationTau / (rules.anticipationTau + age));
  const dwell = Math.min(remaining, opts.dwellCap);
  const capRoom = Math.max(0, rules.incidentCap - banked * rules.viewPay);
  const pay = Math.min(c.p * payFor(rules, mult, banked, dwell), capRoom);
  const cost = rules.stepCost * (walk / cfg.step) + rules.knockPenalty * c.hazard;
  return { c, value: pay - cost, dist };
}

// ---- the policy ----

export function makePlanner({ percept, rules = {}, options = {} } = {}) {
  const r = makeRules(rules);
  const o = { ...DEFAULT_PLANNER, ...options };

  return {
    describe: `planner over: ${percept.describe}`,
    percept,
    options: o,
    init(ctx) {
      const mem = percept.init(ctx.cfg);
      const cadence = o.strideEvery ?? ctx.cfg.hatMove;
      // The planner's own bookkeeping — deliberately available to every arm; see
      // percept.js on the one generosity.
      const banked = new Map();
      let held = null; // key of the candidate it is walking to / standing at
      let nextStrideAt = 0;

      return (state, tick) => {
        const cfg = state.cfg;
        const belief = percept.read(state, mem);
        const hat = belief.self;

        // The reflex is checked every decision tick, ahead of the stride cadence —
        // an escape you have to wait for is not an escape.
        const roll = reflex(belief, state, cfg);
        if (roll >= 0) return roll;

        // Price everything he can see.
        let best = null;
        let heldNow = null;
        for (const c of belief.candidates) {
          const a = appraise(c, hat, cfg, r, o, banked.get(c.key) ?? 0);
          if (!a) continue;
          if (c.key === held) heldNow = a;
          if (!best || a.value > best.value) best = a;
        }
        let target = heldNow;
        if (!target || (best && best.value > heldNow.value + o.switchMargin)) target = best;
        if (target && target.value <= 0) target = null; // nothing is worth the trip
        held = target ? target.c.key : null;

        // Standing inside the pay radius: bank the tick. This is bookkeeping about
        // his own behaviour, not about the world (percept.js, "one generosity").
        if (target && target.dist <= r.viewRadius) {
          banked.set(held, (banked.get(held) ?? 0) + 1);
        }

        if (tick < nextStrideAt) return ACTION.HOLD; // between strides: glide only

        if (!target) {
          // Nothing worth watching. Stand still rather than amble: a stride costs
          // points and an aimless one buys none. The expert ambles here and is
          // charged for it — one of the places the yardstick is not a character.
          return ACTION.HOLD;
        }

        // Inside the pay radius with a stride's margin: hold the vantage, stepping
        // aside only for something drifting into him.
        if (target.dist <= r.viewRadius - cfg.step * 0.5) {
          const drifters = threatsTo(hat, cfg.hatSidestepR, belief.field, cfg);
          const aside = drifters.length
            ? bestEscape(hat, drifters, cfg.step, true, belief.field, cfg) : -1;
          if (aside < 0) return ACTION.HOLD;
          // …but never out of the money: a sidestep that ends the pay is worse than
          // the bump it avoids.
          const nx = hat.lx + AX[aside] * cfg.step;
          const ny = hat.ly + AY[aside] * cfg.step;
          if (hypot(target.c.lx - nx, target.c.ly - ny) > r.viewRadius) return ACTION.HOLD;
          nextStrideAt = tick + cadence;
          return stepAction(aside);
        }

        // Walk to a vantage: the same axis choice the expert makes (on stage, clear
        // line of sight, uncrowded), then one weave step toward it.
        const subject = { lx: target.c.lx, ly: target.c.ly };
        const axis = bestAxis(subject, hat, o.standoff, -1, belief.field, cfg);
        const tx = subject.lx + AX[axis] * o.standoff;
        const ty = subject.ly + AY[axis] * o.standoff;
        const dir = chooseWeaveDir(hat, tx, ty, belief.field, cfg);
        if (dir < 0) return ACTION.HOLD; // boxed in — let a body pass
        nextStrideAt = tick + cadence;
        return stepAction(dir);
      };
    },
  };
}
