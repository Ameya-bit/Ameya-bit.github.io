import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32Next, Rng } from '../rng.js';

test('mulberry32Next is a pure function of state', () => {
  // Same input state -> identical output state and value, every time.
  const a = mulberry32Next(12345);
  const b = mulberry32Next(12345);
  assert.equal(a.state, b.state);
  assert.equal(a.value, b.value);
});

test('mulberry32Next returns values in [0, 1)', () => {
  let s = 1;
  for (let i = 0; i < 10000; i++) {
    const r = mulberry32Next(s);
    assert.ok(r.value >= 0 && r.value < 1, `value out of range: ${r.value}`);
    assert.ok(Number.isInteger(r.state), 'state must stay an int32');
    s = r.state;
  }
});

test('mulberry32Next state stays within int32', () => {
  let s = 0x7fffffff;
  for (let i = 0; i < 1000; i++) {
    const r = mulberry32Next(s);
    assert.ok(r.state >= -2147483648 && r.state <= 2147483647);
    s = r.state;
  }
});

test('same seed reproduces the same sequence (determinism)', () => {
  const seqOf = (seed, n) => {
    const rng = new Rng(seed);
    return Array.from({ length: n }, () => rng.next());
  };
  assert.deepEqual(seqOf(42, 500), seqOf(42, 500));
  // Different seeds diverge.
  assert.notDeepEqual(seqOf(42, 20), seqOf(43, 20));
});

test('Rng threads and round-trips its state', () => {
  const a = new Rng(777);
  a.next();
  a.next();
  const mid = a.state;
  const third = a.next();

  // Reconstructing from the captured integer state resumes the exact sequence.
  const b = new Rng(mid);
  assert.equal(b.next(), third);
});

test('Rng.int(n) stays in [0, n)', () => {
  const rng = new Rng(9);
  for (let i = 0; i < 5000; i++) {
    const v = rng.int(8);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 8, `int out of range: ${v}`);
  }
});

test('Rng.ceil1(n) stays in [1, n] like the original rand()', () => {
  const rng = new Rng(3);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rng.ceil1(4);
    assert.ok(v >= 1 && v <= 4, `ceil1 out of range: ${v}`);
    seen.add(v);
  }
  // Should span the whole inclusive range over enough draws.
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);
});

test('Rng.intBetween(lo, hi) is inclusive on both ends', () => {
  const rng = new Rng(5);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = rng.intBetween(2, 5);
    assert.ok(v >= 2 && v <= 5);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [2, 3, 4, 5]);
});

test('Rng.pick returns an element and covers the array', () => {
  const rng = new Rng(11);
  const arr = ['a', 'b', 'c'];
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(rng.pick(arr));
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('Rng.float(lo, hi) stays in [lo, hi)', () => {
  const rng = new Rng(13);
  for (let i = 0; i < 5000; i++) {
    const v = rng.float(-3, 7);
    assert.ok(v >= -3 && v < 7, `float out of range: ${v}`);
  }
});

test('Rng rejects a non-finite seed rather than desyncing silently', () => {
  assert.throws(() => new Rng(NaN), RangeError);
  assert.throws(() => new Rng(Infinity), RangeError);
});
