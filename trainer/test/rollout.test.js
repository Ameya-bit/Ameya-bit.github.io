import test from 'node:test';
import assert from 'node:assert/strict';

import { runEpisode, runEpisodes, delayPolicy, arraySink, hatOf } from '../rollout.js';
import { ACTION, isValidAction } from '../../assets/pandas/engine/actions.js';
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

test('delayPolicy returns the answer computed one decision earlier', () => {
  // The wrapper never reads the state, so its contract is testable in isolation:
  // what comes out at consultation k must be what the inner policy said at k-1,
  // and the first `delay` consultations must be null — the rules expert drives
  // while the pipeline fills, exactly as the page behaves before the worker's
  // first result lands.
  const probe = { init: () => (state, tick) => tick };
  const act = delayPolicy(probe, 1).init({});
  assert.equal(act('s', 2), null);
  assert.equal(act('s', 4), 2);
  assert.equal(act('s', 6), 4);

  const two = delayPolicy(probe, 2).init({});
  assert.equal(two('s', 2), null);
  assert.equal(two('s', 4), null);
  assert.equal(two('s', 6), 2);
});

test('a delayed policy still shapes the episode through the seam', () => {
  // Integration: the wrapper composes with runEpisode — the inner policy is
  // consulted once per decision tick, and its (shifted) answers actually drive.
  const asked = [];
  const probe = {
    init: () => (state, tick) => {
      asked.push(tick);
      return ACTION.HOLD; // never limited, never illegal
    },
  };
  const held = arraySink((s) => hatOf(s).action);
  runEpisode({
    seed: 77, config: { entrance: false }, ticks: 400,
    policy: delayPolicy(probe, 1), sink: held,
  });
  assert.equal(asked.length, 400 / TICKS_PER_ACTION);
  // Decision 1 fell back to the expert; every one after applied the probe's HOLD.
  assert.ok(held.rows.slice(1).every((a) => a === ACTION.HOLD));

  // …and that is not what the expert would have done on its own (see the
  // 'expert actually decides' test above, same seed family).
  const expertRows = arraySink((s) => hatOf(s).action);
  runEpisode({ seed: 77, config: { entrance: false }, ticks: 400, sink: expertRows });
  assert.notDeepEqual(held.rows, expertRows.rows);
});

test('delayPolicy(_, 0) is the policy itself, and a bad delay throws', () => {
  const p = { init: () => () => ACTION.HOLD };
  assert.equal(delayPolicy(p, 0), p);
  assert.throws(() => delayPolicy(p, -1), /non-negative integer/);
  assert.throws(() => delayPolicy(p, 1.5), /non-negative integer/);
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

// ---- the stepper (E0) ----
//
// `makeEpisodeStepper` is the same episode loop inverted: it pauses at every
// decision tick and the caller supplies the action. `runEpisode` is reimplemented
// on top of it, so these tests pin the inversion, not a second loop.

test('a stepper-driven episode is identical to runEpisode with the same policy', async () => {
  const { makeEpisodeStepper } = await import('../rollout.js');
  const policy = {
    init: () => (state, tick) => (tick % 6 === 0 ? ACTION.HOLD : null),
  };
  const viaRun = arraySink((s) => ({ x: hatOf(s).x, y: hatOf(s).y, a: hatOf(s).action }));
  runEpisode({ seed: 515, config: { entrance: false }, ticks: 800, policy, sink: viaRun });

  const viaStep = arraySink((s) => ({ x: hatOf(s).x, y: hatOf(s).y, a: hatOf(s).action }));
  const stepper = makeEpisodeStepper({ seed: 515, config: { entrance: false }, ticks: 800, sink: viaStep });
  const act = policy.init(stepper.ctx);
  let at = stepper.start();
  while (at) at = stepper.advance(act(at.state, at.tick));
  const summary = stepper.summary();

  assert.deepEqual(viaStep.rows, viaRun.rows);
  assert.equal(summary.samples, 800 / TICKS_PER_ACTION);
});

test('the stepper pauses at every decision tick, with the state acted FROM', async () => {
  const { makeEpisodeStepper } = await import('../rollout.js');
  // Collect the states runEpisode hands its policy…
  const seen = [];
  runEpisode({
    seed: 99, config: { entrance: false }, ticks: 200,
    policy: { init: () => (s, t) => { seen.push({ t, x: hatOf(s).x }); return null; } },
  });
  // …and the pauses the stepper surfaces. Same ticks, same pre-step states.
  const paused = [];
  const stepper = makeEpisodeStepper({ seed: 99, config: { entrance: false }, ticks: 200 });
  let at = stepper.start();
  while (at) { paused.push({ t: at.tick, x: hatOf(at.state).x }); at = stepper.advance(null); }
  assert.deepEqual(paused, seen);
  assert.ok(paused.every((p) => p.t % TICKS_PER_ACTION === 0));
});

test('the stepper summary fires the sink end hook exactly once', async () => {
  const { makeEpisodeStepper } = await import('../rollout.js');
  let ends = 0;
  const stepper = makeEpisodeStepper({ seed: 3, ticks: 40, sink: { end: () => { ends += 1; } } });
  let at = stepper.start();
  while (at) at = stepper.advance(null);
  stepper.summary();
  stepper.summary();
  assert.equal(ends, 1);
});
