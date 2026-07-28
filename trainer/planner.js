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
//   owed  = max(0, dwellMin - run)             commitment still to be earned (C4)
//   pC    = P(it outlives owed + t)            1 if the countdown is *known*
//   dwell = min(remaining - t, dwellCap)       how long it will still be paying
//   pay   = p * pC * mult * dh * ln((dh + banked + dwell) / (dh + banked))
//   cost  = stepCost * (dist / step) + knockPenalty * hazard
//   value = pay - cost
//
// `pay` is the exact integral of the game's own diminishing-returns curve, so the
// planner is not approximating the reward it is scored on — it is reading it. That
// is the point: the oracle must be limited by *information*, not by a mismatch
// between what it optimises and what it is paid. Two corollaries, both learned by
// getting them wrong (see `init` and `appraise`): it must price the rules of the
// episode it is *in*, not the defaults it was constructed with; and its book must
// be kept in the referee's units, engine ticks.
//
// Everything that varies between the three arms enters through `p`, `age`,
// `remaining`, `certain` and `hazard`. With no `age` it substitutes the mean age of
// a live incident; with no `remaining`, the pose prior — and, crucially, it then
// treats that substitute as a *distribution to bet against* rather than a fact. It
// never finds out whether the substitution was right, which is what not having a
// world model means.
//
// ## Pacing is the engine's now, not this file's
//
// Through C3 this header carried a warning that `applyHatAction` had no cadence
// check, so a yardstick had to pace itself or it would measure a game no deployed
// policy plays. C4 measured that hole (`speeder`, +26% over the oracle; `roller`,
// +22% and knock-proof) and closed it in the body — `limitAction` in the engine's
// hat.js. So `strideEvery` no longer restrains anything; it only decides how often
// this asks. The default is the cadence the engine actually grants (`hatAlert`),
// because a yardstick held to the *calm* cadence understates both ceilings — worth
// +19% of score under the C4 economy — while a deployed policy is free to hurry.

import { hypot } from '../assets/pandas/engine/mathx.js';
import { AX, AY } from '../assets/pandas/engine/dirs.js';
import { ACTION, stepAction, rollAction } from '../assets/pandas/engine/actions.js';
import { TICKS_PER_ACTION } from '../assets/pandas/engine/tick.js';
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
  // Ticks between asking for a stride. null = the cadence the engine grants
  // (`cfg.hatAlert`, 8). A number overrides it — which no longer buys speed, since
  // `limitAction` caps it, and is now how the *regression* bot asks too hard.
  strideEvery: null,
  // How it travels. 'step' is a stride; 'roll' emits the same heading as a dive-roll
  // instead, which is the *second* action-space hole: `applyHatAction` calls
  // `startRoll` with no `rollReadyAt` check, so the cooldown — like the cadence —
  // is policy-side and a policy can simply decline to honour it. A roll carries
  // 92px over 5 ticks and the collision pass skips ROLLING outright, so travelling
  // this way is both faster than walking and *invulnerable*. Priced as `roller`.
  travel: 'step',
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

// The arrival multiplier the referee locks in, from a belief about `age`.
const multFor = (rules, age) =>
  Math.max(rules.minArrivalMult, rules.anticipationTau / (rules.anticipationTau + age));

// What the planner remembers about its own visits to one incident — deliberately a
// mirror of the referee's per-incident record in `game.js`, in the same units
// (engine ticks), because a planner keeping a *different* book from the one it is
// paid out of is optimising something other than the game.
const NO_VISIT = Object.freeze({ banked: 0, run: 0, released: false, locked: null, lastTick: -99 });

// Price one candidate. Returns null when the trip cannot pay at all.
function appraise(c, hat, cfg, rules, opts, v) {
  const dist = hypot(c.lx - hat.lx, c.ly - hat.ly);
  const walk = Math.max(0, dist - opts.standoff);
  // Travel time at his own stride cadence. Not the weave's true path length (which
  // detours around bodies and the card), but the error is identical across arms.
  const travel = walk / (cfg.step / hat.moveSpeed);
  const age = (c.age ?? opts.priorAge) + travel;
  const est = c.remaining ?? opts.priorRemaining;
  const remaining = est - travel;
  if (c.certain && remaining <= 0) return null; // over before he arrives

  // Locked at first pay and never revised — so a visit already under way is priced
  // at the rate he actually secured, not at what a fresh arrival would get now.
  const mult = v.locked ?? multFor(rules, age);

  // **The dwell, and the whole of C4.** Until the commitment completes, this trip is
  // worth nothing unless the incident outlives his arrival by what he still owes.
  // That is where a belief about time-remaining stops being decoration and starts
  // deciding. With `dwellMin: 0` the term vanishes and this is C1's wager exactly.
  const owed = v.released ? 0 : Math.max(0, rules.dwellMin - v.run);

  // ⚠️ **A guess is not a short countdown — it is an unknown one**, and the
  // difference decides whether this gate is fair. An arm with no clock substitutes
  // `priorRemaining`; treating that point estimate as if it were *known* makes the
  // comparison `est - travel < dwellMin` a hard refusal, and at the C4 defaults
  // (dwell 120, prior 150) that refuses every trip costing more than 30 ticks of
  // travel. The clockless arm went catatonic — it stopped walking to the flagship
  // twin battery's sleeper at all — and the conservative gap it produced was mostly
  // that paralysis. So an uncertain arm bets on the *survival probability* instead,
  // memoryless with mean `est`, which is the right shape for a reader that cannot
  // tell how long a thing has been going. It goes, discounted, and finds out by
  // winning or losing. Erring this way keeps the measured gap conservative, which is
  // the direction percept.js says a gate must err in.
  const pComplete = c.certain ? 1 : Math.exp(-(owed + travel) / Math.max(1, est));
  if (c.certain && remaining < owed) return null;

  const dwell = Math.min(c.certain ? remaining : owed + est, opts.dwellCap);
  const capRoom = Math.max(0, rules.incidentCap - v.banked * rules.viewPay);
  let gross = payFor(rules, mult, v.banked, dwell);
  if (!v.released) {
    // Staying recovers what this visit has already banked into escrow; walking away
    // forfeits it. That recovery is the switching cost the dwell creates, and it
    // belongs in the held target's value rather than in a term of its own.
    gross += payFor(rules, mult, v.banked - v.run, v.run) + rules.arrivalPay * mult;
  }
  const pay = Math.min(c.p * pComplete * gross, capRoom);
  const cost = rules.stepCost * (walk / cfg.step) + rules.knockPenalty * c.hazard;
  return { c, value: pay - cost, dist };
}

// ---- the policy ----

export function makePlanner({ percept, rules = {}, options = {} } = {}) {
  const fallback = makeRules(rules);
  const o = { ...DEFAULT_PLANNER, ...options };

  return {
    describe: `planner over: ${percept.describe}`,
    percept,
    options: o,
    init(ctx) {
      // ⚠️ **Price the game it is actually being scored under**, which `runEpisode`
      // hands down as `ctx.rules`. A planner built once against `DEFAULT_RULES` and
      // then run under `--rules` is optimising a different game from the one the
      // referee is paying out of, and the difference is invisible — it just quietly
      // stops being an oracle. That was a real bug: it made every C2 knob sweep
      // ("the conservative gap stays at ~5% under everything") a measurement of
      // policies that never saw the knob, and it hid the effect of C4's `dwellMin`
      // completely, right down to identical stride and knock costs at every setting.
      // Construction-time `rules` survive only as a fallback for a standalone run.
      const r = ctx.rules ?? fallback;
      const mem = percept.init(ctx.cfg);
      // The cadence the *engine* permits (`limitAction`, hat.js), not the expert's
      // calm one. Through C3 this was `hatMove` (11) on the reasoning that a
      // yardstick pacing itself faster would measure a different game from the one a
      // deployed policy plays. C4 closed the speed hole and thereby inverted that
      // argument: a deployed policy may legally stride every `hatAlert` (8) ticks —
      // it has to be able to, or a BC clone could not reproduce the expert's own
      // alert strides out of the corpus it was cut from — so a yardstick held to 11
      // is the one measuring a game nobody plays, and it *understates* both ceilings.
      // Measured under the C4 economy, that understatement was worth +19% of score.
      const cadence = o.strideEvery ?? ctx.cfg.hatAlert;
      // How a travel heading leaves the body. See `travel` above.
      const go = o.travel === 'roll' ? rollAction : stepAction;
      // The planner's own bookkeeping — deliberately available to every arm; see
      // percept.js on the one generosity.
      const visits = new Map();
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
          const a = appraise(c, hat, cfg, r, o, visits.get(c.key) ?? NO_VISIT);
          if (!a) continue;
          if (c.key === held) heldNow = a;
          if (!best || a.value > best.value) best = a;
        }
        let target = heldNow;
        if (!target || (best && best.value > heldNow.value + o.switchMargin)) target = best;
        if (target && target.value <= 0) target = null; // nothing is worth the trip
        held = target ? target.c.key : null;

        // Standing inside the pay radius: bank the ticks. This is bookkeeping about
        // his own behaviour, not about the world (percept.js, "one generosity").
        //
        // Counted in **engine ticks**, which is what the referee counts and what
        // `diminishHalf` and `dwellMin` are denominated in — the planner is consulted
        // once per decision tick and so covers `TICKS_PER_ACTION` of them at a time.
        // (Through C3 this incremented by 1 and the planner therefore believed every
        // visit was half as long as it was; harmless to the *gap*, since all three
        // arms shared the error, but it made the dwell arithmetic meaningless.)
        if (target && target.dist <= r.viewRadius) {
          let v = visits.get(held);
          if (!v) { v = { ...NO_VISIT }; visits.set(held, v); }
          if (tick - v.lastTick > r.dwellGrace) v.run = 0; // the visit lapsed — see game.js
          v.locked ??= multFor(r, target.c.age ?? o.priorAge);
          v.lastTick = tick;
          v.run += TICKS_PER_ACTION;
          v.banked += TICKS_PER_ACTION;
          if (!v.released && v.run >= r.dwellMin) v.released = true;
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
          return go(aside);
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
        return go(dir);
      };
    },
  };
}
