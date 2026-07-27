// Throughput — Phase B's exit bar is >= ~50k ticks/s/core.
//
// It is measured per corpus spec rather than as one number, because the cost is
// dominated by collision detection, which is O(n^2) in the panda count: 16 corner
// pairs per pair of bodies, every tick. So the honest question is not "how fast is
// the engine" but "how fast is the engine on the worlds we are actually going to
// record", and `dense` is the one that has to clear the bar.
//
// Both columns matter: a corpus is not raw ticks, it is *observed* ticks, so the
// second run puts the B2 observation encoder in the loop at the policy's 10 Hz
// clock — the shape the corpus cut will actually run in.
//
//   node bench.js [--ticks 40000] [--episodes 8]

import { runEpisode } from './rollout.js';
import { SPECS, configFactory, episodeSeeds } from './corpus.js';
import { makeObserver } from '../assets/pandas/engine/policy/obs.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const TICKS = arg('ticks', 40000);
const EPISODES = arg('episodes', 8);
const BAR = 50000;

console.log(`throughput — ${EPISODES} episodes x ${TICKS} ticks per spec, single core\n`);

// One timed pass over a spec's episodes. `observed` puts the observation encoder
// in the loop, recording on the policy clock exactly as the corpus writer will.
function measure(configFor, seeds, observed) {
  let counts = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < EPISODES; i++) {
    const cfg = configFor(seeds[i], i);
    counts += cfg.pandaCount;
    let sink = null;
    if (observed) {
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

  const raw = measure(configFor, seeds, false);
  const obs = measure(configFor, seeds, true);
  rows.push({ name, ...raw, obsRate: obs.rate });
}

const pad = (s, n) => String(s).padEnd(n);
const k = (r) => `${(r / 1000).toFixed(1)}k`;
console.log(`${pad('spec', 10)}${pad('mean pandas', 14)}${pad('ticks/s', 12)}${pad('+encoder', 12)}` +
  `${pad('sim-time/wall', 15)}bar`);
for (const r of rows) {
  const speedup = (r.obsRate * 0.05).toFixed(0); // 50ms per tick of simulated time
  console.log(
    `${pad(r.name, 10)}${pad(r.pandas.toFixed(1), 14)}${pad(k(r.rate), 12)}${pad(k(r.obsRate), 12)}` +
    `${pad(`${speedup}x`, 15)}${r.obsRate >= BAR ? 'PASS' : 'MISS'}`,
  );
}

// The binding number is the observed one: a corpus is observed ticks, not raw ones.
const worst = rows.reduce((a, b) => (a.obsRate < b.obsRate ? a : b));
console.log(`\nslowest spec: ${worst.name} at ${k(worst.obsRate)} observed ticks/s ` +
  `(bar ${BAR / 1000}k) — ${worst.obsRate >= BAR ? 'exit bar met on one core' : 'BELOW THE BAR'}`);
console.log(`a 10M-tick corpus at that rate: ${(10e6 / worst.obsRate / 60).toFixed(1)} core-minutes`);
