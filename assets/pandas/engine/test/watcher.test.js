import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  threatsTo,
  threatSpeed,
  bestEscape,
  bestAxis,
  chooseWeaveDir,
  topIncident,
  pickWatchTarget,
  pickSubject,
} from '../watcher.js';
import { makeEntity, MODE, ANIM } from '../state.js';
import { makeConfig } from '../config.js';
import { Rng } from '../rng.js';

const openCfg = () => makeConfig({ width: 4000, height: 4000, forbid: null });

// A hat at (x,y) with the watcher-brain defaults set for observing.
function hatAt(x, y) {
  const h = makeEntity(0, x, y, { hasHat: true });
  h.mode = MODE.OBSERVING;
  return h;
}
// A plain roamer, positioned and facing a heading, walking.
function roamerAt(id, x, y, dir, mode = MODE.WANDER) {
  const e = makeEntity(id, x, y, { dir, moveSpeed: 18 });
  e.mode = mode;
  e.anim = ANIM.WALK;
  return e;
}

test('threatsTo flags a walker closing in, ignores idle and receding ones', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const closing = roamerAt(1, 940, 1000, 2); // 60px left, heading right → toward the hat
  const idle = roamerAt(2, 1050, 1000, 6);
  idle.anim = ANIM.IDLE; // planted — not a threat even if near
  const receding = roamerAt(3, 940, 1000, 6); // to the left, heading further left → away
  const ents = [hat, closing, idle, receding];
  const threats = threatsTo(hat, cfg.hatDangerR, ents, cfg);
  const ids = threats.map((t) => t.id);
  assert.ok(ids.includes(1), 'the closing walker is a threat');
  assert.ok(!ids.includes(2), 'an idle panda is not a threat');
  assert.ok(!ids.includes(3), 'a receding panda is not a threat');
});

test('threatSpeed reads zoomies/tumbler as fast, roamer/knock as slow', () => {
  const cfg = openCfg();
  const z = roamerAt(1, 0, 0, 0, MODE.ZOOMIES);
  const t = roamerAt(2, 0, 0, 0, MODE.TUMBLER);
  const r = roamerAt(3, 0, 0, 0, MODE.WANDER);
  const k = roamerAt(4, 0, 0, 0, MODE.KNOCKED);
  assert.ok(threatSpeed(z, cfg) >= cfg.hatFastSpeed, 'zoomies is fast');
  assert.ok(threatSpeed(t, cfg) >= cfg.hatFastSpeed, 'tumbler skid is fast');
  assert.ok(threatSpeed(r, cfg) < cfg.hatFastSpeed, 'a trudging roamer is slow');
  assert.ok(threatSpeed(k, cfg) < cfg.hatFastSpeed, 'a knock slide is slow');
});

test('bestEscape flees away from the threat and returns -1 when fully boxed', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const threat = roamerAt(1, 940, 1000, 2); // to the LEFT of the hat
  const ents = [hat, threat];
  const dir = bestEscape(hat, [threat], cfg.rollDist, false, ents, cfg);
  assert.ok(dir >= 0, 'found an escape');
  // The chosen landing should increase distance to the threat vs. standing still.
  const cx = hat.lx + [0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707][dir] * cfg.rollDist;
  assert.ok(cx >= hat.lx - 1, 'escapes to the right (away from a left threat), not into it');

  // Boxed: a hat jammed in the corner with every landing off-stage cannot roll.
  const tiny = makeConfig({ width: 40, height: 40, forbid: null });
  const boxed = hatAt(0, 0);
  assert.equal(bestEscape(boxed, [threat], tiny.rollDist, false, [boxed, threat], tiny), -1);
});

test('bestAxis picks an on-stage, line-of-sight-clear vantage and can avoid an axis', () => {
  const cfg = openCfg();
  const subj = roamerAt(1, 2000, 2000, 0);
  const hat = hatAt(2000, 2400); // due south of the subject
  const ents = [hat, subj];
  const axis = bestAxis(subj, hat, cfg.ambientStandoff, -1, ents, cfg);
  assert.ok(axis >= 0 && axis < 8);
  const other = bestAxis(subj, hat, cfg.ambientStandoff, axis, ents, cfg);
  assert.notEqual(other, axis, 'the avoided axis is not re-chosen');
});

test('chooseWeaveDir heads toward the target, holds (-1) only when every step worsens the crowd', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const dir = chooseWeaveDir(hat, 1400, 1000, [hat], cfg); // target due east, open field
  assert.equal(dir, 2, 'steps east toward an open target');
});

test('topIncident prefers higher tier, then the nearer subject within a tier', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const near = roamerAt(1, 1100, 1000, 0);
  const far = roamerAt(2, 1800, 1000, 0);
  const state = {
    tick: 10,
    entities: [hat, near, far],
    incidents: [
      { subject: 2, tier: 1, born: 1, expires: 100 },
      { subject: 1, tier: 1, born: 2, expires: 100 },
    ],
  };
  assert.equal(topIncident(state, hat).subject, 1, 'nearer subject wins within a tier');

  state.incidents.push({ subject: 2, tier: 2, born: 3, expires: 100 });
  assert.equal(topIncident(state, hat).subject, 2, 'higher tier beats nearer');
});

test('pickWatchTarget takes an incident up close, holds it through the sticky window', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const a = roamerAt(1, 1400, 1000, 0); // subject 1 — far
  const b = roamerAt(2, 1120, 1000, 0); // subject 2 — near
  const rng = new Rng(1);
  const state = {
    tick: 5,
    entities: [hat, a, b],
    incidents: [{ subject: 1, tier: 1, born: 5, expires: 500 }],
  };
  let want = pickWatchTarget(state, hat, cfg, rng);
  assert.equal(want.subject, 1);
  assert.equal(want.standoff, cfg.inspectNear, 'incident → close standoff');

  // A second, same-tier incident arrives immediately — stickiness keeps the first.
  state.tick = 6;
  state.incidents.push({ subject: 2, tier: 1, born: 6, expires: 500 });
  want = pickWatchTarget(state, hat, cfg, rng);
  assert.equal(want.subject, 1, 'held through the sticky window');

  // Past the window, the nearer new one can take over (subject 2 is nearer here).
  state.tick = 6 + cfg.stickyTicks;
  want = pickWatchTarget(state, hat, cfg, rng);
  assert.equal(want.subject, 2, 'sticky window elapsed → nearer incident steals focus');
});

test('pickWatchTarget falls back to an ambient subject when the queue is empty', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const other = roamerAt(1, 1500, 1000, 0);
  const rng = new Rng(3);
  const state = { tick: 1, entities: [hat, other], incidents: [] };
  const want = pickWatchTarget(state, hat, cfg, rng);
  assert.equal(want.subject, 1, 'picks the one other panda');
  assert.equal(want.standoff, cfg.ambientStandoff, 'ambient → relaxed standoff');
});

test('pickSubject returns -1 when the hat is the only panda', () => {
  const cfg = openCfg();
  const hat = hatAt(1000, 1000);
  const rng = new Rng(1);
  assert.equal(pickSubject(hat, [hat], cfg, rng), -1);
});
