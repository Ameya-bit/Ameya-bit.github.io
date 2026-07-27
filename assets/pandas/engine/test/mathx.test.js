import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mathx from '../mathx.js';

// sin/cos are ours, not Math's — see the header of mathx.js for why (Node and
// Chrome disagree on Math.sin by an ULP, which broke the Node-vs-browser gate).
// What is asserted here is that they are (a) exact at the values a reader would
// expect to be exact, and (b) faithful to the native functions to well under a
// pixel of anything.

test('sin and cos are exact at the cardinal angles', () => {
  assert.equal(mathx.sin(0), 0);
  assert.equal(mathx.cos(0), 1);
  assert.equal(mathx.sin(mathx.PI / 2), 1);
  assert.equal(mathx.cos(mathx.PI), -1);
  assert.equal(mathx.sin(-mathx.PI / 2), -1);
});

test('sin and cos track the native ones to ~1e-12 over the sim\'s range', () => {
  // The largest argument the sim ever passes is a tick count over the wobble
  // period: an hour of run time is ~72k ticks / 32 ticks per turn ≈ 14k radians.
  let worstSin = 0;
  let worstCos = 0;
  for (let i = -20000; i <= 20000; i += 7) {
    const x = i * 0.9137; // an irrational-ish stride, so no angle is favoured
    worstSin = Math.max(worstSin, Math.abs(mathx.sin(x) - Math.sin(x)));
    worstCos = Math.max(worstCos, Math.abs(mathx.cos(x) - Math.cos(x)));
  }
  assert.ok(worstSin < 1e-11, `sin worst error ${worstSin}`);
  assert.ok(worstCos < 1e-11, `cos worst error ${worstCos}`);
});

test('sin and cos use only IEEE-754-pinned operations', () => {
  // The whole point: no Math.sin/cos/pow anywhere in the implementation, so every
  // conforming engine computes the same bits. (The determinism lint enforces the
  // same rule across the engine; this pins the one module it exempts.)
  const src = mathx.sin.toString() + mathx.cos.toString();
  assert.doesNotMatch(src, /Math\s*\.\s*(sin|cos|tan|exp|pow|log|atan)/);
  assert.doesNotMatch(src, /\*\*/);
});

test('unpinned transcendentals are not available to import', () => {
  // exp / pow / atan2 were removed rather than left lying around: nothing in the
  // sim needs them, and importing one would silently reopen the cross-engine hole.
  assert.equal(mathx.exp, undefined);
  assert.equal(mathx.pow, undefined);
  assert.equal(mathx.atan2, undefined);
});

test('hypot computes Euclidean distance', () => {
  assert.equal(mathx.hypot(3, 4), 5);
  assert.equal(mathx.hypot(0, 0), 0);
  assert.equal(mathx.hypot(-6, 8), 10);
});

test('sq squares exactly', () => {
  assert.equal(mathx.sq(12), 144);
  assert.equal(mathx.sq(-0.5), 0.25);
  assert.equal(mathx.sq(0), 0);
});

test('clamp bounds a value to [lo, hi]', () => {
  assert.equal(mathx.clamp(5, 0, 10), 5);
  assert.equal(mathx.clamp(-1, 0, 10), 0);
  assert.equal(mathx.clamp(99, 0, 10), 10);
  assert.equal(mathx.clamp(0, 0, 10), 0);
  assert.equal(mathx.clamp(10, 0, 10), 10);
});

test('re-exported helpers match Math', () => {
  assert.equal(mathx.abs(-7), 7);
  assert.equal(mathx.floor(3.9), 3);
  assert.equal(mathx.round(3.5), 4);
  assert.equal(mathx.min(2, 9), 2);
  assert.equal(mathx.max(2, 9), 9);
  assert.equal(mathx.sqrt(144), 12);
  assert.equal(mathx.PI, Math.PI);
});
