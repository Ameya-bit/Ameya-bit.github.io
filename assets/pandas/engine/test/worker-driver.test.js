// The pipelined worker driver, held to its contract with a fake worker.
//
// `makeWorkerPolicy` takes the worker as an argument precisely so this file can
// exist: the pipeline's semantics — one-decision delay, miss accounting, failure
// retirement, epoch fencing — are all decided on the main-thread side, and none of
// them should need a browser to check. The real worker's arithmetic is `net.js`,
// which has its own parity gate; what is under test here is the schedule.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine } from '../engine.js';
import { ACTION } from '../actions.js';
import { makeWorkerPolicy } from '../render/worker-driver.js';
import { OBS_WIDTH } from '../policy/obs.js';

const N_ACTIONS = ACTION.COUNT;

// A manifest with just what the driver reads.
const manifest = {
  config: { tokens: 9, obs_width: OBS_WIDTH, frames: 4, n_actions: N_ACTIONS },
};

// Logits with effectively all mass on one action, so the two-stage sampler is
// deterministic regardless of the episode PRNG's draws.
function peaked(action) {
  const logits = new Float32Array(N_ACTIONS).fill(-50);
  logits[action] = 50;
  return logits;
}

// A worker whose reply behaviour is the test's to script. `replyTo` is called with
// each posted frame message and may answer via `reply` (synchronously or later).
function fakeWorker(replyTo = null) {
  const posted = [];
  const w = {
    posted,
    onmessage: null,
    onerror: null,
    terminated: false,
    terminate() { this.terminated = true; },
    postMessage(msg) {
      posted.push(msg);
      if (msg.type === 'frame') replyTo?.(msg, w.reply);
    },
    reply(msg) { w.onmessage?.({ data: msg }); },
  };
  return w;
}

// A real state for the observer to encode — the driver never reads it itself.
const engine = makeEngine({ width: 1200, height: 800, pandaCount: 6, entrance: false });
const state = engine.init(1234);

test('the action applied at decision k is the answer to the frame from k-1', () => {
  // Echo back logits peaked on STEP_BASE + (seq % 8), synchronously.
  const w = fakeWorker((msg, reply) =>
    reply({ type: 'logits', epoch: msg.epoch, seq: msg.seq, logits: peaked(ACTION.STEP_BASE + (msg.seq % 8)) }));
  const act = makeWorkerPolicy(w, manifest).init({ seed: 7 });

  // Decision 1: nothing owed yet — the rules expert drives while the pipe fills.
  assert.equal(act(state), null);
  // Decision k applies the (synchronously delivered) answer for frame k-1.
  for (let k = 1; k < 12; k++) {
    assert.equal(act(state), ACTION.STEP_BASE + ((k - 1) % 8), `decision ${k + 1}`);
  }
  // Every decision posted exactly one frame, in sequence.
  const frames = w.posted.filter((m) => m.type === 'frame');
  assert.deepEqual(frames.map((m) => m.seq), [...Array(12).keys()]);
});

test('a worker that never answers is misses, then retirement', () => {
  const w = fakeWorker(); // posts vanish
  const policy = makeWorkerPolicy(w, manifest, { maxMisses: 3 });
  const act = policy.init({ seed: 7 });

  assert.equal(act(state), null); // pipeline fill — not a miss
  assert.equal(act(state), null); // miss 1
  assert.equal(act(state), null); // miss 2
  assert.equal(act(state), null); // miss 3 -> retire
  assert.equal(act.stats.retired, true);

  const postedBefore = w.posted.length;
  assert.equal(act(state), null);
  assert.equal(w.posted.length, postedBefore, 'a retired driver must stop posting');
});

test('a late answer is stale: only the previous decision\'s seq is applied', () => {
  // Answer every frame two decisions late. The driver should treat every decision
  // as a miss (the answer it owes is never there when it looks) — but must not
  // crash or mis-apply the stale ones.
  const backlog = [];
  const w = fakeWorker((msg) => backlog.push(msg));
  const act = makeWorkerPolicy(w, manifest, { maxMisses: 100 }).init({ seed: 7 });

  for (let k = 0; k < 6; k++) {
    assert.equal(act(state), null);
    // Deliver the answer for seq k-2, far too late to be used.
    if (backlog.length >= 3) {
      const old = backlog[backlog.length - 3];
      w.reply({ type: 'logits', epoch: old.epoch, seq: old.seq, logits: peaked(ACTION.HOLD) });
    }
  }
  assert.equal(act.stats.misses, 5); // every decision after the first
});

test('bad passes retire the driver the same way the synchronous one does', () => {
  const w = fakeWorker((msg, reply) =>
    reply({ type: 'logits', epoch: msg.epoch, seq: msg.seq, logits: new Float32Array(N_ACTIONS).fill(NaN) }));
  const act = makeWorkerPolicy(w, manifest, { maxFailures: 2 }).init({ seed: 7 });

  assert.equal(act(state), null); // fill
  assert.equal(act(state), null); // NaN -> failure 1
  assert.equal(act(state), null); // NaN -> failure 2 -> retire
  assert.equal(act.stats.retired, true);
});

test('a reply from a previous episode is fenced off by its epoch', () => {
  let lastFrame = null;
  const w = fakeWorker((msg) => { lastFrame = msg; });
  const policy = makeWorkerPolicy(w, manifest, { maxMisses: 100 });

  const first = policy.init({ seed: 7 });
  first(state);
  const stale = lastFrame;

  const second = policy.init({ seed: 7 }); // rebuild: new epoch, reset posted
  second(state);
  // The old episode's answer arrives now, seq 0 — the seq the new episode is
  // about to look up. Without the fence this would be applied as if fresh.
  w.reply({ type: 'logits', epoch: stale.epoch, seq: stale.seq, logits: peaked(ACTION.ROLL_BASE) });
  assert.equal(second(state), null, 'stale-epoch logits must not drive the new episode');

  // The same answer under the new epoch does drive.
  const fresh = w.posted.filter((m) => m.type === 'frame').at(-1);
  w.reply({ type: 'logits', epoch: fresh.epoch, seq: fresh.seq, logits: peaked(ACTION.ROLL_BASE) });
  assert.equal(second(state), ACTION.ROLL_BASE);
});

test('dispose terminates the worker and a dead worker yields to the expert', () => {
  const w = fakeWorker((msg, reply) =>
    reply({ type: 'logits', epoch: msg.epoch, seq: msg.seq, logits: peaked(ACTION.HOLD) }));
  const policy = makeWorkerPolicy(w, manifest);
  const act = policy.init({ seed: 7 });
  act(state);
  assert.equal(act(state), ACTION.HOLD);

  policy.dispose();
  assert.equal(w.terminated, true);
  assert.equal(act(state), null);
});
