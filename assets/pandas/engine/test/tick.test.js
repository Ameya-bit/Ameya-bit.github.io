import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TICK_HZ,
  TICK_MS,
  ACTION_HZ,
  TICKS_PER_ACTION,
  msToTicks,
  msToTicksRaw,
  pxPerMsToPerTick,
  ticksToMs,
} from '../tick.js';

test('tick clock constants', () => {
  assert.equal(TICK_HZ, 20);
  assert.equal(TICK_MS, 50);
  assert.equal(ACTION_HZ, 10);
  assert.equal(TICKS_PER_ACTION, 2);
});

test('msToTicks rounds to nearest and clamps to >= 1', () => {
  assert.equal(msToTicks(50), 1);
  assert.equal(msToTicks(140), 3); // FRAME_MS: 2.8 -> 3
  assert.equal(msToTicks(540), 11); // HAT_MOVE_MS: 10.8 -> 11
  assert.equal(msToTicks(10), 1); // sub-tick durations never vanish
  assert.equal(msToTicks(0), 1);
});

test('msToTicksRaw allows zero for optional delays', () => {
  assert.equal(msToTicksRaw(0), 0);
  assert.equal(msToTicksRaw(24), 0); // 0.48 -> 0
  assert.equal(msToTicksRaw(140), 3);
});

test('pxPerMsToPerTick scales speed to per-tick pixels', () => {
  assert.equal(pxPerMsToPerTick(0.17), 8.5); // the zoomies dash
  assert.equal(pxPerMsToPerTick(0), 0);
});

test('ticksToMs is the inverse denomination', () => {
  assert.equal(ticksToMs(3), 150);
  assert.equal(ticksToMs(TICKS_PER_ACTION), 100); // one action = 100 ms
});
