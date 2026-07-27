// Throughput — Phase B's exit bar is >= ~50k ticks/s/core.
//
// It is measured per corpus spec rather than as one number, because the cost is
// dominated by collision detection, which is O(n^2) in the panda count: 16 corner
// pairs per pair of bodies, every tick. So the honest question is not "how fast is
// the engine" but "how fast is the engine on the worlds we are actually going to
// record", and `dense` is the one that has to clear the bar.
//
// All three columns matter, and the last one is the honest one: a corpus is not raw
// ticks, it is observed, labelled ticks. So the runs escalate — the sim alone, then
// the B2 encoder at the policy's 10 Hz clock, then the full B3 recording with
// per-tick ground truth, which walks each episode twice and is what the cut will
// actually run.
//
//   node bench.js [--ticks 40000] [--episodes 8]

import { runEpisode } from './rollout.js';
import { SPECS, configFactory, episodeSeeds } from './corpus.js';
import { makeObserver } from '../assets/pandas/engine/policy/obs.js';
import { recordEpisode } from './truth.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const TICKS = arg('ticks', 40000);
const EPISODES = arg('episodes', 8);
const BAR = 50000;

console.log(`throughput — ${EPISODES} episodes x ${TICKS} ticks per spec, single core\n`);

// One timed pass over a spec's episodes, at one of three depths:
//   raw     — the sim alone
//   obs     — plus the observation encoder, on the policy's 10 Hz clock
//   record  — plus per-tick ground truth, which is what a corpus shard holds
// The last is the honest number for the cut, and it is roughly 2x the first
// because ground truth walks the episode twice (see truth.js).
function measure(configFor, seeds, depth) {
  let counts = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < EPISODES; i++) {
    const cfg = configFor(seeds[i], i);
    counts += cfg.pandaCount;
    if (depth === 'record') {
      recordEpisode({
        seed: seeds[i], config: cfg, ticks: TICKS, observer: makeObserver(), onRow: () => {},
      });
      continue;
    }
    let sink = null;
    if (depth === 'obs') {
      const obs = makeObserver();
      const mem = obs.init();
      sink = { sample: (state) => obs.observe(state, mem) };
    }
    runEpisode({ seed: seeds[i], config: cfg, ticks: TICKS, sink });
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  return { rate: (EPISODES * TICKS) / secs, pandas: counts / EPISODES, secs };
}

const rows = [];
for (const name of Object.keys(SPECS)) {
  const configFor = configFactory(name, 20260727);
  const seeds = episodeSeeds(20260727, EPISODES);

  // Warm V8 on this spec's shapes before timing.
  runEpisode({ seed: seeds[0], config: configFor(seeds[0], 0), ticks: 2000 });

  const raw = measure(configFor, seeds, 'raw');
  const obs = measure(configFor, seeds, 'obs');
  const rec = measure(configFor, seeds, 'record');
  rows.push({ name, ...raw, obsRate: obs.rate, recRate: rec.rate });
}

const pad = (s, n) => String(s).padEnd(n);
const k = (r) => `${(r / 1000).toFixed(1)}k`;
console.log(`${pad('spec', 10)}${pad('mean pandas', 14)}${pad('ticks/s', 12)}${pad('+encoder', 12)}` +
  `${pad('+truth', 12)}${pad('sim-time/wall', 15)}bar`);
for (const r of rows) {
  const speedup = (r.recRate * 0.05).toFixed(0); // 50ms per tick of simulated time
  console.log(
    `${pad(r.name, 10)}${pad(r.pandas.toFixed(1), 14)}${pad(k(r.rate), 12)}${pad(k(r.obsRate), 12)}` +
    `${pad(k(r.recRate), 12)}${pad(`${speedup}x`, 15)}${r.recRate >= BAR ? 'PASS' : 'MISS'}`,
  );
}

// The binding number is the fully recorded one: a corpus is observed, labelled
// ticks — not raw ones.
const worst = rows.reduce((a, b) => (a.recRate < b.recRate ? a : b));
console.log(`\nslowest spec: ${worst.name} at ${k(worst.recRate)} recorded ticks/s ` +
  `(bar ${BAR / 1000}k) — ${worst.recRate >= BAR ? 'exit bar met on one core' : 'BELOW THE BAR'}`);
console.log(`a 10M-tick corpus at that rate: ${(10e6 / worst.recRate / 60).toFixed(1)} core-minutes`);
