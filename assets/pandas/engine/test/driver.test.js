// The policy seam's deployment end: sampling, and what happens when it goes wrong.
//
// The sampler is tested against a fake net rather than the trained one, because the
// properties here are about the *reading* of a distribution and must hold for any
// weights — including weights that have gone bad, which is the half that matters.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sample, makePolicyDriver, DEFAULT_DRIVER } from '../policy/driver.js';
import { ACTION } from '../actions.js';
import { makeObserver } from '../policy/obs.js';
import { makeEngine } from '../engine.js';
import { Rng } from '../rng.js';

const N = ACTION.COUNT;
const probs = () => new Float32Array(N);
const opts = (over = {}) => ({ ...DEFAULT_DRIVER, ...over });

// A deterministic stand-in for the driver's PRNG, so a draw can be aimed exactly.
const drawer = (...values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

test('at dirTemperature 1 the two-stage sampler is a plain softmax over all 17', () => {
  // Sampling in two stages must not change the distribution when nothing is being
  // re-tempered — otherwise the temperatures are not a reading of the trained model,
  // they are a second model.
  const logits = new Float32Array([0.4, -1, 2.2, 0.1, -0.7, 1.4, 0.9, -2, 0.3,
    -0.4, 1.1, 0.2, -1.3, 0.8, -0.2, 1.9, 0.6]);
  const soft = softmax(logits);

  const rng = new Rng(12345);
  const counts = new Array(N).fill(0);
  const runs = 300000;
  const buf = probs();
  for (let i = 0; i < runs; i++) {
    counts[sample(logits, buf, opts({ temperature: 1, dirTemperature: 1 }), () => rng.float(0, 1))] += 1;
  }
  for (let a = 0; a < N; a++) {
    const got = counts[a] / runs;
    assert.ok(Math.abs(got - soft[a]) < 0.006,
      `action ${a}: sampled ${got.toFixed(4)}, softmax says ${soft[a].toFixed(4)}`);
  }
});

test('dirTemperature sharpens the direction and leaves the family alone', () => {
  // Two of the eight step directions carry nearly all the step mass; cooling should
  // concentrate on the leader while the hold/step/roll split stays put.
  const logits = new Float32Array(N).fill(-4);
  logits[ACTION.HOLD] = 1.0;
  logits[ACTION.STEP_BASE + 2] = 0.8;
  logits[ACTION.STEP_BASE + 3] = 0.4;
  logits[ACTION.ROLL_BASE + 5] = 0.2;

  const family = (dirT) => {
    const rng = new Rng(777);
    const buf = probs();
    let hold = 0;
    let step = 0;
    let best = 0;
    const runs = 120000;
    for (let i = 0; i < runs; i++) {
      const a = sample(logits, buf, opts({ dirTemperature: dirT }), () => rng.float(0, 1));
      if (a === ACTION.HOLD) hold += 1;
      else if (a < ACTION.ROLL_BASE) {
        step += 1;
        if (a === ACTION.STEP_BASE + 2) best += 1;
      }
    }
    return { hold: hold / runs, step: step / runs, lead: best / step };
  };

  const warm = family(1);
  const cold = family(0.25);
  assert.ok(Math.abs(warm.hold - cold.hold) < 0.01, `hold moved ${warm.hold} -> ${cold.hold}`);
  assert.ok(Math.abs(warm.step - cold.step) < 0.01, `step moved ${warm.step} -> ${cold.step}`);
  assert.ok(cold.lead > warm.lead + 0.15,
    `leading direction only went ${warm.lead.toFixed(3)} -> ${cold.lead.toFixed(3)}`);
});

test('an unusable distribution yields null — the seam hands the tick back', () => {
  const buf = probs();
  const cases = {
    'a NaN logit': (v) => { v[3] = NaN; },
    'an infinite logit': (v) => { v[0] = Infinity; },
    'a negative infinity that is the max': (v) => v.fill(-Infinity),
  };
  for (const [what, poison] of Object.entries(cases)) {
    const logits = new Float32Array(N);
    poison(logits);
    assert.equal(sample(logits, buf, opts(), () => 0.5), null, what);
  }
});

test('a draw at the very top of the range still returns a valid action', () => {
  // Floating-point accumulation can leave the inverse-CDF target a hair past the
  // total. The fall-through must be an action, never undefined.
  const logits = new Float32Array(N).fill(0);
  const a = sample(logits, probs(), opts(), drawer(0.9999999999));
  assert.ok(Number.isInteger(a) && a >= 0 && a < N, `got ${a}`);
});

// ---- the driver, against a net whose logits are dictated ----

function fakeNet(produce, cfg = {}) {
  const config = { tokens: 9, obs_width: 37, frames: 4, n_actions: N, ...cfg };
  const logits = new Float32Array(N);
  let calls = 0;
  return {
    cfg: config,
    logits,
    get calls() { return calls; },
    forward() {
      produce(logits, calls);
      calls += 1;
      return logits;
    },
  };
}

const world = () => {
  const engine = makeEngine({ width: 1200, height: 700, pandaCount: 8, entrance: false });
  return { engine, state: engine.init(4242) };
};

test('the first decision primes the whole frame history from one observation', () => {
  // An episode's first decision has no history — in the corpus (where windows repeat
  // the earliest row) and on the page alike. If the two rules disagreed, every
  // episode would open with the model reading three frames of something it was never
  // trained on.
  let seen = null;
  const net = fakeNet((v) => { v.fill(0); v[ACTION.HOLD] = 10; });
  const wrapped = {
    ...net,
    forward(ring, newest) {
      seen = ring.map((f) => f.slice());
      return net.forward(ring, newest);
    },
  };
  const driver = makePolicyDriver(wrapped, { observer: makeObserver() });
  const { state } = world();
  driver.init({ seed: 1 })(state, 2);

  assert.equal(seen.length, 4);
  for (let i = 1; i < seen.length; i++) {
    assert.deepEqual(seen[i], seen[0], `frame ${i} differs from the primed frame`);
  }
  assert.ok(seen[0].some((v) => v !== 0), 'the primed frame is empty');
});

test('the driver retires after a run of bad forward passes, and not before', () => {
  const net = fakeNet((v) => v.fill(NaN));
  const driver = makePolicyDriver(net, { observer: makeObserver(), maxFailures: 3 });
  const act = driver.init({ seed: 1 });
  const { engine } = world();
  let state = engine.init(4242);

  const calls = [];
  for (let i = 0; i < 8; i++) {
    calls.push(act(state, (i + 1) * 2));
    state = engine.step(state, null);
  }
  // Every call returns null (hand the tick back); after the third the net is no
  // longer consulted at all.
  assert.deepEqual(calls, new Array(8).fill(null));
  assert.equal(net.calls, 3, `net was called ${net.calls} times after retiring at 3`);
});

test('one bad pass is survivable — the failure counter resets on a good one', () => {
  const net = fakeNet((v, call) => {
    v.fill(0);
    if (call % 2 === 0) v.fill(NaN);
    else v[ACTION.HOLD] = 5;
  });
  const driver = makePolicyDriver(net, { observer: makeObserver(), maxFailures: 3 });
  const act = driver.init({ seed: 9 });
  const { engine } = world();
  let state = engine.init(4242);

  let nulls = 0;
  for (let i = 0; i < 20; i++) {
    if (act(state, (i + 1) * 2) === null) nulls += 1;
    state = engine.step(state, null);
  }
  assert.equal(nulls, 10, 'every other pass was bad, so half the ticks go to the expert');
  assert.equal(net.calls, 20, 'the driver retired despite never failing three in a row');
});

test('two drivers on the same seed make the same choices; different seeds diverge', () => {
  // The policy carries its own PRNG rather than drawing from the sim's, so a run is
  // reproducible without the act of thinking changing the world.
  const spread = (v) => { v.fill(0); for (let i = 0; i < N; i++) v[i] = (i % 5) * 0.3; };
  const run = (seed) => {
    const driver = makePolicyDriver(fakeNet(spread), { observer: makeObserver() });
    const act = driver.init({ seed });
    const { engine } = world();
    let state = engine.init(4242);
    const actions = [];
    for (let i = 0; i < 60; i++) {
      actions.push(act(state, (i + 1) * 2));
      state = engine.step(state, null);
    }
    return actions;
  };
  assert.deepEqual(run(11), run(11));
  assert.notDeepEqual(run(11), run(12));
});

function softmax(logits) {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  const e = Array.from(logits, (v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}
