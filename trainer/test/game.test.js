import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreSink, makeRules, DEFAULT_RULES, incidentActive } from '../game.js';
import { MODE, ANIM, POINT_SUBJECT } from '../../assets/pandas/engine/state.js';
import { ACTION, stepAction, rollAction } from '../../assets/pandas/engine/actions.js';

// ---- a hand-built world ----
//
// The rules are arithmetic on a few fields, and pinning that arithmetic against a
// live episode would mean asserting on whatever the sim happened to do. So these
// tests hand the scorer states it would never see from a rollout: one panda, one
// incident, a hat placed exactly where the assertion needs it. Everything the
// scorer reads is here — if it grows a new read, one of these throws.

const HAT = { id: 0, hasHat: true, mode: MODE.OBSERVING, anim: ANIM.IDLE, x: 0, y: 0, action: ACTION.HOLD };

function world({ tick = 2, hat = {}, pandas = [], incidents = [], cascadeActive = false } = {}) {
  return {
    tick,
    entities: [{ ...HAT, ...hat }, ...pandas],
    incidents,
    cascade: { active: cascadeActive },
  };
}

// A tier-1 anomaly on panda 1, and the incident the director posted with it.
const sleeper = (over = {}) => ({ id: 1, mode: MODE.SLEEPER, x: 100, y: 0, ...over });
const incident = (over = {}) => ({ subject: 1, tier: 1, born: 0, expires: 100000, px: 0, py: 0, ...over });

// Feed the scorer a run of ticks, one state per tick, and hand back its report.
function play(states, rules = {}) {
  const sink = scoreSink(rules);
  sink.begin({ seed: 1, stride: 1 });
  for (const s of states) sink.sample(s);
  return sink.report();
}

// N ticks of the same still life, starting at `from`.
function hold(n, make, from = 1) {
  return Array.from({ length: n }, (_, i) => make(from + i));
}

test('pay is per tick, per incident, while he is inside the view radius', () => {
  const near = play(hold(10, (t) => world({ tick: t, pandas: [sleeper()], incidents: [incident()] })));
  // 10 ticks at viewPay 1, arrival at age 1 (mult ~0.995), lightly diminished.
  assert.ok(near.components.view > 9 && near.components.view < 10, `got ${near.components.view}`);

  const far = play(hold(10, (t) => world({
    tick: t, pandas: [sleeper({ x: DEFAULT_RULES.viewRadius + 1 })], incidents: [incident()],
  })));
  assert.equal(far.components.view, 0);
  assert.equal(far.attention.offered, 1); // it was on offer — he just didn't go
  assert.equal(far.attention.attended, 0);
});

test('a knocked panda pays nothing — the flagship discrimination has teeth', () => {
  // Same pose, same place, same everything the observation encoder can see (the
  // engine's obs suite pins that they encode to identical bytes). One is a nap the
  // director posted an incident for; the other is a panda that was run over.
  const nap = play(hold(20, (t) => world({
    tick: t,
    pandas: [sleeper({ anim: ANIM.FALLEN })],
    incidents: [incident()],
  })));
  const floored = play(hold(20, (t) => world({
    tick: t,
    pandas: [{ id: 1, mode: MODE.KNOCKED, anim: ANIM.FALLEN, x: 100, y: 0 }],
    incidents: [],
  })));
  assert.ok(nap.components.view > 15);
  assert.equal(floored.components.view, 0);
});

test('pay stops when the behaviour stops, not when the incident expires', () => {
  // The incident outlives the anomaly by `aftermathLinger` so the watcher can
  // arrive and find the aftermath. Arriving at the aftermath is worth nothing.
  const states = [
    ...hold(10, (t) => world({ tick: t, pandas: [sleeper()], incidents: [incident()] })),
    ...hold(10, (t) => world({ tick: t, pandas: [sleeper({ mode: MODE.WANDER })], incidents: [incident()] }), 11),
  ];
  const r = play(states);
  assert.ok(r.components.view > 9 && r.components.view < 10);
  assert.equal(r.attention.offeredActiveTicks, 10);
});

test("`abandoned` is the expert's bookkeeping and the referee ignores it", () => {
  const r = play(hold(10, (t) => world({
    tick: t, pandas: [sleeper()], incidents: [incident({ abandoned: true })],
  })));
  assert.ok(r.components.view > 9);
});

test('the arrival multiplier is fixed at arrival, and punishes showing up late', () => {
  const early = play(hold(10, (t) => world({ tick: t, pandas: [sleeper()], incidents: [incident({ born: 0 })] })));
  const late = play(hold(10, (t) => world({
    tick: 400 + t, pandas: [sleeper()], incidents: [incident({ born: 0 })],
  })));
  // 400 ticks late = 20 s: tau/(tau+400) = 1/3 of the rate, for the rest of it.
  assert.ok(late.components.view / early.components.view < 0.4);
  assert.ok(Math.abs(late.attention.meanArrivalMult - 200 / 600) < 0.01);

  // …and it does not recover by leaving and coming back: the multiplier is a
  // property of the incident record, minted once.
  const away = world({ tick: 401, pandas: [sleeper({ x: 9999 })], incidents: [incident({ born: 0 })] });
  const rejoin = play([...hold(5, (t) => world({
    tick: 400 + t, pandas: [sleeper()], incidents: [incident({ born: 0 })],
  })), away, ...hold(5, (t) => world({
    tick: 410 + t, pandas: [sleeper()], incidents: [incident({ born: 0 })],
  }))]);
  assert.ok(Math.abs(rejoin.attention.meanArrivalMult - 200 / 600) < 0.01);
});

test('diminishing returns halve the rate after `diminishHalf` ticks of camping', () => {
  const rules = makeRules({ anticipationTau: 1e9, incidentCap: 1e9 }); // isolate the decay
  const run = (n) => play(hold(n, (t) => world({
    tick: t, pandas: [sleeper()], incidents: [incident()],
  })), rules).components.view;
  const first = run(rules.diminishHalf);
  const both = run(rules.diminishHalf * 2);
  const second = both - first;
  // The second block of `diminishHalf` ticks is worth clearly less than the first,
  // and the total grows logarithmically rather than linearly — camping is not a
  // strategy, structurally, without a penalty term to tune.
  assert.ok(second < first * 0.75, `${second} vs ${first}`);
  assert.ok(both < rules.diminishHalf * 2 * 0.8);
});

test('one incident can never be worth more than the cap', () => {
  const rules = makeRules({ incidentCap: 5, anticipationTau: 1e9 });
  const r = play(hold(400, (t) => world({ tick: t, pandas: [sleeper()], incidents: [incident()] })), rules);
  assert.equal(r.components.view, 5);
  assert.equal(r.attention.cappedIncidents, 1);
});

test('payAll decides whether overlapping incidents both pay', () => {
  const two = () => world({
    tick: 2,
    pandas: [sleeper(), sleeper({ id: 2, x: -100 })],
    incidents: [incident(), incident({ subject: 2 })],
  });
  const all = play([two()], { payAll: true });
  const best = play([two()], { payAll: false });
  assert.ok(all.components.view > best.components.view * 1.9);
  assert.equal(best.attention.attended, 1);
});

test('the hat earns nothing while he is face down, and one penalty per knockdown', () => {
  const down = (t) => world({ tick: t, hat: { mode: MODE.KNOCKED }, pandas: [sleeper()], incidents: [incident()] });
  const up = (t) => world({ tick: t, pandas: [sleeper()], incidents: [incident()] });
  const r = play([up(1), down(2), down(3), down(4), up(5), down(6)]);
  assert.equal(r.hat.knocks, 2); // edge-triggered: two knockdowns, not four grounded ticks
  assert.equal(r.hat.groundedTicks, 4);
  assert.equal(r.components.knock, -2 * DEFAULT_RULES.knockPenalty);
  // Only the two upright ticks paid.
  assert.ok(r.components.view > 1.9 && r.components.view < 2.1);
});

test('movement is charged on exactly the ticks a decision was applied', () => {
  // A decision runs when the tick is on the 10 Hz clock AND he entered it
  // OBSERVING. `hat.action` holds its last value the rest of the time, so a scorer
  // that read it blind would bill one stride two or three times over.
  const at = (t, over) => world({ tick: t, hat: { action: stepAction(0), ...over } });
  const r = play([at(1), at(2), at(3), at(4), at(5), at(6)]);
  assert.equal(r.hat.steps, 3); // ticks 2, 4, 6 — not the odd ones

  // A dive-roll, as the engine actually sequences it: decided on tick 2, which puts
  // him in ROLLING for its 5 ticks, during which updateHat returns before any
  // decision, and back to OBSERVING for the next one.
  const roll = { action: rollAction(3), mode: MODE.ROLLING };
  const rolled = play([
    at(1), at(2, roll), at(3, roll), at(4, roll), at(5, roll), at(6, roll), at(7), at(8),
  ]);
  assert.equal(rolled.hat.rolls, 1);
  assert.equal(rolled.components.roll, -DEFAULT_RULES.rollCost);
  assert.equal(rolled.hat.steps, 1); // tick 8 only — ticks 4 and 6 were mid-roll
});

test('tier 2 pays while the tower stands; tier 3 while the cascade sweeps', () => {
  const tower = (mode) => world({
    tick: 2, pandas: [{ id: 1, mode, x: 100, y: 0 }], incidents: [incident({ tier: 2 })],
  });
  assert.ok(play([tower(MODE.STACK_BASE)]).components.view > 0);
  assert.equal(play([tower(MODE.KNOCKED)]).components.view, 0); // toppled: aftermath, not spectacle

  const carnage = (active) => world({
    tick: 2, cascadeActive: active,
    incidents: [incident({ subject: POINT_SUBJECT, tier: 3, px: 100, py: 0 })],
  });
  assert.ok(play([carnage(true)]).components.view > 0);
  assert.equal(play([carnage(false)]).components.view, 0);
  // …and a point subject is scored at its spot, with no panda to look up.
  assert.equal(incidentActive(world({ cascadeActive: true }), { tier: 3 }, null), true);
});

test('the scorer refuses an episode it would only see part of', () => {
  assert.throws(() => scoreSink().begin({ seed: 1, stride: 2 }), /every tick/);
  assert.throws(() => scoreSink().begin({ seed: 1, stride: 1, warmup: 100 }), /whole episode/);
});

test('rules are validated, and unknown keys are just carried', () => {
  assert.throws(() => makeRules({ viewRadius: 0 }), /viewRadius/);
  assert.throws(() => makeRules({ diminishHalf: -1 }), /diminishHalf/);
  assert.equal(makeRules().viewRadius, DEFAULT_RULES.viewRadius);
});
