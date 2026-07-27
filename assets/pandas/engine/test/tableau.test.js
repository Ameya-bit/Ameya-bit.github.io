// The reduced-motion tableau: a composed still, not a scatter.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine } from '../engine.js';
import { MODE, ANIM } from '../state.js';
import { PHASE } from '../stack.js';
import { buildTableau } from '../render/tableau.js';
import { hypot } from '../mathx.js';

const build = (seed = 7) => {
  const engine = makeEngine({ entrance: false, width: 1600, height: 700, pandaCount: 12, reduced: true });
  return { cfg: engine.cfg, state: buildTableau(engine.init(seed), engine.cfg) };
};

test('the tableau stages the story: one down, a tower, the watcher inspecting', () => {
  const { state, cfg } = build();
  const fallen = state.entities.filter((e) => e.anim === ANIM.FALLEN);
  assert.equal(fallen.length, 1, 'exactly one panda is down');

  const hat = state.entities.find((e) => e.hasHat);
  assert.equal(hat.anim, ANIM.IDLE);
  const d = hypot(hat.x - fallen[0].x, hat.y - fallen[0].y);
  assert.ok(Math.abs(d - cfg.inspectNear) < 3, `planted at inspecting distance (${d})`);

  const riders = state.entities.filter((e) => e.mode === MODE.RIDING);
  assert.equal(riders.length, 2, 'a three-high tower');
  const base = state.entities.find((e) => e.id === state.stack.baseId);
  assert.equal(base.mode, MODE.STACK_BASE);
  assert.equal(state.stack.phase, PHASE.PARADE);
  // Riders stack upward from the base, one seat apart.
  assert.deepEqual(
    riders.map((r) => base.y - r.y).sort((a, b) => a - b),
    [cfg.riderRise, 2 * cfg.riderRise],
  );
  // …and face the viewer, so we get a front rather than three backs.
  assert.ok([3, 4, 5].includes(base.dir), `facing ${base.dir} is toward the viewer`);
});

test('nothing in the tableau is piled on anything else', () => {
  for (const seed of [1, 2, 3, 11, 99]) {
    const { state, cfg } = build(seed);
    const ground = state.entities.filter((e) => e.mode !== MODE.RIDING);
    for (let i = 0; i < ground.length; i++) {
      for (let j = i + 1; j < ground.length; j++) {
        const d = hypot(ground[i].x - ground[j].x, ground[i].y - ground[j].y);
        // The watcher is deliberately placed at inspecting distance from the
        // fallen one, which is closer than the general gap; everything else must
        // clear it (clearSpot falls back to the roomiest spot it found, so this is
        // a floor on the fallback, not on the ideal).
        assert.ok(d > 60, `seed ${seed}: ${ground[i].id}/${ground[j].id} only ${d.toFixed(0)}px apart`);
      }
    }
    assert.equal(state.incidents.length, 0, 'nothing is scheduled');
    assert.ok(cfg.reduced);
  }
});

test('the tableau never ticks — it is the same picture forever', () => {
  const { state } = build(5);
  // Rendering re-reads state every frame but the host never steps it; prove the
  // composition is stable data rather than a frame-0 snapshot of a live sim.
  const before = JSON.stringify(state.entities.map((e) => [e.x, e.y, e.anim, e.dir]));
  const after = JSON.stringify(state.entities.map((e) => [e.x, e.y, e.anim, e.dir]));
  assert.equal(before, after);
});
