import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashNumbers, foldHashes, hex } from '../tools/checksum.js';
import { runSeed, runTrace, firstDivergence, PHASE_A_SEEDS } from '../tools/trace.js';
import { demoEngine } from '../tools/demo-engine.js';

test('hashNumbers is deterministic and order-sensitive', () => {
  assert.equal(hashNumbers([1, 2, 3]), hashNumbers([1, 2, 3]));
  assert.notEqual(hashNumbers([1, 2, 3]), hashNumbers([3, 2, 1]));
});

test('hashNumbers treats -0 and 0 identically but is sensitive otherwise', () => {
  assert.equal(hashNumbers([0]), hashNumbers([-0]));
  assert.notEqual(hashNumbers([0]), hashNumbers([1e-12]));
});

test('foldHashes is deterministic and order-sensitive', () => {
  assert.equal(foldHashes([1, 2, 3]), foldHashes([1, 2, 3]));
  assert.notEqual(foldHashes([1, 2, 3]), foldHashes([1, 3, 2]));
});

test('hex is a fixed 8-char lowercase representation', () => {
  assert.equal(hex(0), '00000000');
  assert.equal(hex(0xdeadbeef), 'deadbeef');
  assert.match(hex(1), /^[0-9a-f]{8}$/);
});

test('runSeed is reproducible for a given seed', () => {
  const a = runSeed({ engine: demoEngine, seed: 123, ticks: 200 });
  const b = runSeed({ engine: demoEngine, seed: 123, ticks: 200 });
  assert.equal(a.digest, b.digest);
});

test('different seeds produce different digests', () => {
  const a = runSeed({ engine: demoEngine, seed: 1, ticks: 200 });
  const b = runSeed({ engine: demoEngine, seed: 2, ticks: 200 });
  assert.notEqual(a.digest, b.digest);
});

test('keepStream yields a per-tick hash for every tick plus tick 0', () => {
  const { stream } = runSeed({ engine: demoEngine, seed: 7, ticks: 50, keepStream: true });
  assert.equal(stream.length, 51);
});

test('firstDivergence pinpoints the first differing tick', () => {
  const a = runSeed({ engine: demoEngine, seed: 7, ticks: 100, keepStream: true });
  const b = runSeed({ engine: demoEngine, seed: 7, ticks: 100, keepStream: true });
  assert.equal(firstDivergence(a.stream, b.stream), -1);

  const c = runSeed({ engine: demoEngine, seed: 8, ticks: 100, keepStream: true });
  // Seeds 7 and 8 start differently, so they diverge at tick 0.
  assert.equal(firstDivergence(a.stream, c.stream), 0);
});

test('runTrace over the 32-seed set is reproducible', () => {
  const a = runTrace({ engine: demoEngine, seeds: PHASE_A_SEEDS, ticks: 300 });
  const b = runTrace({ engine: demoEngine, seeds: PHASE_A_SEEDS, ticks: 300 });
  assert.equal(a.batch, b.batch);
  assert.equal(a.seeds.length, 32);
});

test('PHASE_A_SEEDS is 32 distinct int32 seeds', () => {
  assert.equal(PHASE_A_SEEDS.length, 32);
  assert.equal(new Set(PHASE_A_SEEDS).size, 32);
  assert.ok(PHASE_A_SEEDS.every((s) => Number.isInteger(s) && (s | 0) === s));
});

test('a one-field state perturbation changes the digest (checksum is sensitive)', () => {
  // A hand-built micro-engine: two runs identical except one number at tick 5.
  const base = {
    init: (seed) => ({ tick: 0, v: seed }),
    step: (s) => ({ tick: s.tick + 1, v: s.v }),
    encode: (s) => [s.tick, s.v],
  };
  const perturbed = {
    init: (seed) => ({ tick: 0, v: seed }),
    step: (s) => ({ tick: s.tick + 1, v: s.tick === 4 ? s.v + 1e-9 : s.v }),
    encode: (s) => [s.tick, s.v],
  };
  const a = runSeed({ engine: base, seed: 1, ticks: 10 });
  const b = runSeed({ engine: perturbed, seed: 1, ticks: 10 });
  assert.notEqual(a.digest, b.digest);
});
