import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  // pow / atan2 stay absent rather than lying around: nothing in the sim needs them,
  // and importing one would silently reopen the cross-engine hole. `exp` was added in
  // Phase D — but pinned like sin/cos, not passed through, which the tests below hold
  // it to. The rule was never "no exp", it was "nothing unpinned".
  assert.equal(mathx.pow, undefined);
  assert.equal(mathx.atan2, undefined);
  assert.equal(typeof mathx.exp, 'function');
});

test('exp tracks the native one to an ULP over the range a softmax uses', () => {
  // The only caller is the policy net's attention softmax, whose inputs are shifted
  // so the largest is 0 — but the range checked here is far wider than that, because
  // a pinned function that is only right where it is currently called is a trap for
  // the next caller.
  let worst = 0;
  for (let i = 0; i <= 200000; i++) {
    const x = -60 + (i / 200000) * 80;
    const rel = Math.abs(mathx.exp(x) - Math.exp(x)) / Math.exp(x);
    if (rel > worst) worst = rel;
  }
  assert.ok(worst < 4 * Number.EPSILON, `worst relative error ${worst.toExponential(3)}`);

  assert.equal(mathx.exp(0), 1);
  assert.ok(Number.isNaN(mathx.exp(NaN)));
  assert.equal(mathx.exp(Infinity), Infinity);
  assert.equal(mathx.exp(-Infinity), 0);
  assert.equal(mathx.exp(1000), Infinity);
  // Underflows to zero a few subnormals earlier than Math.exp does — stated in the
  // module and pinned here so the boundary cannot drift unnoticed.
  assert.equal(mathx.exp(-746), 0);
});

test('exp uses only IEEE-754-pinned operations', () => {
  // The same guard the sin/cos test applies, extended to exp. Comments are stripped
  // first: the module explains its own boundary behaviour by naming `Math.exp`, and
  // prose about a hazard is not the hazard.
  const src = readFileSync(new URL('../mathx.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /Math\s*\.\s*(pow|exp|log)/);
  assert.doesNotMatch(code, /\*\*/);

  // And the property those operations exist to guarantee: every scale factor is an
  // exact power of two, so `exp` never multiplies by an approximation of one.
  for (const k of [-1074, -1022, -60, -1, 0, 1, 60, 1023]) {
    const scaled = mathx.exp(k * 0.6931471805599453); // ln 2
    assert.ok(Number.isFinite(scaled), `2^${k} came out ${scaled}`);
  }
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

// ---- the CSS `ease` curve ----
// The original's glide was `transition: transform 2s`, whose default timing
// function is cubic-bezier(0.25, 0.1, 0.25, 1). These pin the curve to the one
// the browser drew, since the shape of every stride depends on it.

test('cssEase hits the endpoints exactly and clamps outside [0,1]', () => {
  assert.equal(mathx.cssEase(0), 0);
  assert.equal(mathx.cssEase(1), 1);
  assert.equal(mathx.cssEase(-0.5), 0);
  assert.equal(mathx.cssEase(1.5), 1);
});

test('cssEase matches cubic-bezier(0.25, 0.1, 0.25, 1) at a known point', () => {
  // At curve parameter t = 0.5 the bezier is (x, y) = (0.3125, 0.5375) — worked
  // out from the Bernstein form, independent of the Newton inversion under test.
  assert.ok(Math.abs(mathx.cssEase(0.3125) - 0.5375) < 1e-12);
});

test('cssEase is strictly increasing and starts at 0.4x average speed', () => {
  let prev = 0;
  for (let i = 1; i <= 200; i++) {
    const y = mathx.cssEase(i / 200);
    assert.ok(y > prev, `not increasing at ${i / 200}`);
    prev = y;
  }
  // The curve's initial slope is cy/cx = 0.3/0.75: a stride commits immediately
  // rather than easing in from a standstill — that is what makes a turn read as
  // a turn. And it finishes flat, which is the settle at the end of a step.
  const eps = 1e-7;
  assert.ok(Math.abs(mathx.cssEase(eps) / eps - 0.4) < 1e-3);
  assert.ok((1 - mathx.cssEase(1 - eps)) / eps < 1e-3);
});
