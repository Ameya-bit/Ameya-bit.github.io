import test from 'node:test';
import assert from 'node:assert/strict';

import { SPECS, configFactory, episodeSeeds } from '../corpus.js';
import { DEFAULT_CONFIG, makeConfig } from '../../assets/pandas/engine/config.js';
import { Rng } from '../../assets/pandas/engine/rng.js';
import { runEpisode } from '../rollout.js';

const SPEC_NAMES = Object.keys(SPECS);

// makeConfig is a shallow merge that silently ignores unknown fields, so a typo in
// a spec ("cascadeGapMin" for "cascadeArmMin") would not throw — it would quietly
// train on shipped defaults and be discovered, if ever, as an unexplained result.
test('every key a spec emits is a real engine config key', () => {
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const name of SPEC_NAMES) {
    for (let i = 0; i < 50; i++) {
      for (const key of Object.keys(SPECS[name](new Rng(i)))) {
        assert.ok(known.has(key), `${name} emits unknown config key "${key}"`);
      }
    }
  }
});

test('specs are pure functions of their rng', () => {
  for (const name of SPEC_NAMES) {
    assert.deepEqual(SPECS[name](new Rng(99)), SPECS[name](new Rng(99)));
  }
});

test('specs produce worlds the engine accepts and can run', () => {
  for (const name of SPEC_NAMES) {
    const cfg = SPECS[name](new Rng(2026));
    assert.doesNotThrow(() => makeConfig(cfg));
    assert.doesNotThrow(() => runEpisode({ seed: 5, config: cfg, ticks: 300 }));
  }
});

test('every sampled world is physically sane', () => {
  for (const name of SPEC_NAMES) {
    for (let i = 0; i < 200; i++) {
      const c = SPECS[name](new Rng(i * 7919));
      assert.ok(c.pandaCount >= 2, `${name}: ${c.pandaCount} pandas`);
      assert.ok(c.width > 0 && c.height > 0);
      // The fence must leave a walkable stage, or pandas have nowhere to be.
      const fenceArea = (c.forbid.r - c.forbid.l) * (c.forbid.b - c.forbid.t);
      assert.ok(fenceArea < c.width * c.height * 0.75, `${name}: fence swallows the stage`);
      assert.ok(c.forbid.l >= 0 && c.forbid.t >= 0);
      assert.ok(c.forbid.r <= c.width && c.forbid.b <= c.height);
      // Ranges must not be inverted — an anomaly window of [11s, 6s] is a bug that
      // shows up as a frozen director, not an exception.
      if (c.anomGapMin != null) assert.ok(c.anomGapMax > c.anomGapMin, `${name}: inverted anom gap`);
      if (c.sleepMin != null) assert.ok(c.sleepMax > c.sleepMin, `${name}: inverted sleep range`);
      if (c.stareMin != null) assert.ok(c.stareMax > c.stareMin, `${name}: inverted stare range`);
      if (c.stackGapMin != null) assert.ok(c.stackGapMax > c.stackGapMin, `${name}: inverted stack gap`);
      if (c.cascadeArmMin != null) assert.ok(c.cascadeArmMax > c.cascadeArmMin, `${name}: inverted arm gap`);
    }
  }
});

test('the training spec actually varies its axes — diversity is the point', () => {
  const seen = { pandaCount: new Set(), width: new Set(), entrance: new Set(), sleepMin: new Set() };
  for (let i = 0; i < 300; i++) {
    const c = SPECS.wild(new Rng(i * 104729));
    for (const k of Object.keys(seen)) seen[k].add(c[k]);
  }
  assert.ok(seen.pandaCount.size > 8, `density barely moves: ${seen.pandaCount.size} values`);
  assert.ok(seen.width.size > 100);
  assert.equal(seen.entrance.size, 2, 'episodes never open mid-scene');
  assert.ok(seen.sleepMin.size > 50);
});

test('natural stays on the shipped density rule', () => {
  for (let i = 0; i < 100; i++) {
    const c = SPECS.natural(new Rng(i));
    assert.equal(c.entrance, true);
    // Nothing but stage + count: the live site's own timings, untouched.
    assert.deepEqual(Object.keys(c).sort(), ['entrance', 'forbid', 'height', 'pandaCount', 'width']);
  }
});

test('dense is denser than natural on the same stage', () => {
  let denser = 0;
  for (let i = 0; i < 100; i++) {
    if (SPECS.dense(new Rng(i)).pandaCount > SPECS.natural(new Rng(i)).pandaCount) denser++;
  }
  assert.ok(denser > 90, `dense only beat natural ${denser}/100 times`);
});

test('episode seeds are distinct and reproducible from one root', () => {
  const a = episodeSeeds(2026, 500);
  assert.equal(new Set(a).size, 500);
  assert.deepEqual(a, episodeSeeds(2026, 500));
  assert.notDeepEqual(a, episodeSeeds(2027, 500));
});

test('configFactory gives each episode its own world, reproducibly', () => {
  const f = configFactory('wild', 11);
  const g = configFactory('wild', 11);
  assert.deepEqual(f(0, 0), g(0, 0));
  assert.notDeepEqual(f(0, 0), f(0, 1)); // episode index, not episode seed, picks the world
  assert.throws(() => configFactory('nope', 1), /unknown corpus spec/);
});
