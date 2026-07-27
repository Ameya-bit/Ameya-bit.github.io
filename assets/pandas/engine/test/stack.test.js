import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../engine.js';
import { MODE, ANIM, isDown } from '../state.js';
import { PHASE } from '../stack.js';
import { detectCollisions } from '../collision.js';
import { startAnomaly, ANOMALY_KINDS } from '../anomalies.js';
import { runSeed } from '../tools/trace.js';

// An engine whose stack director fires immediately, on a roomy stage so the base
// always has headroom for a 3-high tower and nothing is clamped by an edge.
const stackEngine = (over = {}) =>
  makeEngine({
    width: 2400, height: 1200, forbid: null, pandaCount: 8,
    stackKick: 1, stackGapMin: 100000, stackGapMax: 100000, // one tower, then never again
    ...over,
  });

const baseOf = (s) => s.entities.find((e) => e.id === s.stack.baseId);
const ridersOf = (s) => s.stack.riders.map((id) => s.entities.find((e) => e.id === id));

// Run until `pred(state)` or `max` ticks; returns the state either way.
function runUntil(engine, s, pred, max = 4000) {
  for (let i = 0; i < max && !pred(s); i++) s = engine.step(s);
  return s;
}

test('the stack director recruits a base and 1-2 riders, and posts a tier-2 incident', () => {
  const engine = stackEngine();
  let s = engine.step(engine.init(11));
  assert.ok(s.stack.baseId >= 0, 'a tower formed on the first director tick');
  const base = baseOf(s);
  assert.equal(base.mode, MODE.STACK_BASE);
  assert.ok(base.solid, 'the base is an unstoppable force from the first frame');
  assert.equal(base.anim, ANIM.IDLE, 'and holds still during assembly');
  assert.ok(s.stack.mounters.length >= 1 && s.stack.mounters.length <= 2, '2-high or 3-high');

  const inc = s.incidents.find((i) => i.tier === 2);
  assert.ok(inc, 'a tier-2 incident is posted');
  assert.equal(inc.subject, base.id);
  assert.equal(inc.expires - inc.born, engine.cfg.stackIncidentTtl);
});

test('a climber ghosts through the field, hops, and lands seated one body-height up', () => {
  const engine = stackEngine();
  let s = engine.step(engine.init(12));
  const climberId = s.stack.mounters[0];

  // While climbing it is a collision ghost — mid-walk `flying`, and still a ghost
  // once seated (`riding`), so the tower can never be jostled apart.
  s = runUntil(engine, s, (st) => st.stack.phase === PHASE.FLIGHT);
  assert.equal(s.stack.phase, PHASE.FLIGHT, 'reached the hop');
  const inFlight = s.entities.find((e) => e.id === climberId);
  assert.ok(inFlight.flying, 'mid-arc pandas are ghosts');
  assert.equal(inFlight.mode, MODE.MOUNTING);

  s = runUntil(engine, s, (st) => st.stack.riders.includes(climberId));
  const rider = s.entities.find((e) => e.id === climberId);
  const base = baseOf(s);
  assert.equal(rider.mode, MODE.RIDING);
  assert.ok(rider.riding && !rider.flying, 'pinned ghost, no longer mid-arc');
  assert.equal(rider.stackLevel, 1, 'the first one up sits on level 1');
  assert.equal(rider.ly, base.ly - engine.cfg.riderRise, 'feet on the head below');
  assert.equal(rider.lx, base.lx);
});

test('stack members never collide — the base knocks without being knocked', () => {
  const engine = stackEngine();
  let s = engine.step(engine.init(13));
  s = runUntil(engine, s, (st) => st.stack.phase === PHASE.PARADE);
  assert.equal(s.stack.phase, PHASE.PARADE, 'the tower assembled');
  const base = baseOf(s);

  // A roamer shoved right onto the base: it takes the hit, the solid base does not.
  const bystander = s.entities.find((e) => !e.hasHat && e.mode === MODE.WANDER);
  const field = s.entities.map((e) =>
    e.id === bystander.id ? { ...e, x: base.x + 10, y: base.y, lx: base.x + 10, ly: base.y } : e,
  );
  const hits = detectCollisions(field, engine.cfg);
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes(bystander.id), 'the roamer registers the contact');
  assert.ok(!ids.includes(base.id), 'the base is never knocked');
  for (const r of ridersOf(s)) assert.ok(!ids.includes(r.id), 'riders are ghosts');
});

test('the parade walks the base and the riders track it exactly', () => {
  const engine = stackEngine();
  let s = engine.step(engine.init(14));
  s = runUntil(engine, s, (st) => st.stack.phase === PHASE.PARADE && st.stack.riders.length > 0);
  assert.equal(s.stack.phase, PHASE.PARADE);

  const start = { x: baseOf(s).lx, y: baseOf(s).ly };
  let moved = false;
  for (let i = 0; i < 200; i++) {
    s = engine.step(s);
    if (s.stack.baseId < 0) break; // toppled early (a zoomies) — covered elsewhere
    const base = baseOf(s);
    // The riders are re-pinned every tick: exact seat height, no glide lag.
    ridersOf(s).forEach((r, idx) => {
      assert.equal(r.ly, base.ly - (idx + 1) * engine.cfg.riderRise, 'seat height holds');
      assert.equal(r.x, r.lx, 'no glide — the visual position is snapped');
      assert.equal(r.dir, base.dir, 'riders face the tower heading');
    });
    if (base.lx !== start.x || base.ly !== start.y) moved = true;
  }
  assert.ok(moved, 'the tower paraded');
});

test('the parade clock topples the tower into an ordinary three-way knock', () => {
  // A short parade so the topple lands inside the test budget.
  const engine = stackEngine({ paradeMin: 40, paradeMax: 40 });
  let s = engine.step(engine.init(15));
  s = runUntil(engine, s, (st) => st.stack.phase === PHASE.PARADE);
  const cast = [s.stack.baseId, ...s.stack.riders];
  assert.ok(cast.length >= 2);

  s = runUntil(engine, s, (st) => st.stack.baseId < 0, 500);
  assert.equal(s.stack.baseId, -1, 'the tower is gone');
  for (const id of cast) {
    const e = s.entities.find((q) => q.id === id);
    assert.ok(!e.solid && !e.riding && !e.flying, `every stack flag dropped on #${id}`);
    assert.equal(e.stackLevel, 0);
  }
  // The pile is coincident, so within a tick or two the collision pass fells it.
  s = runUntil(engine, s, (st) => cast.every((id) => isDown(st.entities.find((q) => q.id === id))), 20);
  for (const id of cast) {
    assert.ok(isDown(s.entities.find((q) => q.id === id)), `#${id} went down with the tower`);
  }
});

test('a zoomies runaway into the tower brings it down early', () => {
  const engine = stackEngine({ paradeMin: 100000, paradeMax: 100000 }); // never times out
  let s = engine.step(engine.init(16));
  s = runUntil(engine, s, (st) => st.stack.phase === PHASE.PARADE);
  const base = baseOf(s);

  // Park a zoomies inside toppleHitR of the base.
  const runner = s.entities.find((e) => !e.hasHat && e.mode === MODE.WANDER);
  s = {
    ...s,
    entities: s.entities.map((e) => {
      if (e.id !== runner.id) return e;
      const z = { ...e, lx: base.lx + 20, ly: base.ly, x: base.lx + 20, y: base.ly };
      startAnomaly(z, ANOMALY_KINDS.indexOf('zoomies'), engine.cfg, {
        int: () => 0, next: () => 0, intBetween: (lo) => lo, pick: (a) => a[0], chance: () => false,
      });
      return z;
    }),
  };
  s = engine.step(s);
  assert.equal(s.stack.baseId, -1, 'struck — the tower came down at once');
});

test('at most one tower at a time, and none at all without a pool of three', () => {
  // Director fires every tick: it must still never build a second tower.
  const engine = stackEngine({ stackGapMin: 1, stackGapMax: 1, paradeMin: 100000, paradeMax: 100000 });
  let s = engine.init(17);
  const bases = new Set();
  for (let i = 0; i < 600; i++) {
    s = engine.step(s);
    if (s.stack.baseId >= 0) bases.add(s.stack.baseId);
    assert.ok(s.entities.filter((e) => e.mode === MODE.STACK_BASE).length <= 1, 'one base, always');
    assert.ok(s.stack.riders.length <= 2, 'at most two riders');
  }
  assert.equal(bases.size, 1, 'exactly one tower over the whole run');

  // Too few free roamers (hat + oblivious + one) — the set piece never fires.
  const tiny = makeEngine({ width: 2400, height: 1200, forbid: null, pandaCount: 3, stackKick: 1, stackGapMin: 1, stackGapMax: 1 });
  let t = tiny.init(18);
  for (let i = 0; i < 200; i++) t = tiny.step(t);
  assert.equal(t.stack.baseId, -1, 'no tower without a field to leave behind');
});

test('the stack is deterministic (same seed -> same digest through a full cycle)', () => {
  const engine = stackEngine({ paradeMin: 60, paradeMax: 90, stackGapMin: 300, stackGapMax: 400 });
  const eng = { init: engine.init, step: engine.step, encode: engine.encode };
  const a = runSeed({ engine: eng, seed: 424242, ticks: 3000 });
  const b = runSeed({ engine: eng, seed: 424242, ticks: 3000 });
  assert.equal(a.digest, b.digest);
});
