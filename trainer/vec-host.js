// The vec fleet's parent — W workers × M envs behind one `step()`.
//
// B5's worker pool, finally needed: Phase B's corpus cut was minutes of
// simulation, but Phase E's on-policy rollouts are billions of ticks, and one
// shard per worker makes the fan-out embarrassing — no shared state, no ordering,
// nothing to merge but a memcpy into the assembled batch.
//
// The interface mirrors vec.js but is async (workers are):
//
//   const host = await makeVecHost({ workers: 8, envsPerWorker: 64, ... });
//   let out = host.first;                     // the assembled initial frames
//   out = await host.step(actions);           // Int8Array(envs), -1 = expert
//   await host.close();
//
// Determinism note: assembly is by worker offset, never arrival order, and each
// worker's envs are seeded by absolute index — so `workers × envsPerWorker` is a
// throughput choice that cannot change an episode. `test/vec-host.test.js` pins
// that against the single-process env.

import { Worker } from 'node:worker_threads';

import { obsLayout, DEFAULT_OBS } from '../assets/pandas/engine/policy/obs.js';

export async function makeVecHost({ workers = 4, envsPerWorker = 32, ...vecOpts } = {}) {
  const envs = workers * envsPerWorker;
  const { length } = obsLayout(vecOpts.obsParams?.slots ?? DEFAULT_OBS.slots);

  const obs = new Float32Array(envs * length);
  const rewards = new Float32Array(envs);
  const dones = new Uint8Array(envs);
  const applied = new Int8Array(envs);
  const returns = new Float32Array(envs);
  const assembled = { obs, rewards, dones, applied, returns };

  const fleet = [];
  const receive = (w, msg) => {
    if (!w.pending) throw new Error(`vec-host: unsolicited message from worker at offset ${w.offset}`);
    obs.set(msg.obs, w.offset * length);
    rewards.set(msg.rewards, w.offset);
    dones.set(msg.dones, w.offset);
    applied.set(msg.applied, w.offset);
    returns.set(msg.returns, w.offset);
    const { resolve } = w.pending;
    w.pending = null;
    resolve();
  };

  for (let i = 0; i < workers; i++) {
    const offset = i * envsPerWorker;
    const worker = new Worker(new URL('./vec-worker.js', import.meta.url), {
      workerData: { ...vecOpts, envs: envsPerWorker, baseIndex: offset },
    });
    const w = { worker, offset, pending: null };
    worker.on('message', (msg) => receive(w, msg));
    worker.on('error', (err) => {
      const { reject } = w.pending ?? {};
      w.pending = null;
      if (reject) reject(err);
      else throw err;
    });
    fleet.push(w);
  }

  const gather = () => Promise.all(fleet.map((w) => new Promise((resolve, reject) => {
    w.pending = { resolve, reject };
  })));

  // Every worker posts its initial frames unasked; wait for the full assembly.
  const arm = gather();
  // (pending was created after the message could have landed? No: worker startup
  // takes ms and `gather` armed synchronously before the event loop ran, so the
  // 'message' handler cannot fire before `pending` exists.)
  await arm;

  return {
    envs,
    workers,
    envsPerWorker,
    layout: obsLayout(vecOpts.obsParams?.slots ?? DEFAULT_OBS.slots),
    first: assembled,

    async step(actions) {
      if (actions.length !== envs) throw new Error(`expected ${envs} actions, got ${actions.length}`);
      const armed = gather();
      for (const w of fleet) {
        w.worker.postMessage({
          type: 'step',
          actions: actions.slice(w.offset, w.offset + envsPerWorker),
        });
      }
      await armed;
      return assembled;
    },

    async close() {
      await Promise.all(fleet.map((w) => w.worker.terminate()));
    },
  };
}
