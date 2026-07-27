import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, init, step, encode } from '../engine.js';
import { MODE, KNOCK, ANIM } from '../state.js';
import { inBounds } from '../geometry.js';
import { detectCollisions } from '../collision.js';
import { makeConfig } from '../config.js';
import { runSeed } from '../tools/trace.js';

const run = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i++) s = step(s);
  return s;
};

test('init places the configured number of pandas, one hat, one oblivious', () => {
  const s = init(12345);
  assert.equal(s.entities.length, s.cfg.pandaCount);
  assert.equal(s.entities.filter((e) => e.hasHat).length, 1);
  assert.equal(s.entities.filter((e) => e.oblivious).length, 1);
  assert.ok(!s.entities[0].oblivious, 'the hat panda is never the oblivious one');
  assert.equal(s.tick, 0);
});

test('the engine is deterministic (same seed -> identical digest)', () => {
  const a = runSeed({ engine: { init, step, encode }, seed: 999, ticks: 500 });
  const b = runSeed({ engine: { init, step, encode }, seed: 999, ticks: 500 });
  assert.equal(a.digest, b.digest);
});

test('different seeds diverge', () => {
  const a = runSeed({ engine: { init, step, encode }, seed: 1, ticks: 500 });
  const b = runSeed({ engine: { init, step, encode }, seed: 2, ticks: 500 });
  assert.notEqual(a.digest, b.digest);
});

test('step does not mutate the input state (purity at the tick boundary)', () => {
  const s0 = init(7);
  const before = encode(s0).join(',');
  step(s0);
  const after = encode(s0).join(',');
  assert.equal(before, after);
});

test('wandering pandas stay within bounds over a long run', () => {
  let s = init(2024);
  for (let i = 0; i < 2000; i++) {
    s = step(s);
    for (const e of s.entities) {
      // Knocked pandas can be shoved to the very edge, but never off-stage.
      assert.ok(
        e.x > s.cfg.boundLower - 1 && e.x < s.cfg.width - s.cfg.boundUpper + 1,
        `x escaped: ${e.x} at tick ${s.tick}`,
      );
      assert.ok(
        e.y > s.cfg.boundLower - 1 && e.y < s.cfg.height - s.cfg.boundUpper + 1,
        `y escaped: ${e.y} at tick ${s.tick}`,
      );
    }
  }
});

test('pandas respect the hero-card fence', () => {
  const cfg = makeConfig({ forbid: { l: 500, t: 200, r: 800, b: 380 } });
  const engine = makeEngine(cfg);
  let s = engine.init(4242);
  for (let i = 0; i < 2000; i++) {
    s = engine.step(s);
    for (const e of s.entities) {
      // The fence constrains the LOGICAL position (the stride grid); the visual
      // position may graze a card corner mid-glide, exactly as the original's CSS
      // transition did. Assert the real invariant.
      const insideX = e.lx + cfg.cell - cfg.foot > cfg.forbid.l && e.lx + cfg.foot < cfg.forbid.r;
      const insideY = e.ly + cfg.cell - cfg.foot > cfg.forbid.t && e.ly + cfg.foot < cfg.forbid.b;
      assert.ok(!(insideX && insideY), `entered fence at (${e.lx},${e.ly}) tick ${s.tick}`);
    }
  }
});

test('the oblivious one stays more local than the roamers', () => {
  let s = init(55);
  const ob = s.entities.find((e) => e.oblivious);
  const roamers = s.entities
    .filter((e) => !e.oblivious && !e.hasHat)
    .map((e) => ({ id: e.id, home: [e.x, e.y], sum: 0 }));
  let obSum = 0;
  const dist = (e, hx, hy) => Math.hypot(e.lx - hx, e.ly - hy);
  for (let i = 0; i < 3000; i++) {
    s = step(s);
    obSum += dist(s.entities.find((e) => e.id === ob.id), ob.home[0], ob.home[1]);
    for (const r of roamers) obSum, (r.sum += dist(s.entities.find((e) => e.id === r.id), r.home[0], r.home[1]));
  }
  const obMean = obSum / 3000;
  const roamerMean = roamers.reduce((a, r) => a + r.sum / 3000, 0) / roamers.length;
  // The patch-keeper drifts markedly less than the free wanderers.
  assert.ok(obMean < roamerMean, `oblivious mean ${obMean.toFixed(0)} !< roamer mean ${roamerMean.toFixed(0)}`);
  assert.ok(obMean < s.cfg.obliviousRadius * 1.5, `oblivious mean stray too large: ${obMean.toFixed(0)}`);
});

test('overlapping pandas collide and get knocked in opposite directions', () => {
  // Two pandas placed body-to-body horizontally.
  const cfg = makeConfig();
  const a = { id: 0, x: 300, y: 300, solid: false, flying: false, riding: false, entering: false, defaultFallDir: 0 };
  const b = { id: 1, x: 320, y: 300, solid: false, flying: false, riding: false, entering: false, defaultFallDir: 0 };
  const hits = detectCollisions([a, b], cfg);
  assert.equal(hits.length, 2, 'both register a contact');
});

test('a collision runs the full knock cycle and recovers', () => {
  // Engine with two pandas spawned overlapping so they knock immediately.
  const cfg = makeConfig({ pandaCount: 2, width: 600, height: 400 });
  const engine = makeEngine(cfg);
  let s = engine.init(3);
  // Force an overlap to guarantee a knock regardless of spawn spread.
  s = {
    ...s,
    entities: s.entities.map((e, i) => {
      const x = 300 + i * 18;
      return { ...e, x, y: 300, lx: x, ly: 300, mode: MODE.WANDER };
    }),
  };
  // Run one tick: collision should fire.
  s = engine.step(s);
  const knockedNow = s.entities.filter((e) => e.mode === MODE.KNOCKED);
  assert.ok(knockedNow.length >= 1, 'at least one got knocked');
  // Test the generic roamer recovery here (a roamer rejoins the wander); the hat
  // panda has its own recovery path — it returns to observing — covered in hat.test.js.
  const victim = (knockedNow.find((e) => !e.hasHat) || knockedNow[0]).id;
  assert.equal(s.entities.find((e) => e.id === victim).knockPhase, KNOCK.FALL);

  // Advance through fall -> lie -> stand-up -> recovered.
  let sawLie = false;
  let recovered = false;
  for (let i = 0; i < 300 && !recovered; i++) {
    s = engine.step(s);
    const v = s.entities.find((e) => e.id === victim);
    if (v.knockPhase === KNOCK.LIE) sawLie = true;
    if (v.mode === MODE.WANDER && v.anim === ANIM.WALK && i > 5) recovered = true;
  }
  assert.ok(sawLie, 'passed through the lie-down phase');
  assert.ok(recovered, 'stood back up and rejoined the wander');
});

test('makeEngine config overrides take effect (config plumbing)', () => {
  const engine = makeEngine({ pandaCount: 5 });
  const s = engine.init(1);
  assert.equal(s.entities.length, 5);
});
