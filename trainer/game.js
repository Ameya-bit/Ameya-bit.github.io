// The viewing game — the only thing in this project that says what "good" means.
//
// C1 of design/panda-policy-net.md. Phase B built the machine that produces
// episodes; this scores one. Nothing here is ever loaded by a page: **the live site
// never computes score**, and it never will. The hat panda's job on the homepage is
// to look like he is watching; score is the trainer's opinion about whether he
// actually was.
//
// ## The base game
//
//   + viewPay per tick, per live incident, while he stands within `viewRadius` of it
//   - knockPenalty each time he is floored
//   - a small cost per stride, a larger one per dive-roll
//
// ## What every other rule here exists to do
//
// The plan's frame (its "necessity" half): a score that a *reactive* policy can
// reach is a score that proves nothing. Every knob below moves money out of
// reaction and into inference, and each one is a knob rather than a constant
// because Phase C's whole job is to turn them until the memory gap opens:
//
//  - **Anticipation, not presence** (`anticipationTau`). Pay for an incident is
//    fixed at the moment he first arrives, scaled by how *late* he was to it. A
//    stroll over to a nap that is nearly over earns nearly nothing, so the wager is
//    on time-remaining — the duration posterior — rather than on what is visible now.
//  - **Diminishing returns + a cap** (`diminishHalf`, `incidentCap`). Camping one
//    body forever is structurally worthless rather than penalised after the fact
//    (the literature is blunt that per-tick proximity rewards breed parking
//    equilibria; the fix is the reward's shape). This is also principle #3 of
//    panda-chaos.md, mechanised: he watches a while, then moves on.
//  - **A movement cost** (`stepCost`). Sharpens every trip into a wager instead of
//    a free option.
//  - **Danger asymmetry is not a rule.** It falls out: approaching a zoomies risks
//    `knockPenalty` and a sleeper is free, so kind-inference is consulted
//    continuously without a term for it.
//
// ## Two decisions that look small and are not
//
// **Ordinary knocks pay nothing.** Only the three directors post incidents; a panda
// felled by a collision is just a panda on the ground. That is deliberate and it is
// the keystone of the flagship twin-episode certificate: a sleeper and a freshly
// knocked panda are pixel-identical (pinned by a test in the engine's obs suite),
// one is worth points and the other is worth none, and only event memory separates
// them. If knocks paid, that certificate would be worthless.
//
// **`inc.abandoned` is ignored here** — deliberately, though `watcher.js`'s own
// `isLive` honours it. That flag is the *rules expert's* bookkeeping, set when it
// gives up on a subject, and it is never set at all when a policy drives (the
// expert does not run). Scoring through it would mean two policies playing two
// different games. The pay window is `expires > tick` plus the behaviour actually
// being live.
//
// ## What the scorer may read
//
// Everything. It is privileged by construction — it reads modes, the incident
// queue, true positions. It is the *referee*, not a player: no policy ever sees a
// score, and the reward it emits is a number per episode, not a per-tick signal a
// reactive agent could climb. (Phase E's PPO does see per-tick reward; the same
// ledger produces it, which is why the components are kept separately.)

import { MODE, POINT_SUBJECT } from '../assets/pandas/engine/state.js';
import { TICKS_PER_ACTION } from '../assets/pandas/engine/tick.js';
import { isStep, isRoll } from '../assets/pandas/engine/actions.js';
import { sq } from '../assets/pandas/engine/mathx.js';
import { hatOf } from './rollout.js';

// Bumped whenever a rule changes what a number means, so a stored score can never
// be compared across a rules change by accident.
export const GAME_VERSION = 3; // C5: the risk economy re-priced (knockPenalty 40 → 20)

export const DEFAULT_RULES = Object.freeze({
  // --- the pay ---
  // How close counts as watching. The expert's own study standoff is
  // `inspectNear` = 140, so this leaves him room to hold a vantage and still be
  // paid — the reward must not fight the character.
  viewRadius: 180,
  // Points per tick, per attended incident, before every multiplier below. The
  // unit of the whole economy: everything else is denominated in view-ticks.
  viewPay: 1,
  // Pay every incident in range, or only the best one? Paying all of them is the
  // honest reading of "+points per tick within R_VIEW of an anomalous panda" — and
  // it leaves the R_VIEW-intersection parking exploit open on purpose, so C2's
  // exploit bots have something to find. Flip it to close the exploit structurally.
  payAll: true,
  // Per-tier weight on the pay rate (index = incident tier; 0 is unused). Equal by
  // default: the watcher already prefers high tiers through their rarity and their
  // pull on the field, and paying more for a cascade would reward the single most
  // *visible* event in the sim — a reactive shortcut, exactly backwards.
  tierWeight: [0, 1, 1, 1],

  // --- anticipation ---
  // Arrival multiplier: tau / (tau + age of the incident when he first arrives).
  // 200 ticks = 10 s, roughly the time to cross a stage, so arriving "one crossing
  // late" halves the rate for the rest of that incident.
  anticipationTau: 200,
  minArrivalMult: 0.05,

  // --- commitment (C4) ---
  // Ticks of *contiguous* attention an incident must receive before any of it pays.
  // Pay accrues into escrow meanwhile and is released in full on completion;
  // walking away first, or the incident ending first, forfeits the lot.
  //
  // This is the knob C2 and C3 jointly demanded, and the reasoning is worth keeping
  // because it is not the obvious one. The duration tier is *decidable* — C3's
  // oracle separates a fresh nap from one with 30 ticks left on every single pair —
  // and worth only 5% of score, which sounds like a contradiction and is not. The
  // information is there; the live distribution never forces him to use it. The feed
  // re-announces what is live every tick, so nothing has to be predicted, and
  // commitment is *reversible*: a wrong guess costs a few strides, so optimism beats
  // prediction and an arm with no clock at all scores within 5% of the oracle.
  //
  // A dwell makes the wrong guess expensive. What he is paid for a trip now depends
  // on whether the thing is still going `dwellMin` ticks after he gets there, which
  // is a question about hidden state and about nothing else. 0 = off, and off is
  // exactly the C1–C3 game.
  //
  // 120 ticks = 6 s, chosen off the measured distribution rather than by feel: over
  // every live incident-tick of `natural`, time-remaining runs p10 20 / median 115 /
  // p90 334, so a 6 s commitment is a coin-flip (49% of live incident-ticks outlive
  // it) and the flat prior a clockless arm must use is wrong about half the time it
  // matters. Shorter and the optimist is simply right; longer and nobody can play.
  dwellMin: 120,
  // How long a lapse a visit survives before it counts as walking away, in ticks.
  //
  // Not a softener — a correction, and one the first draft got wrong in a way worth
  // recording. With a strictly contiguous dwell the *oracle* failed 24.7 of its 33
  // commitments and forfeited more than it earned, a worse failure rate than the arm
  // with no clock at all. Nothing was wrong with its predictions: subjects **move**,
  // he holds his vantage at `standoff` 140 against a `viewRadius` of 180, and a
  // single tick of drift outside the radius while he steps to follow reset the run
  // to zero. Strict contiguity was scoring a *tracking* skill, not a prediction one,
  // which is the opposite of what the knob is for. A second of grace forgives the
  // wobble and leaves abandonment — the thing being priced — still fatal.
  dwellGrace: 20,
  // A lump sum, scaled by the arrival multiplier, paid once when an incident first
  // pays out. The plan's other suggestion — "pay on arrival rather than per tick" —
  // as a knob rather than a rewrite: raise this and drop `viewPay` to slide the
  // economy from occupancy toward arrival timing. 0 = off.
  //
  // It is not optional at `dwellMin: 120`. A dwell only ever *removes* income — half
  // the trips now pay nothing — and with the C1 pay rates that took the shipped
  // expert to −26.7/min and put it below `still`, which is C1's own disqualifying
  // condition: a game the incumbent loses is a game where doing nothing looks like a
  // strategy. The bounty pays a completed commitment back, and it pays it for the
  // behaviour the phase is trying to buy rather than for occupancy. At 120 the
  // expert lands on 32.3/min, within noise of the 30.4 it scored under C1.
  arrivalPay: 120,

  // --- anti-camping ---
  // Ticks of attention banked on one incident before its rate halves. 100 = 5 s.
  diminishHalf: 100,
  // …and a hard ceiling on what one incident can ever be worth, in points.
  incidentCap: 280,

  // --- the costs ---
  // Per stride. A stage crossing is ~24 strides = 12 points, about a quarter of
  // what attending one incident is typically worth — enough that a trip is a wager
  // rather than a free option, not so much that standing still is a strategy.
  stepCost: 0.5,
  rollCost: 2, // per dive-roll: committed, i-framed, and on a cooldown — not free.
  // Per knockdown, on top of the ~5.6 s of grounded time it costs (which is itself
  // ~15% of the episode's earning capacity for the expert). This is the +view/−hit
  // ratio D3 leaves open, and the knob C1 flagged as the one most likely to move.
  //
  // **It moved in C5, 40 → 20, because most of what it charges for is not a
  // decision.** C1 suspected the penalty was "closer to a constant tax on *existing*
  // than a price on recklessness" from one number (`still` is floored 1.07/min
  // against the expert's 1.27). C5 measured the bill instead: over `natural` × 24,
  // the do-nothing floor pays **427 points** of knockdowns and the oracle pays 468 —
  // so **91% of the oracle's knock bill is the ambient rate for standing in a field
  // of pandas**, and only 9% is anything it chose. On `dense` it is 78%. A term that
  // is mostly ambient does not price care; it prices *proximity to pandas*, and the
  // incidents are on the pandas, so at 40 it was quietly subtracting a
  // density-scaled constant from the exact behaviour the pay is trying to buy.
  //
  // The consequence was C1's finding (2), which C4 left open: under crowding the
  // shipped watcher scored below `still`. 20 halves the ambient constant without
  // touching the ordering the penalty exists to enforce, and it fixes that on every
  // spec at once — `natural` 57.7 vs 23.9, `dense` −1.6 vs −2.4, `wild` 27.8 vs 3.5,
  // incumbent first in each. The exploit battery is unmoved (`cowerer` 1.4 and
  // `camper` −25.6 are still far below the reactive ceiling; `speeder` +5% and
  // `roller` −59% against the oracle), and the full memory gap stays at 87%.
  //
  // What it costs, stated rather than buried: the do-nothing floor rises from 2.6 to
  // 23.9/min on `natural`, which is 41% of the incumbent's score where it was 8%.
  // Freezing is a worse strategy than watching everywhere now, but it is no longer
  // *worthless*, and Phase E should expect a shallower gradient out of it.
  knockPenalty: 20,
});

export function makeRules(overrides = {}) {
  const rules = { ...DEFAULT_RULES, ...overrides };
  if (!(rules.viewRadius > 0)) throw new Error('viewRadius must be positive');
  if (!(rules.anticipationTau > 0)) throw new Error('anticipationTau must be positive');
  if (!(rules.diminishHalf > 0)) throw new Error('diminishHalf must be positive');
  return Object.freeze(rules);
}

// ---- what an incident is worth attending ----

// Is this incident's *behaviour* still running? An incident outlives it by
// `aftermathLinger` (the watcher is meant to arrive and find the aftermath), and
// the pay stops at the behaviour: a late arrival should find the nap over, not a
// pension. Each tier answers differently because each has a different body:
//   1 — the subject panda is still inside its anomaly FSM
//   2 — the tower still exists (its base holds STACK_BASE from recruit to topple)
//   3 — the cascade is still sweeping the field
export function incidentActive(state, inc, subject) {
  if (inc.tier === 3) return state.cascade.active;
  if (!subject) return false;
  if (inc.tier === 2) return subject.mode === MODE.STACK_BASE;
  return subject.mode >= MODE.SLEEPER && subject.mode <= MODE.HICCUP;
}

// Where it is, in VISUAL coordinates — the drawn body, which is also the one that
// collides and the one the observation encoder reports. The watcher routes on the
// logical stride grid instead (it is allowed to see one step into the future); at a
// 180px radius the difference never decides a tick, but the reward should be paid
// on the picture, not on the plan.
function incidentSite(state, inc) {
  if (inc.subject === POINT_SUBJECT) return { x: inc.px, y: inc.py, subject: null };
  const subject = state.entities.find((e) => e.id === inc.subject);
  return subject ? { x: subject.x, y: subject.y, subject } : null;
}

// The stable identity of one incident across ticks — the same (subject, born) pair
// the watcher re-finds its own attention with. Two incidents on one panda in one
// tick are impossible (the director only picks free roamers), so this is a key.
const incidentKey = (inc) => `${inc.subject}:${inc.born}`;

// ---- the ledger ----

function newLedger() {
  return {
    view: 0,
    stepCost: 0,
    rollCost: 0,
    knockCost: 0,
    steps: 0,
    rolls: 0,
    holds: 0,
    knocks: 0,
    groundedTicks: 0,
    ticks: 0,
    // Per-incident state, keyed by (subject, born): what he was paid, how long he
    // has banked, and how late he was to it.
    seen: new Map(),
    // Every incident the episode offered, whether or not he went — the denominator
    // of coverage, and the number that says whether an episode had anything in it.
    offered: new Map(),
    offeredActiveTicks: 0,
    attendedTicks: 0,
    // Points accrued toward a dwell and then lost by walking away. Under
    // `dwellMin: 0` this is always 0 and the whole mechanism is inert.
    forfeited: 0,
  };
}

// Score one tick. `state` is post-step (tick t); `prevMode` is the hat's mode at
// tick t-1, which is what says whether a decision was taken this tick.
function scoreTick(L, r, state, hat, prevMode) {
  L.ticks += 1;

  // --- the knockdown ---
  // Edge-triggered: one penalty per knockdown, not one per grounded tick. The
  // grounded ticks are their own (much larger) cost, since he earns nothing
  // through them — the penalty is on top of that opportunity cost, not instead.
  if (hat.mode === MODE.KNOCKED) {
    if (prevMode !== MODE.KNOCKED) {
      L.knocks += 1;
      L.knockCost += r.knockPenalty;
    }
    L.groundedTicks += 1;
  }

  // --- what the move cost ---
  // Charged on exactly the ticks `applyHatAction` ran: a decision tick, entered in
  // OBSERVING. Any other tick either takes no decision (mid-roll, grounded, still
  // walking on) or is off the 10 Hz clock, and `hat.action` is then a stale value
  // from the last decision — charging it would bill him twice for one stride.
  if (prevMode === MODE.OBSERVING && state.tick % TICKS_PER_ACTION === 0) {
    const a = hat.action;
    if (isStep(a)) { L.steps += 1; L.stepCost += r.stepCost; }
    else if (isRoll(a)) { L.rolls += 1; L.rollCost += r.rollCost; }
    else L.holds += 1;
  }

  // --- the pay ---
  // Face down in the dirt is not watching. Neither is still walking on from
  // off-stage. (Mid-roll is: it is 5 ticks, and he is looking the whole way.)
  const watching = hat.mode !== MODE.KNOCKED && hat.mode !== MODE.ENTERING;
  let best = null;
  let bestRate = 0;

  for (const inc of state.incidents) {
    if (inc.expires <= state.tick) continue; // NOT isLive — see the header on `abandoned`
    const site = incidentSite(state, inc);
    if (!site) continue;
    if (!incidentActive(state, inc, site.subject)) continue;

    const key = incidentKey(inc);
    if (!L.offered.has(key)) L.offered.set(key, { tier: inc.tier, attended: false });
    L.offeredActiveTicks += 1;

    if (!watching) continue;
    if (sq(hat.x - site.x) + sq(hat.y - site.y) > sq(r.viewRadius)) continue;

    // The arrival record is minted on the first tick he is PAID for an incident,
    // not the first tick he is near one — under `payAll: false` he can stand in
    // range of a second incident all episode and never collect a tick of it, and
    // minting there would file it as attended-for-nothing and drag every per-
    // incident average with it. So build it provisionally and commit in `payOne`.
    let rec = L.seen.get(key);
    if (!rec) {
      // The multiplier is fixed here, for the whole incident: what he is paid
      // depends on when he committed, not on how long he then loiters.
      const age = state.tick - inc.born;
      const mult = Math.max(r.minArrivalMult, r.anticipationTau / (r.anticipationTau + age));
      rec = {
        key, tier: inc.tier, arrivalAge: age, mult, banked: 0, paid: 0, capped: false,
        // The dwell's state: ticks in the current unbroken visit, what that visit
        // has accrued but not yet earned, and whether the commitment ever completed.
        run: 0, escrow: 0, released: false, lastTick: -2, breaks: 0,
      };
    }

    const weight = r.tierWeight[inc.tier] ?? 1;
    const rate = (r.viewPay * rec.mult * weight) / (1 + rec.banked / r.diminishHalf);
    if (r.payAll) payOne(L, r, rec, rate, state.tick);
    else if (rate > bestRate) { best = rec; bestRate = rate; }
  }

  if (!r.payAll && best) payOne(L, r, best, bestRate, state.tick);
}

// Bank one tick of attention on an incident, and pay for it if it has been earned.
//
// With `dwellMin` at 0 this is the C1 ledger exactly: the record releases on its
// first tick and every tick pays its rate. Above 0 the first `dwellMin` contiguous
// ticks accrue into escrow instead, and the escrow is released whole (plus
// `arrivalPay`) on the tick the dwell completes.
function payOne(L, r, rec, rate, tick) {
  if (!L.seen.has(rec.key)) {
    L.seen.set(rec.key, rec);
    L.offered.get(rec.key).attended = true;
  }

  // A visit is broken by a lapse longer than `dwellGrace` — he wandered off, or
  // (under `payAll: false`) gave the ticks to a better prospect. Forfeiting the
  // escrow there is the whole mechanism: it is what turns "retarget costs a few
  // strides" into "retarget costs everything you had banked".
  if (tick - rec.lastTick > r.dwellGrace) {
    if (!rec.released && rec.run > 0) { L.forfeited += rec.escrow; rec.breaks += 1; }
    rec.run = 0;
    rec.escrow = 0;
  }
  rec.lastTick = tick;
  rec.run += 1;
  rec.banked += 1;
  L.attendedTicks += 1;

  const room = r.incidentCap - rec.paid;
  if (room <= 0) { rec.capped = true; return; }

  if (rec.released) { commit(L, rec, rate, room); return; }

  rec.escrow += rate;
  if (rec.run < r.dwellMin) return; // still earning the right to be paid at all
  rec.released = true;
  // `arrivalPay` lands here rather than on the first tick in range, because this is
  // the tick the commitment actually completed — a bounty for a trip he abandoned
  // halfway would price the walk, not the wager.
  const due = rec.escrow + r.arrivalPay * rec.mult;
  rec.escrow = 0;
  commit(L, rec, due, room);
}

function commit(L, rec, amount, room) {
  const pay = Math.min(amount, room);
  rec.paid += pay;
  L.view += pay;
  if (pay < amount) rec.capped = true;
}

// ---- the report ----

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

// The score, its components, and the diagnostics that are the actual product of
// this phase. The total is one number and one number cannot tell you *why* — a
// policy that never leaves home and one that spends the episode being run over can
// score the same. Coverage, knocks and arrival age are what a game-design change
// is read on.
export function report(L, rules, meta = {}) {
  const recs = [...L.seen.values()];
  const perMin = (v) => (L.ticks ? (v * 1200) / L.ticks : 0);
  const total = L.view - L.stepCost - L.rollCost - L.knockCost;
  return {
    ...meta,
    version: GAME_VERSION,
    ticks: L.ticks,
    score: total,
    scorePerMin: perMin(total),
    components: {
      view: L.view,
      step: -L.stepCost,
      roll: -L.rollCost,
      knock: -L.knockCost,
    },
    attention: {
      // Incidents offered by the episode, and how many he showed up to at all.
      offered: L.offered.size,
      attended: recs.length,
      coverage: L.offered.size ? recs.length / L.offered.size : 0,
      // The share of live incident-ticks he was actually standing in range for.
      // This is the game's real occupancy number, and the one that moves when the
      // FOV cone or the anomaly cadence moves.
      tickCoverage: L.offeredActiveTicks ? L.attendedTicks / L.offeredActiveTicks : 0,
      attendedTicks: L.attendedTicks,
      offeredActiveTicks: L.offeredActiveTicks,
      // How late he was, in ticks, averaged over the incidents he went to. The
      // anticipation economy is a bet on this number being small.
      meanArrivalAge: mean(recs.map((x) => x.arrivalAge)),
      meanArrivalMult: mean(recs.map((x) => x.mult)),
      cappedIncidents: recs.filter((x) => x.capped).length,
      meanPaidPerIncident: mean(recs.map((x) => x.paid)),
      // The dwell's own diagnostics, and the pair C4 is actually read on: how many
      // trips he took that never earned a thing, and what the failed bets cost him.
      // A policy that cannot judge time-remaining shows up here long before it shows
      // up in the score, and `dwellFailed / attended` is that policy's error rate.
      dwellFailed: recs.filter((x) => !x.released).length,
      forfeited: L.forfeited + sum(recs.filter((x) => !x.released).map((x) => x.escrow)),
    },
    hat: {
      steps: L.steps,
      rolls: L.rolls,
      holds: L.holds,
      knocks: L.knocks,
      knocksPerMin: perMin(L.knocks),
      groundedTicks: L.groundedTicks,
      groundedFrac: L.ticks ? L.groundedTicks / L.ticks : 0,
    },
    rules,
  };
}

// ---- the sink ----

// A rollout sink that scores as the episode runs. It must see EVERY tick, from the
// first — pay is per tick, the knock edge is one tick wide, and whether a stride
// was charged depends on the tick before it — so `scoreEpisode` passes `stride: 1`
// and no warmup, and this refuses anything else rather than silently scoring a
// quarter of the episode or losing the first tick's bookkeeping to a missing
// predecessor.
export function scoreSink(rules = {}) {
  const r = makeRules(rules);
  const L = newLedger();
  let prevMode = -1;
  return {
    rules: r,
    ledger: L,
    begin(ctx) {
      if (ctx.stride !== 1) throw new Error(`the scorer needs every tick (stride=${ctx.stride})`);
      if (ctx.warmup) throw new Error(`the scorer needs the whole episode (warmup=${ctx.warmup})`);
      this.ctx = ctx;
    },
    sample(state) {
      const hat = hatOf(state);
      scoreTick(L, r, state, hat, prevMode);
      prevMode = hat.mode;
    },
    report(meta) {
      return report(L, r, { seed: this.ctx?.seed, ...meta });
    },
  };
}
