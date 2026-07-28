import test from 'node:test';
import assert from 'node:assert/strict';

import { makeVecEnv, EXPERT_ACTION } from '../vec.js';
import { makeVecHost } from '../vec-host.js';
import { ACTION } from '../../assets/pandas/engine/actions.js';

// The worker pool must be invisible: the same fleet sharded 2×2 is the same
// fleet as 1×4, decision for decision. Anything less and the worker count would
// be part of an experiment's identity instead of a throughput knob.
test('a 2×2 worker fleet is byte-identical to the single-process 4-env fleet', async () => {
  const opts = { spec: 'wild', corpusSeed: 4242, ticks: 600 };
  const host = await makeVecHost({ workers: 2, envsPerWorker: 2, ...opts });
  const solo = makeVecEnv({ envs: 4, ...opts });

  try {
    assert.deepEqual([...host.first.obs], [...solo.reset().obs]);

    // Mix expert decisions with forced ones, deterministically.
    const acts = new Int8Array(4);
    for (let k = 0; k < 120; k++) {
      for (let i = 0; i < 4; i++) {
        acts[i] = (k + i) % 3 === 0 ? ACTION.HOLD : EXPERT_ACTION;
      }
      const h = await host.step(acts);
      const s = solo.step(acts);
      assert.deepEqual([...h.obs], [...s.obs], `obs diverged at decision ${k}`);
      assert.deepEqual([...h.rewards], [...s.rewards], `rewards diverged at decision ${k}`);
      assert.deepEqual([...h.dones], [...s.dones]);
      assert.deepEqual([...h.applied], [...s.applied]);
      assert.deepEqual([...h.returns], [...s.returns]);
    }
  } finally {
    await host.close();
  }
});
