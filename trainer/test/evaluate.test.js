import test from 'node:test';
import assert from 'node:assert/strict';

import { runEpisode, arraySink, hatOf, bindPolicy } from '../rollout.js';
import { scoreEpisode, evaluatePolicy, parseRules, DEFAULT_EVAL } from '../evaluate.js';
import { policyByName, POLICIES, expert, still } from '../policies.js';
import { ACTION, stepAction } from '../../assets/pandas/engine/actions.js';
import { TICKS_PER_ACTION } from '../../assets/pandas/engine/tick.js';

const EP = { seed: 8123, config: { entrance: false }, ticks: 2000 };

// ---- the policy seam ----

test('a policy drives the hat, and the engine logs exactly what it applied', () => {
  const sink = arraySink((s) => hatOf(s).action);
  runEpisode({ ...EP, sink, policy: still });
  assert.ok(sink.rows.length > 0);
  assert.ok(sink.rows.every((a) => a === ACTION.HOLD), 'the still policy moved');
});

test('the policy is consulted once per decision tick, on the state it acts from', () => {
  const ticksSeen = [];
  runEpisode({
    ...EP,
    ticks: 40,
    policy: (state, tick) => {
      ticksSeen.push(tick);
      // It acts FROM tick-1 and its action lands on tick: the state it is handed is
      // always one behind the tick it is deciding for.
      assert.equal(state.tick, tick - 1);
      return ACTION.HOLD;
    },
  });
  assert.deepEqual(ticksSeen, Array.from({ length: 20 }, (_, i) => (i + 1) * TICKS_PER_ACTION));
});

test('a policy that returns null is the expert, exactly', () => {
  const trace = (policy) => {
    const sink = arraySink((s) => [hatOf(s).action, hatOf(s).x, hatOf(s).y]);
    runEpisode({ ...EP, sink, policy });
    return sink.rows;
  };
  assert.deepEqual(trace(expert), trace(null));
  assert.deepEqual(trace(() => null), trace(null));
});

test('a malformed action falls back to the expert rather than freezing him', () => {
  // The engine's `isValidAction` guard, reached from the trainer side: this is the
  // same path a NaN logit takes in Phase D's `?policy=nn` kill switch.
  const junk = (v) => {
    const sink = arraySink((s) => hatOf(s).action);
    runEpisode({ ...EP, sink, policy: () => v });
    return sink.rows;
  };
  const baseline = junk(null);
  assert.deepEqual(junk(NaN), baseline);
  assert.deepEqual(junk(99), baseline);
  assert.deepEqual(junk(-1), baseline);
});

test('bindPolicy takes a function, a factory, or nothing', () => {
  const ctx = { seed: 5 };
  assert.equal(bindPolicy(null, ctx), null);
  const fn = () => ACTION.HOLD;
  assert.equal(bindPolicy(fn, ctx), fn);
  assert.equal(typeof bindPolicy({ init: () => fn }, ctx), 'function');
  assert.throws(() => bindPolicy({}, ctx), /must be a function/);
});

test('an episode stays a pure function of (seed, config, policy)', () => {
  const run = () => scoreEpisode({ ...EP, policy: policyByName('random') }).score;
  assert.equal(run(), run());
  // …including the policy's own PRNG, which is derived from the seed and not shared
  // with the sim's stream.
  const other = scoreEpisode({ ...EP, seed: EP.seed + 1, policy: policyByName('random') }).score;
  assert.notEqual(run(), other);
});

// ---- the instrument ----

test('every named policy runs and produces a finite score', () => {
  for (const [name, policy] of Object.entries(POLICIES)) {
    const r = scoreEpisode({ ...EP, policy });
    assert.ok(Number.isFinite(r.score), `${name} scored ${r.score}`);
    assert.equal(r.ticks, EP.ticks);
    assert.equal(
      Math.round(r.score * 1e6) / 1e6,
      Math.round((r.components.view + r.components.step + r.components.roll + r.components.knock) * 1e6) / 1e6,
      `${name}: components do not sum to the score`,
    );
  }
});

test('the expert beats standing still on the eval distribution', () => {
  // The one end-to-end claim C1 can make on its own: the incumbent — the watcher
  // the site actually runs — is worth more than the do-nothing floor. If this ever
  // goes red the game has stopped being about watching, and every later number in
  // Phase C is measuring something else. (It is `natural` on purpose: it does NOT
  // hold on `dense`, which is written up in the README as the phase's first finding.)
  const opts = { episodes: 8, ticks: 6000, spec: 'natural' };
  const a = evaluatePolicy({ ...opts, policy: expert, name: 'expert' });
  const b = evaluatePolicy({ ...opts, policy: still, name: 'still' });
  assert.ok(
    a.scorePerMin.mean > b.scorePerMin.mean,
    `expert ${a.scorePerMin.mean.toFixed(1)} vs still ${b.scorePerMin.mean.toFixed(1)}`,
  );
  assert.ok(a.tickCoverage.mean > b.tickCoverage.mean * 2, 'the expert should watch far more');
});

test('the eval set is the eval corpus — same seeds, same worlds', async () => {
  const { episodeSeeds } = await import('../corpus.js');
  const manifest = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      new URL('../corpora/eval-natural.manifest.json', import.meta.url), 'utf8',
    ),
  );
  assert.equal(DEFAULT_EVAL.corpusSeed, manifest.corpusSeed);
  assert.equal(DEFAULT_EVAL.spec, manifest.spec);
  // The first few episodes a default eval scores are the first few shards.
  const seeds = episodeSeeds(DEFAULT_EVAL.corpusSeed, 4);
  assert.deepEqual(seeds, manifest.shards.slice(0, 4).map((s) => s.seed));
});

test('--rules parses knobs and refuses ones that do not exist', () => {
  assert.deepEqual(parseRules('viewRadius=240,knockPenalty=0'), { viewRadius: 240, knockPenalty: 0 });
  assert.deepEqual(parseRules(''), {});
  assert.throws(() => parseRules('viewRaduis=240'), /unknown rule/);
  assert.throws(() => parseRules('viewRadius=wide'), /needs a number/);
});

test('rules changes actually move the score', () => {
  const at = (rules) => scoreEpisode({ ...EP, policy: expert, rules }).score;
  const base = at({});
  assert.notEqual(at({ knockPenalty: 0 }), base);
  assert.notEqual(at({ viewRadius: 400 }), base);
  assert.ok(at({ stepCost: 0 }) > base, 'free movement should never score worse');
  // A step action is what stepCost prices, so a policy that only holds is immune.
  const holdOnly = (rules) => scoreEpisode({ ...EP, policy: still, rules }).components.step;
  assert.ok(holdOnly({ stepCost: 99 }) === 0);
  assert.notEqual(scoreEpisode({ ...EP, policy: () => stepAction(0), rules: { stepCost: 99 } }).components.step, 0);
});
