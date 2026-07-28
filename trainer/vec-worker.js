// One worker thread of the vec fleet — hosts a `makeVecEnv` shard.
//
// The parent (`vec-host.js`) spawns W of these, each owning `envs` environments
// whose absolute indices start at `baseIndex`. Because an env's episode stream is
// keyed on its absolute index (see vec.js), the same fleet sharded differently is
// the same fleet — which is what makes the worker count a throughput knob rather
// than something an experiment has to record.
//
// Protocol (all messages after construction):
//   in:  { type: 'step', actions: Int8Array }   one decision for every env
//   out: { obs, rewards, dones, applied, returns }  copies, transferred
//
// The first message out is the initial frame block (the `reset`), sent unasked as
// soon as the shard is up.

import { parentPort, workerData } from 'node:worker_threads';

import { makeVecEnv } from './vec.js';

const vec = makeVecEnv(workerData);

// The vec env reuses its buffers every step, so what goes over the wire is a
// copy — transferred, not cloned, so the cost is one memcpy and no GC churn.
function post(out) {
  const msg = {
    obs: out.obs.slice(),
    rewards: out.rewards.slice(),
    dones: out.dones.slice(),
    applied: out.applied.slice(),
    returns: out.returns.slice(),
  };
  parentPort.postMessage(msg, [
    msg.obs.buffer, msg.rewards.buffer, msg.dones.buffer, msg.applied.buffer, msg.returns.buffer,
  ]);
}

post(vec.reset());

parentPort.on('message', (msg) => {
  if (msg.type === 'step') post(vec.step(msg.actions));
  else throw new Error(`vec-worker: unknown message type ${msg.type}`);
});
