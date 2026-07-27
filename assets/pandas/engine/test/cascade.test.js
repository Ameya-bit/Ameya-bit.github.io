import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../engine.js';
import { MODE, ANIM, KNOCK, POINT_SUBJECT, isDown } from '../state.js';
import { igniteCascade, isRoamer, nearestStandingNeighbour, cascadeElsewhere } from '../cascade.js';
import { topIncident, pickWatchTarget, watchedTarget } from '../watcher.js';
import { Rng } from '../rng.js';
import { runSeed } from '../tools/trace.js';

// A dense field where every roamer has a neighbour inside chainRange, so a sweep can
// actually propagate. The arming clock is pushed out of the way; tests arm by hand.
const fieldEngine = (over = {}) =>
  makeEngine({
    width: 1400, height: 700, forbid: null, pandaCount: 10,
    stackKick: 1e9, cascadeKick: 1e9, anomKick: 1e9, // no set pieces unless asked for
    ...over,
  });

// Lay the roamers out on a loose grid so neighbour distances are known and small.
function grid(engine, seed = 1) {
  const s = engine.init(seed);
  let i = 0;
  return {
    ...s,
    entities: s.entities.map((e) => {
      if (e.hasHat) return { ...e, lx: 1200, ly: 600, x: 1200, y: 600 };
      const x = 120 + (i % 4) * 150;
      const y = 120 + Math.floor(i / 4) * 150;
      i += 1;
      return { ...e, mode: MODE.WANDER, anim: ANIM.WALK, lx: x, ly: y, x, y };
    }),
  };
}

const arm = (s, cfg) => ({ ...s, cascade: { ...s.cascade, armed: true, forceAt: -1 } });

test('the arming clock arms once and sets a liveness backstop', () => {
  const engine = fieldEngine({ cascadeKick: 3, cascadeArmMin: 1e6, cascadeArmMax: 1e6 });
  let s = engine.init(21);
  assert.equal(s.cascade.armed, false);
  for (let i = 0; i < 3; i++) s = engine.step(s);
  assert.equal(s.cascade.armed, true, 'armed at the kick');
  assert.equal(s.cascade.forceAt, 3 + engine.cfg.cascadeArmTimeout, 'backstop scheduled');
  assert.equal(s.cascade.active, false, 'arming alone ignites nothing');
});

test('a natural collision while armed ignites; while unarmed it stays an ordinary knock', () => {
  const engine = fieldEngine();
  // Two roamers body-to-body, everyone else out of the way.
  const collide = (s) => ({
    ...s,
    entities: s.entities.map((e, i) => {
      if (e.hasHat) return { ...e, lx: 1300, ly: 650, x: 1300, y: 650 };
      if (i === 1) return { ...e, mode: MODE.WANDER, anim: ANIM.WALK, lx: 200, ly: 200, x: 200, y: 200 };
      if (i === 2) return { ...e, mode: MODE.WANDER, anim: ANIM.WALK, lx: 214, ly: 200, x: 214, y: 200 };
      return { ...e, mode: MODE.WANDER, anim: ANIM.WALK, lx: 400 + i * 90, ly: 480, x: 400 + i * 90, y: 480 };
    }),
  });

  let cold = engine.step(collide(engine.init(22)));
  assert.ok(cold.entities.filter(isDown).length >= 1, 'they still knock each other');
  assert.equal(cold.cascade.active, false, 'unarmed — nothing escalates');

  let hot = engine.step(arm(collide(engine.init(22))));
  assert.equal(hot.cascade.active, true, 'armed — the collision ignited a sweep');
  assert.equal(hot.cascade.armed, false, 'the arm is spent');
  assert.ok(hot.cascade.target >= 2, 'a coverage target was drawn');
  assert.ok(hot.cascade.endAt > hot.tick, 'the machinery has an expiry');
});

test('a sweep fells a staggered chain, never more than the coverage cap', () => {
  const engine = fieldEngine();
  let s = arm(grid(engine, 23));
  const seed = s.entities.find((e) => isRoamer(e));
  igniteCascade(s, [seed.id], engine.cfg, new Rng(7));
  const target = s.cascade.target;
  assert.ok(target >= 4, `target covers most of the field (${target})`);

  let maxDownAtOnce = 0;
  let fellOverTime = new Set();
  for (let i = 0; i < engine.cfg.cascadeDuration; i++) {
    s = engine.step(s);
    assert.ok(s.cascade.felled <= s.cascade.target, 'the coverage cap holds');
    for (const e of s.entities) if (e.cascadeFall) fellOverTime.add(e.id);
    maxDownAtOnce = Math.max(maxDownAtOnce, s.entities.filter(isDown).length);
  }
  assert.ok(fellOverTime.size >= 3, `the ripple spread (${fellOverTime.size} felled)`);
  assert.ok(maxDownAtOnce >= 3, 'and they were down together — a visible pile-up');
  // Never all of them: the oblivious one is structurally spared.
  const ob = s.entities.find((e) => e.oblivious);
  assert.ok(!fellOverTime.has(ob.id), 'the oblivious one is immune (never in the universe)');
});

test('a claimed panda is not pre-empted by an ordinary collision, and is released on standing', () => {
  const engine = fieldEngine();
  let s = arm(grid(engine, 24));
  const seed = s.entities.find((e) => isRoamer(e));
  igniteCascade(s, [seed.id], engine.cfg, new Rng(3));
  const claimedId = s.cascade.pending[0].victim;

  // Shove a body right onto the claimed panda: it must stay standing until its own
  // scheduled fall, not be knocked early.
  s = {
    ...s,
    entities: s.entities.map((e) => {
      const v = s.entities.find((q) => q.id === claimedId);
      if (e.id === claimedId || e.hasHat || e.id === seed.id) return e;
      return { ...e, lx: v.lx + 12, ly: v.ly, x: v.lx + 12, y: v.ly };
    }),
  };
  const scheduledAt = s.cascade.pending[0].at;
  s = engine.step(s);
  const v = s.entities.find((e) => e.id === claimedId);
  assert.ok(s.tick < scheduledAt, 'still ahead of its scheduled fall');
  assert.ok(!isDown(v), 'the ordinary collision did not pre-empt the front');

  // It falls on schedule as a cascade domino, holds its claim while down, then frees it.
  s = runUntil(engine, s, (st) => st.entities.find((e) => e.id === claimedId).cascadeFall, 30);
  assert.ok(s.cascade.lock.includes(claimedId), 'claim held while down');
  s = runUntil(engine, s, (st) => !st.entities.find((e) => e.id === claimedId).cascadeFall, 400);
  assert.ok(!s.cascade.lock.includes(claimedId), 'claim released on standing up');
});

test('the sweep steers each faller at its next domino', () => {
  const engine = fieldEngine();
  let s = arm(grid(engine, 25));
  const seed = s.entities.find((e) => isRoamer(e));
  const nextUp = nearestStandingNeighbour(s, seed, engine.cfg);
  assert.ok(nextUp, 'the grid is dense enough to chain');
  igniteCascade(s, [seed.id], engine.cfg, new Rng(5));

  const felled = s.entities.find((e) => e.id === seed.id);
  assert.equal(felled.mode, MODE.KNOCKED);
  assert.equal(felled.knockPhase, KNOCK.FALL);
  assert.ok(felled.cascadeFall, 'tagged as a domino, not an ordinary shove');
  // The slide is the actual gap to the neighbour, so it lands overlapping.
  assert.equal(felled.slideVx, nextUp.lx - felled.lx);
  assert.equal(felled.slideVy, nextUp.ly - felled.ly);
});

test('the tier-3 incident is a fixed spot the watcher can hold and walk to', () => {
  const engine = fieldEngine();
  let s = arm(grid(engine, 26));
  const seed = s.entities.find((e) => isRoamer(e));
  igniteCascade(s, [seed.id], engine.cfg, new Rng(9));

  const inc = s.incidents.find((i) => i.tier === 3);
  assert.ok(inc, 'a tier-3 incident marks the origin of the carnage');
  assert.equal(inc.subject, POINT_SUBJECT, 'its subject is a place, not a panda');
  assert.equal(inc.px, Math.round(seed.lx));
  assert.equal(inc.py, Math.round(seed.ly));

  // The watcher ranks it top (tier 3 outranks all) and resolves it to a position.
  const hat = s.entities.find((e) => e.hasHat);
  assert.equal(topIncident(s, hat), inc);
  const want = pickWatchTarget(s, hat, engine.cfg, new Rng(1));
  assert.equal(want.subject, POINT_SUBJECT);
  hat.subject = want.subject;
  hat.subjPx = want.px;
  hat.subjPy = want.py;
  const t = watchedTarget(s, hat);
  assert.deepEqual([t.lx, t.ly], [inc.px, inc.py]);

  // And he closes on it rather than standing still.
  const d0 = Math.hypot(hat.lx - inc.px, hat.ly - inc.py);
  s = runUntil(engine, s, () => false, 120);
  const h = s.entities.find((e) => e.hasHat);
  assert.ok(
    Math.hypot(h.lx - inc.px, h.ly - inc.py) < d0,
    'the watcher scrambled toward the wreck',
  );
});

test('an ignition under the watcher\'s nose is held for a farther one', () => {
  const engine = fieldEngine();
  const s = arm(grid(engine, 27));
  const hat = s.entities.find((e) => e.hasHat);
  const near = s.entities.find((e) => isRoamer(e));
  const staged = {
    ...s,
    entities: s.entities.map((e) => (e.id === near.id ? { ...e, lx: hat.lx + 20, ly: hat.ly, x: hat.lx + 20, y: hat.ly } : e)),
  };
  assert.equal(cascadeElsewhere(staged, [near.id], engine.cfg), false, 'too close — hold the arm');
  const far = staged.entities.find((e) => isRoamer(e) && e.id !== near.id);
  assert.equal(cascadeElsewhere(staged, [far.id], engine.cfg), true, 'far enough — let it rip');
});

test('the liveness backstop manufactures an ignition from the panda farthest from the watcher', () => {
  const engine = fieldEngine({ cascadeArmTimeout: 2 });
  let s = grid(engine, 28);
  s = { ...s, cascade: { ...s.cascade, armed: true, forceAt: s.tick + 2 } };
  const hat = s.entities.find((e) => e.hasHat);
  const farthest = s.entities
    .filter((e) => isRoamer(e) && !isDown(e))
    .reduce((a, b) =>
      (b.lx - hat.lx) ** 2 + (b.ly - hat.ly) ** 2 > (a.lx - hat.lx) ** 2 + (a.ly - hat.ly) ** 2 ? b : a,
    );

  s = runUntil(engine, s, (st) => st.cascade.active, 10);
  assert.equal(s.cascade.active, true, 'the backstop fired');
  assert.ok(s.cascade.lock.includes(farthest.id), 'seeded away from the watcher');
});

test('the machinery resets after cascadeDuration and can re-arm', () => {
  const engine = fieldEngine();
  let s = arm(grid(engine, 29));
  const seed = s.entities.find((e) => isRoamer(e));
  igniteCascade(s, [seed.id], engine.cfg, new Rng(11));
  const endAt = s.cascade.endAt;

  s = runUntil(engine, s, (st) => !st.cascade.active, engine.cfg.cascadeDuration + 20);
  assert.equal(s.cascade.active, false, 'the sweep idled out');
  assert.ok(s.tick >= endAt);
  assert.deepEqual(s.cascade.lock, [], 'claims cleared');
  assert.deepEqual(s.cascade.pending, [], 'no orphaned falls');
  assert.equal(s.cascade.felled, 0);
});

test('a stack topple ignites a cascade only while armed (the coupling rule)', () => {
  const towerEngine = (over) =>
    makeEngine({
      width: 1400, height: 700, forbid: null, pandaCount: 10,
      anomKick: 1e9, cascadeKick: 1e9,
      stackKick: 1, stackGapMin: 1e9, stackGapMax: 1e9,
      paradeMin: 30, paradeMax: 30,
      ...over,
    });

  for (const armed of [false, true]) {
    const engine = towerEngine();
    let s = engine.step(engine.init(31));
    assert.ok(s.stack.baseId >= 0, 'a tower formed');
    if (armed) s = arm(s, engine.cfg);
    s = runUntil(engine, s, (st) => st.stack.baseId < 0, 800);
    assert.equal(s.stack.baseId, -1, 'and toppled');
    assert.equal(s.cascade.active, armed, `topple ignited: ${armed}`);
  }
});

test('the cascade is deterministic (same seed -> same digest through a full sweep)', () => {
  const engine = fieldEngine({ cascadeKick: 200, cascadeArmMin: 900, cascadeArmMax: 1200 });
  const eng = { init: engine.init, step: engine.step, encode: engine.encode };
  const a = runSeed({ engine: eng, seed: 606060, ticks: 4000 });
  const b = runSeed({ engine: eng, seed: 606060, ticks: 4000 });
  assert.equal(a.digest, b.digest);
});

// Run until `pred(state)` or `max` ticks; returns the state either way.
function runUntil(engine, s, pred, max = 1000) {
  for (let i = 0; i < max && !pred(s); i++) s = engine.step(s);
  return s;
}
