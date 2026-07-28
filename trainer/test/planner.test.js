import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePolicy, gapReport, GATE } from '../evaluate.js';
import {
  POLICIES, YARDSTICKS, EXPLOITS, policyByName,
  oraclePolicy, reactiveTruthPolicy, reactiveObsPolicy, speeder,
} from '../policies.js';
import { oracle, reactiveTruth, reactiveObs } from '../percept.js';
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

test('the planner paces itself at the expert stride cadence', () => {
  // `applyHatAction` has no cadence check — a policy that emits STEP every decision
  // tick travels 5.5x the expert. The yardsticks must not, or they would be
  // measuring a different game from the one a deployed policy plays.
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
  const decisions = EP.ticks / TICKS_PER_ACTION;
  const paced = strides(oraclePolicy);
  const fast = strides(speeder);
  assert.ok(paced < decisions * 0.35, `oracle strode ${paced} of ${decisions} decision ticks`);
  assert.ok(fast > paced * 1.5, `the speeder (${fast}) should stride far more than the oracle (${paced})`);
});

test('the oracle clears the memoryless observer by a wide margin', () => {
  // Phase C exit check 1, in miniature. The threshold is 30% of the oracle; the
  // measured value at 24 episodes is ~88%, so a fixture-sized run should be nowhere
  // near the line and this test should never be delicate.
  const o = evaluatePolicy({ ...SET, policy: oraclePolicy, name: 'oracle' });
  const r = evaluatePolicy({ ...SET, policy: reactiveObsPolicy, name: 'reactiveObs' });
  const gap = (o.scorePerMin.mean - r.scorePerMin.mean) / Math.abs(o.scorePerMin.mean);
  assert.ok(gap >= GATE.gapThreshold, `full memory gap ${(gap * 100).toFixed(0)}% below threshold`);
  assert.ok(o.tickCoverage.mean > r.tickCoverage.mean * 2, 'the oracle should watch far more');
});

test('every exploit bot stays near the reactive ceiling, and the speeder does not', () => {
  // Phase C exit check 2. The speeder is in here on purpose and is expected to fail
  // it: it is not a reward exploit but an *action space* one, and the check has to
  // be able to say so out loud rather than being tuned until everything passes.
  const results = [...YARDSTICKS, ...EXPLOITS, 'speeder'].map((name) =>
    evaluatePolicy({ ...SET, policy: policyByName(name), name }));
  const g = gapReport(results);
  for (const e of g.exploits) {
    if (e.name === 'speeder') {
      assert.ok(!e.ok, 'the speed exploit has been closed — update the finding');
      assert.ok(e.climb > 1, 'the speeder should out-score the oracle itself');
    } else {
      assert.ok(e.ok, `${e.name} climbed to ${(e.climb * 100).toFixed(0)}% of the oracle`);
    }
  }
});

test('gapReport reports both ceilings and does not silently pick one', () => {
  const fake = (name, mean) => ({ name, scorePerMin: { mean } });
  const g = gapReport([
    fake('oracle', 100), fake('reactiveTruth', 90), fake('reactiveObs', 10), fake('camper', 5),
  ]);
  assert.equal(g.conservative.gap, 10);
  assert.equal(g.full.gap, 90);
  assert.ok(Math.abs(g.conservative.frac - 0.1) < 1e-9);
  assert.ok(Math.abs(g.full.frac - 0.9) < 1e-9);
  // camper sits below the reactive ceiling, so its climb is negative and it passes.
  assert.equal(g.exploits[0].name, 'camper');
  assert.ok(g.exploits[0].climb < 0 && g.exploits[0].ok);
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
