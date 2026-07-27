// Golden-trace CLI — the Node side of the Phase-A determinism gate.
//
// Runs an engine across the fixed 32-seed set for N ticks and prints per-seed
// digests plus a batch digest. The same computation runs in the browser via
// tools/golden.html; when the real engine is wired up, matching batch digests
// between this command and that page are the "byte-identical browser vs Node"
// acceptance criterion.
//
// Usage:
//   node tools/golden.js [--ticks N] [--engine ./path/to/engine.js]
//
// Defaults to the toy demo engine and 10000 ticks. The engine module must export
// `init`, `step`, and `encode` (see tools/trace.js for the contract).

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runTrace, PHASE_A_SEEDS } from './trace.js';
import { hex } from './checksum.js';

// The built-in toy engine, resolved from this file's location so the default
// works regardless of CWD. A user-supplied `--engine ./foo.js` is resolved
// against CWD instead.
const DEMO_ENGINE_URL = new URL('./demo-engine.js', import.meta.url).href;

function parseArgs(argv) {
  const args = { ticks: 10000, engine: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ticks') args.ticks = Number(argv[++i]);
    else if (argv[i] === '--engine') args.engine = argv[++i];
  }
  if (!Number.isInteger(args.ticks) || args.ticks <= 0) {
    throw new Error(`--ticks must be a positive integer, got ${args.ticks}`);
  }
  return args;
}

async function loadEngine(spec) {
  const url = spec === null ? DEMO_ENGINE_URL : pathToFileURL(resolve(process.cwd(), spec)).href;
  const mod = await import(url);
  const engine = mod.default ?? mod;
  for (const fn of ['init', 'step', 'encode']) {
    if (typeof engine[fn] !== 'function') {
      throw new Error(`engine ${spec ?? '(demo)'} is missing export '${fn}'`);
    }
  }
  return engine;
}

async function main() {
  const { ticks, engine: spec } = parseArgs(process.argv.slice(2));
  const engine = await loadEngine(spec);
  const engineName = spec ?? 'demo-engine (built-in)';

  const run = () => runTrace({ engine, seeds: PHASE_A_SEEDS, ticks });
  const a = run();
  // Internal determinism guard: the Node run must be stable across repetition.
  const b = run();
  if (a.batch !== b.batch) {
    console.error('NONDETERMINISM: two Node runs produced different digests.');
    process.exit(1);
  }

  console.log(`engine: ${engineName}`);
  console.log(`seeds:  ${PHASE_A_SEEDS.length}   ticks: ${ticks}\n`);
  for (const { seed, digest } of a.seeds) {
    console.log(`  seed ${String(seed).padStart(12)}  ${hex(digest)}`);
  }
  console.log(`\nbatch digest: ${hex(a.batch)}`);
  console.log('(compare against tools/golden.html in the browser — must match)');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
