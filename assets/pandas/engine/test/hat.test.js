import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../engine.js';
import { MODE, ANIM, isDown } from '../state.js';
import { startAnomaly, ANOMALY_KINDS } from '../anomalies.js';
import { ACTION, stepAction, rollAction, stepDirOf } from '../actions.js';
import { runSeed } from '../tools/trace.js';

// A wide-open engine so a roll/stride is never clamped by an edge.
const openEngine = (over = {}) => makeEngine({ width: 6000, height: 6000, forbid: null, pandaCount: 2, ...over });
const hatOf = (s) => s.entities.find((e) => e.hasHat);

// Step to the next decision tick (tick % 2 === 0) so a supplied action lands, then
// apply `action` on that tick. Returns the post-action state.
function stepWithAction(engine, s, action) {
  if ((s.tick + 1) % 2 !== 0) s = engine.step(s); // burn an odd (non-decision) tick
  return engine.step(s, action);
}

test('the hat spawns in observing mode with a fresh watcher brain', () => {
  const engine = openEngine();
  const s = engine.init(1);
  const h = hatOf(s);
  assert.equal(h.mode, MODE.OBSERVING);
  assert.equal(h.subject, -1);
  assert.equal(h.relocating, true);
  assert.equal(h.td, engine.cfg.ambientStandoff);
  assert.equal(h.rollReadyAt, 0);
});

test('a supplied ROLL action drives a committed dive-roll and recovers', () => {
  const engine = openEngine();
  let s = engine.init(2);
  // Park the other panda far away so nothing interferes with the seam.
  s = { ...s, entities: s.entities.map((e) => (e.hasHat ? { ...e, lx: 3000, ly: 3000, x: 3000, y: 3000 } : { ...e, lx: 500, ly: 500, x: 500, y: 500 })) };
  const x0 = hatOf(s).lx;
  s = stepWithAction(engine, s, rollAction(2)); // roll east
  assert.equal(hatOf(s).mode, MODE.ROLLING, 'entered the roll');
  assert.ok(hatOf(s).rollReadyAt > s.tick, 'cooldown stamped at roll start');

  // Advance until the roll pops back up.
  for (let i = 0; i < 10 && hatOf(s).mode === MODE.ROLLING; i++) s = engine.step(s);
  const h = hatOf(s);
  assert.equal(h.mode, MODE.OBSERVING, 'popped back to observing');
  assert.ok(h.lx - x0 > engine.cfg.rollDist * 0.8, `carried ~rollDist east (${(h.lx - x0).toFixed(0)}px)`);
});

test('a supplied STEP action moves one stride and is recorded on the hat', () => {
  const engine = openEngine();
  let s = engine.init(3);
  s = { ...s, entities: s.entities.map((e) => (e.hasHat ? { ...e, lx: 2000, ly: 2000, x: 2000, y: 2000 } : { ...e, lx: 200, ly: 200, x: 200, y: 200 })) };
  const before = hatOf(s).lx;
  s = stepWithAction(engine, s, stepAction(2)); // one stride east
  const h = hatOf(s);
  assert.equal(h.action, stepAction(2), 'the applied action is logged for BC');
  assert.equal(stepDirOf(h.action), 2);
  assert.equal(h.lx, before + engine.cfg.step, 'moved exactly one STEP east');
  assert.equal(h.anim, ANIM.WALK);
});

test('the dive-roll is invulnerable — i-frames block a knock mid-roll', () => {
  const engine = openEngine();
  let s = engine.init(4);
  // Put the hat mid-roll and a live roamer overlapping it. Without i-frames the
  // overlap would knock the hat; with them, only the roamer goes down.
  s = {
    ...s,
    entities: s.entities.map((e) => {
      if (e.hasHat) return { ...e, mode: MODE.ROLLING, anim: ANIM.ROLL, aHeading: 0, aCount: 5, lx: 2000, ly: 2000, x: 2000, y: 2000 };
      return { ...e, mode: MODE.WANDER, anim: ANIM.WALK, lx: 2010, ly: 2000, x: 2010, y: 2000 };
    }),
  };
  let hatEverKnocked = false;
  for (let i = 0; i < 6; i++) {
    s = engine.step(s);
    if (hatOf(s).mode === MODE.KNOCKED) hatEverKnocked = true;
  }
  assert.ok(!hatEverKnocked, 'the rolling hat was never knocked');
  assert.equal(hatOf(s).mode, MODE.OBSERVING, 'and finished the roll cleanly');
});

test('the reflex spends a dive-roll on an incoming zoomies', () => {
  const engine = openEngine();
  let s = engine.init(5);
  s = {
    ...s,
    entities: s.entities.map((e) => {
      if (e.hasHat) return { ...e, lx: 3000, ly: 3000, x: 3000, y: 3000, rollReadyAt: 0 };
      return { ...e, lx: 2700, ly: 3000, x: 2700, y: 3000 };
    }),
  };
  // Aim the roamer's zoomies straight east, into the hat.
  const zoomer = s.entities.find((e) => !e.hasHat);
  startAnomaly(zoomer, ANOMALY_KINDS.indexOf('zoomies'), engine.cfg, { int: () => 2, next: () => 0, intBetween: () => 1, pick: (a) => a[0], chance: () => false });
  zoomer.dir = 2;
  zoomer.aHeading = 2;
  let sawRoll = false;
  for (let i = 0; i < 80 && !sawRoll; i++) {
    s = engine.step(s);
    if (hatOf(s).mode === MODE.ROLLING) sawRoll = true;
  }
  assert.ok(sawRoll, 'the hat rolled to dodge the runaway');
});

test('a knocked hat recovers back into observing, not wander', () => {
  const engine = openEngine();
  let s = engine.init(6);
  // Overlap a roamer onto the hat and put the roll on cooldown so it must take the
  // hit (the honest failure), then recover.
  s = {
    ...s,
    entities: s.entities.map((e) => {
      if (e.hasHat) return { ...e, mode: MODE.OBSERVING, anim: ANIM.WALK, lx: 2000, ly: 2000, x: 2000, y: 2000, rollReadyAt: 1e9, subject: 1, relocating: false };
      return { ...e, mode: MODE.WANDER, anim: ANIM.WALK, lx: 2012, ly: 2000, x: 2012, y: 2000 };
    }),
  };
  s = engine.step(s);
  assert.equal(hatOf(s).mode, MODE.KNOCKED, 'took the hit');

  let recovered = false;
  for (let i = 0; i < 300 && !recovered; i++) {
    s = engine.step(s);
    if (hatOf(s).mode === MODE.OBSERVING) recovered = true;
  }
  assert.ok(recovered, 'stood back up into observing');
  const h = hatOf(s);
  assert.equal(h.relocating, true, 'brain reset — hunting a fresh subject');
  assert.equal(h.subject, -1);
});

test('the seam is deterministic under a supplied action stream', () => {
  const engine = openEngine({ width: 2600, height: 1400, pandaCount: 12 });
  const eng = { init: engine.init, step: engine.step, encode: engine.encode };
  // A fixed pseudo-policy: cycle hold / step-east / roll-north by tick.
  const actions = (t) => (t % 5 === 0 ? rollAction(0) : t % 2 === 0 ? stepAction(2) : ACTION.HOLD);
  const a = runSeed({ engine: eng, seed: 99, ticks: 1500, actions });
  const b = runSeed({ engine: eng, seed: 99, ticks: 1500, actions });
  assert.equal(a.digest, b.digest);
});

test('an out-of-range action falls back to the rules expert (seam guard)', () => {
  const engine = openEngine({ width: 2600, height: 1400, pandaCount: 10 });
  let s = engine.init(7);
  // Feed garbage on a decision tick; the hat should still act sanely (a valid mode,
  // in bounds), driven by the expert instead of the bad logit.
  for (let i = 0; i < 50; i++) s = engine.step(s, 999);
  const h = hatOf(s);
  assert.ok(h.mode === MODE.OBSERVING || h.mode === MODE.ROLLING || h.mode === MODE.KNOCKED);
  assert.ok(h.lx > s.cfg.boundLower && h.lx < s.cfg.width - s.cfg.boundUpper, 'stayed on stage');
});
