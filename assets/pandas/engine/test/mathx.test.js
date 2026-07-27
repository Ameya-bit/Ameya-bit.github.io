import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mathx from '../mathx.js';

test('transcendentals wrap the standard Math functions', () => {
  assert.equal(mathx.sin(0), 0);
  assert.equal(mathx.cos(0), 1);
  assert.equal(mathx.exp(0), 1);
  assert.equal(mathx.pow(2, 10), 1024);
  assert.equal(mathx.atan2(0, 1), 0);
  assert.equal(mathx.sqrt(144), 12);
});

test('hypot computes Euclidean distance', () => {
  assert.equal(mathx.hypot(3, 4), 5);
  assert.equal(mathx.hypot(0, 0), 0);
  assert.equal(mathx.hypot(-6, 8), 10);
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
  assert.equal(mathx.PI, Math.PI);
});
