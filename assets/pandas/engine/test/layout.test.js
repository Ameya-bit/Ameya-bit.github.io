import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeArea, pandaCountForViewport, DEFAULT_DENSITY } from '../layout.js';

test('freeArea subtracts the fence', () => {
  assert.equal(freeArea(1000, 1000, null), 1_000_000);
  assert.equal(freeArea(1000, 1000, { l: 0, t: 0, r: 100, b: 100 }), 990_000);
});

test('pandaCount scales with viewport area', () => {
  const small = pandaCountForViewport(1000, 600, null, { min: 1, max: 100 });
  const large = pandaCountForViewport(2400, 1200, null, { min: 1, max: 100 });
  assert.ok(large > small, `expected more pandas on the larger viewport (${small} -> ${large})`);
});

test('pandaCount holds density constant', () => {
  const opts = { areaPerPanda: 100_000, min: 1, max: 1000 };
  // Doubling area roughly doubles the count.
  const a = pandaCountForViewport(1000, 1000, null, opts); // 10
  const b = pandaCountForViewport(2000, 1000, null, opts); // 20
  assert.equal(a, 10);
  assert.equal(b, 20);
});

test('pandaCount clamps to [min, max]', () => {
  assert.equal(pandaCountForViewport(200, 200, null, { areaPerPanda: 100_000, min: 6, max: 28 }), 6);
  assert.equal(pandaCountForViewport(9000, 9000, null, { areaPerPanda: 100_000, min: 6, max: 28 }), 28);
});

test('defaults are sane', () => {
  const n = pandaCountForViewport(1920, 1080, { l: 700, t: 400, r: 1200, b: 700 });
  assert.ok(n >= DEFAULT_DENSITY.min && n <= DEFAULT_DENSITY.max);
});
