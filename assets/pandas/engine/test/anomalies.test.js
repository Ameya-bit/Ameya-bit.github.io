import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAnomaly, updateAnomaly, ANOMALY_KINDS } from '../anomalies.js';
import { makeEntity, MODE, MODE_NAME, ANIM, isDown } from '../state.js';
import { makeConfig } from '../config.js';
import { makeEngine } from '../engine.js';
import { Rng } from '../rng.js';
import { runSeed } from '../tools/trace.js';

// A lone entity in open space, for testing one FSM in isolation.
function lone(cfg) {
  const e = makeEntity(1, 2000, 2000, { dir: 2, moveSpeed: 18 });
  return e;
}
const openCfg = () => makeConfig({ width: 4000, height: 4000, forbid: null });

// Run an anomaly to completion (back to WANDER), returning a trace of facts.
function runToEnd(e, cfg, rng, maxTicks = 2000) {
  const trace = { ticks: 0, wentDown: false, maxDx: 0, sawPop: false, dirs: new Set() };
  const [sx, sy] = [e.lx, e.ly];
  let prevLx = e.lx;
  let stall = 0;
  for (let i = 0; i < maxTicks && e.mode !== MODE.WANDER; i++) {
    updateAnomaly(e, cfg, rng);
    trace.ticks++;
    if (isDown(e)) trace.wentDown = true;
    trace.dirs.add(e.dir);
    trace.maxDx = Math.max(trace.maxDx, Math.hypot(e.lx - sx, e.ly - sy));
    if (e.lx === prevLx && !isDown(e)) stall++;
    else stall = 0;
    if (stall >= 3) trace.sawPop = true; // a horizontal pause = the hiccup pop
    prevLx = e.lx;
  }
  trace.ended = e.mode === MODE.WANDER;
  return trace;
}

test('sleeper lies down for a nap, then gets back up', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(1);
  const ttl = startAnomaly(e, ANOMALY_KINDS.indexOf('sleeper'), cfg, rng);
  assert.equal(e.mode, MODE.SLEEPER);
  assert.ok(ttl > cfg.sleepMin, 'ttl covers the nap');
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.wentDown, 'went to the ground');
  assert.ok(t.ended, 'stood back up');
  assert.ok(t.ticks >= cfg.sleepMin, `napped long enough (${t.ticks})`);
});

test('zoomies bolts in a straight line and travels far', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(3);
  startAnomaly(e, ANOMALY_KINDS.indexOf('zoomies'), cfg, rng);
  assert.equal(e.mode, MODE.ZOOMIES);
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.ended);
  assert.ok(t.maxDx > 200, `bolted a good distance (${t.maxDx.toFixed(0)})`);
  // Straight line: it only ever faced one heading (never turned mid-dash).
  assert.equal(t.dirs.size, 1, 'held a single heading the whole dash');
});

test('zoomies crashes and tumbles when it hits a wall', () => {
  const cfg = makeConfig({ width: 4000, height: 4000, forbid: null });
  const e = makeEntity(1, 200, 2000, { dir: 6 }); // near the left wall, will dash into it
  const rng = new Rng(1);
  // force a leftward heading by seeding; just set it directly for the test
  startAnomaly(e, ANOMALY_KINDS.indexOf('zoomies'), cfg, rng);
  e.aHeading = 6; // left
  e.dir = 6;
  let crashed = false;
  for (let i = 0; i < 2000 && e.mode !== MODE.WANDER; i++) {
    updateAnomaly(e, cfg, rng);
    if (isDown(e)) crashed = true;
  }
  assert.ok(crashed, 'crashed into the wall and went down');
});

test('loop returns near its origin after closing octagons', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(5);
  const [sx, sy] = [e.lx, e.ly];
  startAnomaly(e, ANOMALY_KINDS.indexOf('loop'), cfg, rng);
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.ended);
  assert.ok(t.maxDx > cfg.step, 'actually traced a loop out from origin');
  assert.ok(Math.hypot(e.lx - sx, e.ly - sy) < 2 * cfg.step, 'came back near the start');
});

test('starer holds an idle stare, then walks on', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(7);
  startAnomaly(e, ANOMALY_KINDS.indexOf('starer'), cfg, rng);
  assert.equal(e.anim, ANIM.IDLE);
  const [sx, sy] = [e.lx, e.ly];
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.ended);
  assert.equal(t.maxDx, 0, 'never moved while staring');
  assert.ok(t.ticks >= cfg.stareMin);
});

test('spinner cycles through facings then walks on', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(9);
  startAnomaly(e, ANOMALY_KINDS.indexOf('spinner'), cfg, rng);
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.ended);
  assert.ok(t.dirs.size >= 8, `spun through all facings (${t.dirs.size})`);
});

test('moonwalk faces the opposite of its travel heading', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(11);
  startAnomaly(e, ANOMALY_KINDS.indexOf('moonwalk'), cfg, rng);
  assert.equal(e.dir, (e.aHeading + 4) % 8, 'faces backwards');
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.ended);
  assert.ok(t.maxDx > cfg.step, 'drifted along its heading');
});

test('tumbler skids, then falls, then recovers', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(13);
  startAnomaly(e, ANOMALY_KINDS.indexOf('tumbler'), cfg, rng);
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.wentDown, 'ended up on the ground');
  assert.ok(t.ended, 'picked itself up');
});

test('hiccup pops (pauses) between strides and recovers', () => {
  const cfg = openCfg();
  const e = lone(cfg);
  const rng = new Rng(17);
  startAnomaly(e, ANOMALY_KINDS.indexOf('hiccup'), cfg, rng);
  const t = runToEnd(e, cfg, rng);
  assert.ok(t.ended);
  assert.ok(t.sawPop, 'held position for the pop');
});

test('an on-feet anomaly is knockable; a grounded one is not', () => {
  const cfg = openCfg();
  const rng = new Rng(2);
  const spinner = lone(cfg);
  startAnomaly(spinner, ANOMALY_KINDS.indexOf('spinner'), cfg, rng);
  assert.equal(isDown(spinner), false, 'a spinner is on its feet — collidable');

  const sleeper = lone(cfg);
  startAnomaly(sleeper, ANOMALY_KINDS.indexOf('sleeper'), cfg, rng);
  // advance past the fall into the nap
  for (let i = 0; i < cfg.fallTicks + 2; i++) updateAnomaly(sleeper, cfg, rng);
  assert.equal(isDown(sleeper), true, 'a napping sleeper is down — not re-knockable');
});

// ---- the director, in the full engine ----

test('the director starts anomalies over time, never the hat or oblivious one', () => {
  const engine = makeEngine({ width: 2600, height: 1400, pandaCount: 15, forbid: null });
  let s = engine.init(20260726);
  const kindStarts = [];
  const prevMode = new Map(s.entities.map((e) => [e.id, e.mode]));
  for (let i = 0; i < 6000; i++) {
    s = engine.step(s);
    for (const e of s.entities) {
      const was = prevMode.get(e.id);
      if (was === MODE.WANDER && e.mode >= MODE.SLEEPER) {
        kindStarts.push({ id: e.id, mode: e.mode, hasHat: e.hasHat, oblivious: e.oblivious });
      }
      prevMode.set(e.id, e.mode);
    }
  }
  assert.ok(kindStarts.length >= 8, `several anomalies fired (${kindStarts.length})`);
  assert.ok(!kindStarts.some((k) => k.hasHat), 'the hat panda is never chosen');
  assert.ok(!kindStarts.some((k) => k.oblivious), 'the oblivious one is never chosen');
});

test('the director never runs the same kind twice in a row', () => {
  const engine = makeEngine({ width: 2600, height: 1400, pandaCount: 15, forbid: null });
  let s = engine.init(42);
  let lastLast = s.director.last;
  const seq = [];
  for (let i = 0; i < 8000; i++) {
    s = engine.step(s);
    if (s.director.last !== lastLast) {
      seq.push(s.director.last);
      lastLast = s.director.last;
    }
  }
  assert.ok(seq.length >= 6, `saw several director picks (${seq.length})`);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], 'no back-to-back repeats');
});

test('anomalies post incidents to the queue', () => {
  const engine = makeEngine({ width: 2600, height: 1400, pandaCount: 15, forbid: null });
  let s = engine.init(5);
  let sawIncident = false;
  for (let i = 0; i < 3000 && !sawIncident; i++) {
    s = engine.step(s);
    if (s.incidents.length > 0) sawIncident = true;
  }
  assert.ok(sawIncident, 'the incident queue received at least one entry');
});

test('the engine stays deterministic with anomalies + director', () => {
  const engine = makeEngine({ width: 2600, height: 1400, pandaCount: 15, forbid: null });
  const eng = { init: engine.init, step: engine.step, encode: engine.encode };
  const a = runSeed({ engine: eng, seed: 314, ticks: 2000 });
  const b = runSeed({ engine: eng, seed: 314, ticks: 2000 });
  assert.equal(a.digest, b.digest);
});
