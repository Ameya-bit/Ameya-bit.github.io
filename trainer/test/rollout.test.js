import test from 'node:test';
import assert from 'node:assert/strict';

import { runEpisode, runEpisodes, arraySink, hatOf } from '../rollout.js';
import { isValidAction } from '../../assets/pandas/engine/actions.js';
import { TICKS_PER_ACTION } from '../../assets/pandas/engine/tick.js';

test('an episode is a pure function of (seed, config)', () => {
  const run = () => {
    const sink = arraySink((s, tick) => ({ tick, action: hatOf(s).action, x: hatOf(s).x }));
    runEpisode({ seed: 4242, config: { entrance: false }, ticks: 600, sink });
    return sink.rows;
  };
  assert.deepEqual(run(), run());
});

test('different seeds give different episodes', () => {
  const trace = (seed) => {
    const sink = arraySink();
    runEpisode({ seed, config: { entrance: false }, ticks: 600, sink });
    return JSON.stringify(sink.rows);
  };
  assert.notEqual(trace(1), trace(2));
});

test('recording defaults to the policy clock, and stride is honoured', () => {
  const sink = arraySink();
  const { samples } = runEpisode({ seed: 7, ticks: 600, sink });
  assert.equal(samples, 600 / TICKS_PER_ACTION);
  assert.equal(sink.rows.length, samples);

  const every = arraySink();
  runEpisode({ seed: 7, ticks: 600, stride: 1, sink: every });
  assert.equal(every.rows.length, 600);
});

test('warmup ticks run but are not recorded, and shift the recording window', () => {
  const warm = arraySink((s, tick) => tick);
  const { samples } = runEpisode({ seed: 9, ticks: 200, warmup: 400, sink: warm });
  assert.equal(samples, 100);
  assert.equal(warm.rows[0], TICKS_PER_ACTION); // ticks are numbered from the window
  assert.equal(warm.rows.at(-1), 200);

  // The warmup is real simulation, not a skip: 400 ticks in, the world has moved.
  const cold = arraySink((s) => hatOf(s).x);
  runEpisode({ seed: 9, ticks: 200, sink: cold });
  const hot = arraySink((s) => hatOf(s).x);
  runEpisode({ seed: 9, ticks: 200, warmup: 400, sink: hot });
  assert.notDeepEqual(cold.rows, hot.rows);
});

test('every recorded action is a legal action for the 17-way seam', () => {
  const sink = arraySink((s) => hatOf(s).action);
  runEpisode({ seed: 31337, config: { entrance: false }, ticks: 4000, sink });
  assert.ok(sink.rows.length > 0);
  for (const a of sink.rows) assert.ok(isValidAction(a), `illegal BC target: ${a}`);
});

test('the expert actually decides — the log is not all HOLD', () => {
  const sink = arraySink((s) => hatOf(s).action);
  runEpisode({ seed: 5150, config: { entrance: false }, ticks: 4000, sink });
  const kinds = new Set(sink.rows);
  assert.ok(kinds.size > 3, `expert emitted only ${kinds.size} distinct actions`);
  assert.ok(sink.rows.some((a) => a >= 1 && a <= 8), 'never stepped');
});

test('sinks are optional at every level', () => {
  assert.doesNotThrow(() => runEpisode({ seed: 1, ticks: 50 }));
  assert.doesNotThrow(() => runEpisode({ seed: 1, ticks: 50, sink: {} }));
});

test('runEpisodes threads one sink across episodes in order', () => {
  const seen = [];
  const sink = { begin: (ctx) => seen.push(ctx.seed) };
  const out = runEpisodes({ seeds: [11, 22, 33], ticks: 40, sink });
  assert.deepEqual(seen, [11, 22, 33]);
  assert.deepEqual(out.map((s) => s.seed), [11, 22, 33]);
});
