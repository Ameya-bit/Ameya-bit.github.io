import test from 'node:test';
import assert from 'node:assert/strict';

import { makeVecEnv, EXPERT_ACTION } from '../vec.js';
import { scoreEpisode } from '../evaluate.js';
import { ACTION } from '../../assets/pandas/engine/actions.js';

// One fixed episode, injected — the vec env's world is then exactly the one
// `scoreEpisode` runs, so the two ledgers must agree to the last float.
const FIXED = { seed: 606, config: { entrance: false }, ticks: 2000 };
const fixedDraw = () => ({ ...FIXED });

test('summed per-decision rewards ARE the gate score, exactly', () => {
  const vec = makeVecEnv({ envs: 1, drawFor: fixedDraw });
  const expert = new Int8Array([EXPERT_ACTION]);

  let total = 0;
  let episodeReturn = null;
  while (episodeReturn === null) {
    const { rewards, dones, returns } = vec.step(expert);
    total += rewards[0];
    if (dones[0]) episodeReturn = returns[0];
  }

  const ref = scoreEpisode({ ...FIXED });
  // The episode return is the f64 ledger rounded once to float32 — exact against
  // the same rounding of the reference. The summed rewards round every *delta* to
  // float32 (the wire is f32), so they agree to f32 precision, not bit-for-bit.
  assert.equal(episodeReturn, Math.fround(ref.score));
  assert.ok(Math.abs(total - ref.score) < 1e-3, `${total} vs ${ref.score}`);
});

test('sharding envs across instances does not change their episodes', () => {
  const opts = { spec: 'wild', corpusSeed: 777, ticks: 600 };
  const whole = makeVecEnv({ envs: 4, ...opts });
  const left = makeVecEnv({ envs: 2, baseIndex: 0, ...opts });
  const right = makeVecEnv({ envs: 2, baseIndex: 2, ...opts });

  const wholeActs = new Int8Array(4).fill(EXPERT_ACTION);
  const halfActs = new Int8Array(2).fill(EXPERT_ACTION);
  for (let k = 0; k < 40; k++) {
    const w = whole.step(wholeActs);
    const l = left.step(halfActs);
    const r = right.step(halfActs);
    const L = whole.layout.length;
    assert.deepEqual([...w.obs.subarray(0, 2 * L)], [...l.obs]);
    assert.deepEqual([...w.obs.subarray(2 * L)], [...r.obs]);
    assert.deepEqual([...w.rewards], [...l.rewards, ...r.rewards]);
    assert.deepEqual([...w.dones], [...l.dones, ...r.dones]);
  }
});

test('an episode end auto-resets: done flags, return delivered, fresh first frame', () => {
  const vec = makeVecEnv({ envs: 1, drawFor: fixedDraw });
  const expert = new Int8Array([EXPERT_ACTION]);

  let out = vec.step(expert);
  let steps = 1;
  while (!out.dones[0]) { out = vec.step(expert); steps += 1; }
  assert.notEqual(out.returns[0], 0);
  // The frame handed back at the reset is the NEXT episode's first frame — the
  // same one a brand-new env (same draw stream, one episode in) starts with.
  const twin = makeVecEnv({ envs: 1, drawFor: fixedDraw });
  const twinFirst = new Float32Array(twin.reset().obs);
  assert.deepEqual([...out.obs], [...twinFirst]);

  // …and the episode had the expected number of decisions in it.
  assert.equal(steps, FIXED.ticks / 2);
});

test('external actions actually drive the hat, and differ from the expert', () => {
  const run = (action) => {
    const vec = makeVecEnv({ envs: 1, drawFor: fixedDraw });
    const acts = new Int8Array([action]);
    const applied = [];
    for (let k = 0; k < 200; k++) applied.push(vec.step(acts).applied[0]);
    return applied;
  };
  const held = run(ACTION.HOLD);
  const expert = run(EXPERT_ACTION);
  // Forced HOLD: every applied action is HOLD (nothing for the limiter to refuse).
  assert.ok(held.every((a) => a === ACTION.HOLD));
  // The expert does not hold 200 decisions straight on this seed.
  assert.ok(expert.some((a) => a !== ACTION.HOLD));
});

test('the fleet is staggered: first episodes end out of phase', () => {
  const vec = makeVecEnv({ envs: 8, spec: 'wild', corpusSeed: 42, ticks: 1200 });
  const acts = new Int8Array(8).fill(EXPERT_ACTION);
  const firstEnd = new Array(8).fill(0);
  for (let k = 1; k <= 600; k++) {
    const { dones } = vec.step(acts);
    for (let i = 0; i < 8; i++) if (dones[i] && !firstEnd[i]) firstEnd[i] = k;
  }
  assert.ok(firstEnd.every((k) => k > 0), 'every env finished an episode');
  assert.ok(new Set(firstEnd).size >= 4, `resets are in phase: ${firstEnd}`);
});
