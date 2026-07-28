import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePolicy, gapReport, GATE } from '../evaluate.js';
import {
  POLICIES, YARDSTICKS, EXPLOITS, policyByName,
  oraclePolicy, reactiveTruthPolicy, reactiveObsPolicy, speeder, roller,
} from '../policies.js';
import { oracle, reactiveTruth, reactiveObs } from '../percept.js';
import { makeRules } from '../game.js';
import { runEpisode, hatOf } from '../rollout.js';
import { isStep, isRoll } from '../../assets/pandas/engine/actions.js';
import { TICKS_PER_ACTION } from '../../assets/pandas/engine/tick.js';

const EP = { seed: 771, config: { entrance: false }, ticks: 6000 };
const SET = { episodes: 8, ticks: 12000, spec: 'natural' };

test('the three yardsticks are one planner over three beliefs', () => {
  // The load-bearing claim of the whole gate: if these were three separately
  // written bots, the gap between their scores would measure how hard I tried on
  // each one rather than what each one knows.
  assert.equal(oraclePolicy.percept, oracle);
  assert.equal(reactiveTruthPolicy.percept, reactiveTruth);
  assert.equal(reactiveObsPolicy.percept, reactiveObs);
  assert.equal(speeder.percept, oracle); // the speed exploit IS the oracle, unbraked
});

test('the engine, not the yardstick, is what caps the stride rate', () => {
  // Through C3 this test asserted the opposite: that `speeder` out-strode the oracle,
  // because `applyHatAction` had no cadence check and a policy emitting STEP every
  // decision tick travelled 5.5× the expert. C4 closed that in the engine
  // (`limitAction`), so the yardsticks are no longer on their honour — `speeder` still
  // *asks* every other tick and simply does not get them.
  const strides = (policy) => {
    let n = 0;
    runEpisode({
      ...EP,
      stride: 1,
      policy,
      sink: { sample: (s) => { if (isStep(hatOf(s).action) && s.tick % TICKS_PER_ACTION === 0) n += 1; } },
    });
    return n;
  };
  const paced = strides(oraclePolicy);
  const fast = strides(speeder);
  // Both are held to one stride per `hatAlert` ticks, so asking 4× as often buys
  // nothing. (Not exactly equal: `speeder` re-asks the moment the cadence clears and
  // the oracle asks on its own clock, so their strides fall on different ticks.)
  const ceiling = EP.ticks / 8; // cfg.hatAlert
  assert.ok(fast <= ceiling, `the speeder strode ${fast}, over the engine ceiling ${ceiling}`);
  assert.ok(fast < paced * 1.25, `asking harder still bought ${fast} strides against ${paced}`);
});

test('the oracle clears the memoryless observer by a wide margin', () => {
  // Phase C exit check 1, in miniature — and after C5 this *is* the check, since the
  // verdict is on the memoryless twin the plan named. The threshold is 30% of the
  // oracle; the measured value at 24 episodes is ~87%, and it holds between 77% and
  // 95% across every instrument variant C5 tried, so a fixture-sized run should be
  // nowhere near the line and this test should never be delicate.
  const o = evaluatePolicy({ ...SET, policy: oraclePolicy, name: 'oracle' });
  const r = evaluatePolicy({ ...SET, policy: reactiveObsPolicy, name: 'reactiveObs' });
  const gap = (o.scorePerMin.mean - r.scorePerMin.mean) / Math.abs(o.scorePerMin.mean);
  assert.ok(gap >= GATE.gapThreshold, `full memory gap ${(gap * 100).toFixed(0)}% below threshold`);
  assert.ok(o.tickCoverage.mean > r.tickCoverage.mean * 2, 'the oracle should watch far more');
});

test('exit check 2 — no reward exploit climbs, and no unbraked twin beats the oracle', () => {
  // Phase C exit check 2, in both its families. Through C3 the speeder was expected
  // to *fail* this and did, at 129% — an action-space hole rather than a reward one,
  // which the check said out loud rather than being tuned around. C4 closed it and
  // its sibling (the roll cooldown) in the engine, so both now pass, and the two
  // families are scored against different denominators for the reason in GATE.
  const results = [...YARDSTICKS, ...EXPLOITS].map((name) =>
    evaluatePolicy({ ...SET, policy: policyByName(name), name }));
  const g = gapReport(results);
  for (const e of g.exploits) {
    assert.ok(e.ok, `${e.name} climbed to ${(e.climb * 100).toFixed(0)}% of the oracle`);
  }
  assert.equal(g.unbraked.length, 2, 'both action exploits should be measured');
  for (const e of g.unbraked) {
    assert.ok(e.ok, `${e.name} beat the oracle by ${(e.excess * 100).toFixed(0)}% — limitAction leaks`);
  }
});

test('gapReport reports both ceilings and gives a verdict on exactly one', () => {
  const fake = (name, mean) => ({ name, scorePerMin: { mean } });
  const g = gapReport([
    fake('oracle', 100), fake('reactiveTruth', 90), fake('reactiveObs', 10), fake('camper', 5),
  ]);
  assert.equal(g.conservative.gap, 10);
  assert.equal(g.full.gap, 90);
  assert.ok(Math.abs(g.conservative.frac - 0.1) < 1e-9);
  assert.ok(Math.abs(g.full.frac - 0.9) < 1e-9);
  // C5: the verdict is on the full gap, and the conservative reading carries none.
  // It is a diagnostic — not a bound, since it is measurably negative on `wild` —
  // and giving it an `ok` is how it would quietly become a threshold again.
  assert.equal(g.full.ok, true);
  assert.equal(g.conservative.ok, undefined);
  // camper sits below the reactive ceiling, so its climb is negative and it passes.
  assert.equal(g.exploits[0].name, 'camper');
  assert.ok(g.exploits[0].climb < 0 && g.exploits[0].ok);
});

test('a shortfall on the full gap fails the gate, whatever the diagnostic says', () => {
  // The other half of the same claim: a leaky game must still be caught. Here the
  // conservative reading is flattering (a 50% gap) and the one that counts is not.
  const fake = (name, mean) => ({ name, scorePerMin: { mean } });
  const g = gapReport([fake('oracle', 100), fake('reactiveTruth', 50), fake('reactiveObs', 80)]);
  assert.equal(g.full.ok, false);
  assert.ok(g.conservative.frac > GATE.gapThreshold);
});

test('the shipped economy keeps the incumbent above the do-nothing floor', () => {
  // C1's disqualifying condition, as a measurement rather than a paragraph: a game
  // the shipped watcher loses is a game where doing nothing looks like a strategy.
  // C4 held this on `natural` alone; C5's `knockPenalty` 20 is what makes it true on
  // the training distribution too, which is the one that matters for Phase E.
  //
  // Two specs, deliberately — and deliberately **not** `dense`. There the incumbent
  // is still a few points *behind* the floor (−9.2 against −4.6 at 96 episodes, down
  // from −63.1 against −39.3 at `knockPenalty` 40), and C5's finding is that this is
  // a fact about a watcher hand-tuned for the live density rather than about the
  // game: on the same worlds the oracle scores 153.0. Pricing the knock low enough
  // to put a badly-triaging bot ahead of standing still would be tuning the game to
  // flatter the incumbent. See trainer/README.md, "the crowding finding, re-priced".
  for (const spec of ['natural', 'wild']) {
    const of = (name) => evaluatePolicy({ ...SET, spec, policy: policyByName(name), name })
      .scorePerMin.mean;
    const expert = of('expert');
    assert.ok(expert > of('still'), `${spec}: the incumbent lost to the do-nothing floor`);
  }
});

test('every policy emits only legal actions, and none of them throws', () => {
  for (const [name, policy] of Object.entries(POLICIES)) {
    const kinds = new Set();
    runEpisode({
      ...EP,
      ticks: 2000,
      stride: 1,
      policy,
      sink: { sample: (s) => kinds.add(hatOf(s).action) },
    });
    for (const a of kinds) {
      assert.ok(a === 0 || isStep(a) || isRoll(a), `${name} produced ${a}`);
    }
  }
});

test('the yardsticks are pure functions of the episode', () => {
  const run = (policy) => {
    const xs = [];
    runEpisode({ ...EP, ticks: 3000, policy, sink: { sample: (s) => xs.push(hatOf(s).x) } });
    return xs;
  };
  for (const name of YARDSTICKS) {
    assert.deepEqual(run(policyByName(name)), run(policyByName(name)), `${name} is not deterministic`);
  }
});

test('a yardstick prices the rules it is being scored under, not the defaults', () => {
  // The bug this pins was invisible and expensive. The planners are constructed once,
  // at module load, against `DEFAULT_RULES`; `--rules` changed only the referee. So
  // every knob sweep measured policies that had never seen the knob — including C2's
  // published finding that the conservative gap "stays at ~5% under everything", and
  // C4's own first reading of `dwellMin`, which showed identical stride and knock
  // costs at every setting because the behaviour genuinely never changed.
  const rules = { dwellMin: 300, arrivalPay: 300, incidentCap: 520 };
  const seen = [];
  const spy = {
    init(ctx) {
      seen.push(ctx.rules);
      return oraclePolicy.init(ctx);
    },
  };
  evaluatePolicy({ ...SET, episodes: 2, rules, policy: spy, name: 'oracle' });
  assert.ok(seen.length > 0 && seen.every((r) => r && r.dwellMin === 300),
    'the episode rules never reached the policy');

  // And the direct claim, which is the one that was false: the knob must change what
  // the policy *does*. Same seed, same world, two rule sets — a 300-tick commitment
  // is a bet most incidents lose, so the oracle cannot play it the way it plays 120.
  const actions = (r) => {
    const xs = [];
    runEpisode({
      ...EP, ticks: 4000, stride: 1, policy: oraclePolicy, rules: makeRules(r),
      sink: { sample: (s) => xs.push(hatOf(s).action) },
    });
    return xs;
  };
  const strict = actions(rules);
  const shipped = actions({});
  assert.notDeepEqual(strict, shipped, 'the knob changed nothing about the trajectory');
});

test('an arm with no clock bets the survival curve instead of refusing to move', () => {
  // A guess is not a short countdown. Treating `priorRemaining` as if it were known
  // makes `est - travel < dwellMin` a hard refusal, and at the shipped defaults that
  // is every trip costing more than ~30 ticks of travel: the clockless arm went
  // catatonic and stopped walking to the flagship twin battery's sleeper at all. The
  // gap that produced was mostly paralysis, and a gate must err the other way.
  const r = evaluatePolicy({ ...SET, episodes: 8, policy: reactiveTruthPolicy, name: 'reactiveTruth' });
  assert.ok(r.coverage.mean > 0.15, `the clockless arm attended ${(r.coverage.mean * 100).toFixed(0)}% of incidents`);
  assert.ok(r.scorePerMin.mean > 0, 'and it should still be a strong policy, not a floor');
});
