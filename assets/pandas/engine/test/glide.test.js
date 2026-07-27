// The glide — the port of `transition: transform 2s`.
//
// These tests exist because the first port got this wrong in a way unit tests
// could not see and the page could: an exponential chase (`x += (lx-x)*k`) has the
// same average lag as the CSS transition but none of its shape, and reads as
// sliding on ice. What distinguishes them is the RESTART — a stride replaces the
// running transition instead of adjusting a filter — so that is what is pinned
// here, along with the settle and the turn.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeConfig } from '../config.js';
import { makeEntity, easeVisual, snapVisual } from '../state.js';

const cfg = makeConfig();

// Walk an entity forward n ticks with its logical target where it is.
const glide = (e, n) => { for (let i = 0; i < n; i++) easeVisual(e, cfg); };

test('the glide curve is sampled once per config, one entry per tick', () => {
  assert.equal(cfg.glideTicks, 40); // 2000ms at 20Hz
  assert.equal(cfg.glideCurve.length, cfg.glideTicks + 1);
  assert.equal(cfg.glideCurve[0], 0);
  assert.equal(cfg.glideCurve[cfg.glideTicks], 1);
});

test('a stride glides to its target over the transition and then stops dead', () => {
  const e = makeEntity(0, 100, 100);
  e.lx = 150;
  glide(e, cfg.glideTicks);
  assert.equal(e.x, 150);
  assert.equal(e.y, 100);
  // Past the duration nothing moves and nothing drifts — the transition is over.
  glide(e, 20);
  assert.equal(e.x, 150);
});

test('the glide lags the logical position without ever passing it', () => {
  const e = makeEntity(0, 0, 0);
  e.lx = 50;
  for (let i = 0; i < cfg.glideTicks; i++) {
    easeVisual(e, cfg);
    assert.ok(e.x > 0 && e.x <= 50, `left the segment at tick ${i}: ${e.x}`);
  }
});

test('a new stride RESTARTS the transition from where the body has glided to', () => {
  const e = makeEntity(0, 0, 0);
  e.lx = 50;
  glide(e, 8); // part-way through the first stride
  const carried = e.x;
  assert.ok(carried > 0 && carried < 50);

  e.lx = 100; // the next stride: a fresh transition, from here
  easeVisual(e, cfg);
  assert.equal(e.gT, 1);
  assert.equal(e.g0x, carried);
  // One tick of the new curve covers cssEase(1/40) of the *remaining* distance.
  const expected = carried + (100 - carried) * cfg.glideCurve[1];
  assert.equal(e.x, expected);
});

test('a reversal turns within one tick — no coasting through the old heading', () => {
  const e = makeEntity(0, 0, 0);
  e.lx = 50;
  glide(e, 10); // moving right, visual trailing the logical position
  const before = e.x;

  e.lx = 0; // about-face
  easeVisual(e, cfg);
  assert.ok(e.x < before, `still drifting right after the turn: ${before} -> ${e.x}`);
});

test('a snap ends the running transition rather than leaving it to resume', () => {
  const e = makeEntity(0, 0, 0);
  e.lx = 50;
  glide(e, 5);
  assert.ok(e.gT > 0);

  snapVisual(e); // `.stop`: the knock slide, the zoomies dash, any grounded phase
  assert.equal(e.x, 50);
  assert.equal(e.gT, 0);

  // Standing still under `.stop` must not creep: with no new target, nothing moves.
  glide(e, 10);
  assert.equal(e.x, 50);
});

test('both axes ride one transition, as one transform write does', () => {
  const e = makeEntity(0, 0, 0);
  e.lx = 50;
  e.ly = 50;
  glide(e, 7);
  assert.equal(e.x, e.y); // same curve, same clock, same distance
});
