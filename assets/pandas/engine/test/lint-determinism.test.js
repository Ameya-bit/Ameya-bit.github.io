import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource } from '../tools/lint-determinism.js';

const msgs = (src, opts) => lintSource(src, opts).map((v) => v.msg);
const clean = (src, opts) => assert.deepEqual(lintSource(src, opts), []);

test('clean engine code passes', () => {
  clean(`
    import { sin, hypot, clamp } from './mathx.js';
    import { Rng } from './rng.js';
    export function step(state) {
      const rng = new Rng(state.rng);
      const d = hypot(state.x, state.y);
      const a = Math.floor(d) + Math.sqrt(4) * Math.imul(2, 3);
      return { ...state, a, wobble: sin(state.tick * 0.1), rng: rng.state };
    }
  `);
});

test('flags unseeded randomness', () => {
  assert.match(msgs('const x = Math.random();')[0], /Math\.random/);
});

test('flags wall-clock reads', () => {
  assert.match(msgs('const t = Date.now();')[0], /Date\.now/);
  assert.match(msgs('const t = performance.now();')[0], /performance\.now/);
  assert.match(msgs('const t = new Date();')[0], /new Date/);
});

test('flags timers and rAF', () => {
  assert.match(msgs('setTimeout(fn, 100);')[0], /setTimeout/);
  assert.match(msgs('setInterval(fn, 50);')[0], /setInterval/);
  assert.match(msgs('requestAnimationFrame(fn);')[0], /requestAnimationFrame/);
});

test('flags raw transcendentals outside the wrapper', () => {
  assert.match(msgs('const s = Math.sin(x);')[0], /transcendental/);
  assert.match(msgs('const p = Math.pow(x, 2);')[0], /transcendental/);
  assert.match(msgs('const h = Math.hypot(x, y);')[0], /transcendental/);
});

test('permits raw transcendentals inside the wrapper (mathx.js)', () => {
  clean('export const sin = Math.sin; export const pow = Math.pow;', { isWrapper: true });
});

test('the wrapper is still bound by clock/RNG rules', () => {
  assert.match(msgs('const t = Date.now();', { isWrapper: true })[0], /Date\.now/);
  assert.match(msgs('const r = Math.random();', { isWrapper: true })[0], /Math\.random/);
});

test('deterministic Math members are allowed', () => {
  clean(`
    const a = Math.floor(1.5) + Math.ceil(1.2) + Math.round(1.5);
    const b = Math.abs(-1) + Math.min(1, 2) + Math.max(1, 2);
    const c = Math.sqrt(9) + Math.imul(2, 3) + Math.sign(-4) + Math.trunc(3.9);
  `);
});

test('prose in comments is not flagged (comments stripped)', () => {
  clean(`
    // This module replaces Math.random and never calls Date.now or setTimeout.
    /* performance.now() and requestAnimationFrame belong in the renderer. */
    export const ok = 1;
  `);
});

test('string and template literal contents are not flagged', () => {
  clean('const label = "uses Date.now internally"; const s = `no setTimeout here`;');
});

test('a regex literal does not derail the scanner', () => {
  clean('const re = /Math.random/; const clean = str.replace(/Date.now/g, "x");');
  // ...and real code after the regex is still scanned.
  assert.match(msgs('const re = /abc/; const x = Math.random();')[0], /Math\.random/);
});

test('reports 1-indexed line numbers', () => {
  const v = lintSource('const a = 1;\nconst b = 2;\nconst t = Date.now();');
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
});
