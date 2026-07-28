import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeVecEnv, EXPERT_ACTION } from '../vec.js';
import { ACTION } from '../../assets/pandas/engine/actions.js';

const SERVE = fileURLToPath(new URL('../vec-serve.js', import.meta.url));

function makeReader(stream) {
  const chunks = [];
  let have = 0;
  let waiting = null;
  const pump = () => {
    if (!waiting || have < waiting.need) return;
    const { need, resolve } = waiting;
    waiting = null;
    const buf = Buffer.concat(chunks, have);
    chunks.length = 0;
    have = buf.length - need;
    if (have) chunks.push(buf.subarray(need));
    resolve(buf.subarray(0, need));
  };
  stream.on('data', (c) => { chunks.push(c); have += c.length; pump(); });
  return (need) => new Promise((resolve) => { waiting = { need, resolve }; pump(); });
}

test('vec-serve speaks the protocol, and its stream matches the in-process fleet', async () => {
  const child = spawn(process.execPath, [
    SERVE, '--workers', '2', '--envs', '2', '--spec', 'wild',
    '--corpus-seed', '4242', '--ticks', '600',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  try {
    const read = makeReader(child.stdout);

    // Handshake: everything before the first newline is one JSON object.
    let line = Buffer.alloc(0);
    while (!line.includes(10)) line = Buffer.concat([line, await read(1)]);
    const hs = JSON.parse(line.toString());
    assert.equal(hs.protocol, 1);
    assert.equal(hs.envs, 4);
    assert.equal(hs.length, hs.tokens * hs.width);

    const recordBytes = hs.record.obs + hs.record.rewards + hs.record.dones
      + hs.record.applied + hs.record.returns;
    // Typed-array views need aligned offsets, which subarrays of one big buffer
    // do not have — so decode copies each lane into its own ArrayBuffer. (Not
    // Buffer.from: that copies into Node's shared pool, whose .buffer is the
    // pool.) The test pays; the trainer's NumPy reader does not — np.frombuffer
    // handles any offset.
    const decodeCopy = (buf) => {
      let at = 0;
      const lane = (n) => {
        const ab = new ArrayBuffer(n);
        new Uint8Array(ab).set(buf.subarray(at, (at += n)));
        return ab;
      };
      return {
        obs: new Float32Array(lane(hs.record.obs)),
        rewards: new Float32Array(lane(hs.record.rewards)),
        dones: new Uint8Array(lane(hs.record.dones)),
        applied: new Int8Array(lane(hs.record.applied)),
        returns: new Float32Array(lane(hs.record.returns)),
      };
    };

    const solo = makeVecEnv({ envs: 4, spec: 'wild', corpusSeed: 4242, ticks: 600 });
    const first = decodeCopy(await read(recordBytes));
    assert.deepEqual([...first.obs], [...solo.reset().obs]);

    const acts = new Int8Array(4);
    for (let k = 0; k < 30; k++) {
      for (let i = 0; i < 4; i++) acts[i] = (k + i) % 3 === 0 ? ACTION.HOLD : EXPERT_ACTION;
      child.stdin.write(Buffer.from(acts.buffer.slice(0)));
      const got = decodeCopy(await read(recordBytes));
      const want = solo.step(acts);
      assert.deepEqual([...got.obs], [...want.obs], `obs diverged at decision ${k}`);
      assert.deepEqual([...got.rewards], [...want.rewards]);
      assert.deepEqual([...got.dones], [...want.dones]);
      assert.deepEqual([...got.applied], [...want.applied]);
      assert.deepEqual([...got.returns], [...want.returns]);
    }

    // Closing stdin ends the process cleanly.
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
  } finally {
    child.kill();
  }
});
