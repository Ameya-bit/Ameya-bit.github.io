// The vec fleet on a pipe — Node's half of the Python bridge.
//
//   node vec-serve.js --workers 8 --envs 64 --spec wild --corpus-seed 20260728
//
// Speaks to `trainer/py/vecenv.py` over stdio. One JSON line of handshake, then
// fixed-size binary records both ways — the corpus-shard philosophy on a socket:
// the readable part says what the bytes mean, the bytes are raw little-endian
// arrays, and the loader on the far side is `np.frombuffer` and a reshape, not a
// parser.
//
//   out (handshake) : one JSON line — env counts, the observation layout, the
//                     rules, the record sizes. Everything the reader needs.
//   out (record)    : obs f32[envs×length] · rewards f32[envs] · dones u8[envs]
//                     · applied i8[envs] · returns f32[envs], concatenated.
//                     The first record is the initial frames (a VecEnv reset).
//   in  (actions)   : i8[envs] — 0..16, or −1 for "the rules expert drives".
//
// One record out per actions-in, lockstep, until stdin closes; then the fleet is
// torn down and the process exits. Lockstep is not a throughput compromise: the
// batch is hundreds of envs, so the pipe round-trip amortises to microseconds per
// decision, and Python overlaps its forward pass with nothing anyway (the GPU
// batch IS the round-trip). Determinism needs the ordering; lockstep gives it.
//
// stdout is the protocol. Anything human-facing goes to stderr.

import { makeVecHost } from './vec-host.js';
import { parseRules } from './evaluate.js';
import { GAME_VERSION } from './game.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

// Exact-byte reads off a stream, for the lockstep action records.
function makeStreamReader(stream) {
  const chunks = [];
  let have = 0;
  let waiting = null; // { need, resolve }
  let ended = false;

  const pump = () => {
    if (!waiting || have < waiting.need) return;
    const { need, resolve } = waiting;
    waiting = null;
    const buf = Buffer.concat(chunks, have).subarray(0, have);
    const head = buf.subarray(0, need);
    const rest = buf.subarray(need);
    chunks.length = 0;
    have = rest.length;
    if (rest.length) chunks.push(Buffer.from(rest));
    resolve(head);
  };

  stream.on('data', (chunk) => { chunks.push(chunk); have += chunk.length; pump(); });
  stream.on('end', () => { ended = true; if (waiting) { waiting.resolve(null); waiting = null; } });
  stream.on('error', () => { ended = true; if (waiting) { waiting.resolve(null); waiting = null; } });

  return (need) => {
    if (have >= need) {
      return new Promise((resolve) => { waiting = { need, resolve }; pump(); });
    }
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => { waiting = { need, resolve }; });
  };
}

const write = (buf) => new Promise((resolve, reject) => {
  process.stdout.write(buf, (err) => (err ? reject(err) : resolve()));
});

async function writeRecord(out) {
  // One buffer, one write: a record must never interleave with another.
  const record = Buffer.concat([
    Buffer.from(out.obs.buffer, out.obs.byteOffset, out.obs.byteLength),
    Buffer.from(out.rewards.buffer, out.rewards.byteOffset, out.rewards.byteLength),
    Buffer.from(out.dones.buffer, out.dones.byteOffset, out.dones.byteLength),
    Buffer.from(out.applied.buffer, out.applied.byteOffset, out.applied.byteLength),
    Buffer.from(out.returns.buffer, out.returns.byteOffset, out.returns.byteLength),
  ]);
  await write(record);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workers = Number(args.workers ?? 4);
  const envsPerWorker = Number(args.envs ?? 32);
  const opts = {
    workers,
    envsPerWorker,
    spec: args.spec ?? 'wild',
    corpusSeed: args['corpus-seed'] === undefined ? 20260728 : Number(args['corpus-seed']),
    ticks: args.ticks === undefined ? 12000 : Number(args.ticks),
    rules: parseRules(args.rules),
    stagger: args.stagger === undefined ? true : args.stagger !== '0',
  };

  const host = await makeVecHost(opts);
  const { layout } = host;
  const envs = host.envs;

  const handshake = {
    protocol: 1,
    envs,
    workers,
    envsPerWorker,
    tokens: layout.tokens,
    width: layout.width,
    length: layout.length,
    nActions: 17,
    expertAction: -1,
    spec: opts.spec,
    corpusSeed: opts.corpusSeed,
    ticks: opts.ticks,
    stagger: opts.stagger,
    rules: opts.rules,
    gameVersion: GAME_VERSION,
    record: {
      obs: envs * layout.length * 4,
      rewards: envs * 4,
      dones: envs,
      applied: envs,
      returns: envs * 4,
    },
  };
  await write(`${JSON.stringify(handshake)}\n`);
  await writeRecord(host.first);

  const read = makeStreamReader(process.stdin);
  for (;;) {
    const buf = await read(envs);
    if (buf === null) break; // stdin closed — the trainer is done with us
    const actions = new Int8Array(buf.buffer, buf.byteOffset, envs);
    await writeRecord(await host.step(actions));
  }

  await host.close();
}

main().catch((err) => {
  process.stderr.write(`vec-serve: ${err.stack}\n`);
  process.exit(1);
});
