// The renderer, driven headlessly against a stub DOM.
//
// This does not (and cannot) judge how anything looks — that is Ameya's call on
// the live preview. What it checks is the mechanical contract: one element per
// panda, positions that interpolate, cels and facings that follow state, riders
// seated on the *drawn* head rather than the engine's flat stand-in, and nothing
// written back into the sim.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine } from '../engine.js';
import { MODE, ANIM } from '../state.js';
import { PHASE } from '../stack.js';
import { CELL, FACING } from '../render/cels.js';
import { seatRise } from '../render/art.js';
import { dirIndex } from '../dirs.js';

// A DOM stub just deep enough for the renderer: elements with a style bag, a
// class name, and a two-level child chain (wrapper > inner > sprite), which is
// what `innerHTML` builds in the real thing.
function fakeElement(depth = 0) {
  const el = {
    style: {},
    className: '',
    children: [],
    _innerHTML: '',
    classList: {
      toggle() {},
      add() {},
      remove() {},
    },
    appendChild(child) {
      el.children.push(child);
    },
    remove() {},
    get innerHTML() {
      return el._innerHTML;
    },
    set innerHTML(html) {
      el._innerHTML = html;
      el.firstChild = depth < 2 ? fakeElement(depth + 1) : null;
      if (el.firstChild) el.firstChild.firstChild = fakeElement(depth + 2);
    },
  };
  return el;
}

function stubDom() {
  globalThis.document = { createElement: () => fakeElement() };
  const stage = fakeElement();
  return stage;
}

const translateOf = (el) => el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).slice(1).map(Number);

async function loadRenderer() {
  const { makeRenderer } = await import('../render/renderer.js');
  return makeRenderer;
}

test('one element per panda, positioned and depth-sorted from state', async () => {
  const stage = stubDom();
  const makeRenderer = await loadRenderer();
  const engine = makeEngine({ width: 1400, height: 620, pandaCount: 6 });
  const renderer = makeRenderer(stage);

  let state = engine.init(3);
  renderer.sync(null, state, 1, 16);
  assert.equal(stage.children.length, 6);
  assert.equal(renderer.views.size, 6);

  const e = state.entities[2];
  const view = renderer.views.get(e.id);
  assert.deepEqual(translateOf(view.el), [e.x, e.y]);
  assert.equal(Number(view.el.style.zIndex), Math.round(e.y), 'depth comes from y');

  // A second frame reuses the same elements — no churn.
  state = engine.step(state);
  renderer.sync(state, state, 1, 16);
  assert.equal(stage.children.length, 6);
});

test('positions interpolate between the two held ticks', async () => {
  const stage = stubDom();
  const makeRenderer = await loadRenderer();
  const engine = makeEngine({ width: 1400, height: 620, pandaCount: 4 });
  const renderer = makeRenderer(stage);

  // Run on until somebody's first stride is actually gliding.
  let prev = engine.init(11);
  let cur = engine.step(prev);
  let moved = null;
  for (let i = 0; i < 60 && !moved; i++) {
    prev = cur;
    cur = engine.step(cur);
    moved = cur.entities.find((e, k) => e.x !== prev.entities[k].x);
  }
  assert.ok(moved, 'someone is mid-glide');

  renderer.sync(prev, cur, 0.5, 16);
  const [x] = translateOf(renderer.views.get(moved.id).el);
  const before = prev.entities.find((q) => q.id === moved.id).x;
  assert.ok(
    Math.abs(x - (before + moved.x) / 2) < 1e-6,
    `half a tick in: ${x} between ${before} and ${moved.x}`,
  );
});

test('the drawn cel and row follow the sim\'s anim and facing', async () => {
  const stage = stubDom();
  const makeRenderer = await loadRenderer();
  const engine = makeEngine({ width: 1400, height: 620, pandaCount: 3 });
  const renderer = makeRenderer(stage);

  const state = engine.init(5);
  const e = state.entities[1];
  e.dir = dirIndex('downleft');
  e.anim = ANIM.FALLEN;
  renderer.sync(null, state, 1, 0);

  const view = renderer.views.get(e.id);
  // FALLEN is the single cel 7 of the dDown row, and downleft is mirrored.
  assert.equal(view.sprite.style.marginLeft, `-${7 * CELL}px`);
  assert.equal(view.sprite.style.marginTop, `-${FACING[dirIndex('downleft')].rowIndex * CELL}px`);
  assert.equal(view.inner.className, 'panda_inner_wrapper facing_downleft');
});

test('a rider sits on the drawn head, not on the engine\'s flat stand-in', async () => {
  const stage = stubDom();
  const makeRenderer = await loadRenderer();
  const engine = makeEngine({ width: 1400, height: 620, pandaCount: 5 });
  const renderer = makeRenderer(stage);

  // Hand-build a two-high tower rather than waiting ~60s of sim for one.
  const state = engine.init(17);
  const [, base, rider] = state.entities;
  base.mode = MODE.STACK_BASE;
  base.dir = dirIndex('down');
  rider.mode = MODE.RIDING;
  rider.riding = true;
  rider.stackLevel = 1;
  rider.dir = base.dir;
  rider.x = base.x;
  rider.y = base.y - engine.cfg.riderRise;
  state.stack.baseId = base.id;
  state.stack.riders = [rider.id];
  state.stack.phase = PHASE.PARADE;

  renderer.sync(null, state, 1, 0);
  const view = renderer.views.get(rider.id);
  const [, y] = translateOf(view.el);
  const rise = seatRise(base.dir);
  assert.ok(rise < engine.cfg.riderRise, 'the seated art really is shorter');
  assert.ok(Math.abs(y - (base.y - rise)) < 1e-6, `seated one drawn seat above the base (${y})`);
  // …drawn over the base, which a y-derived depth alone would not manage.
  assert.ok(Number(view.el.style.zIndex) > Math.round(base.y) - 1);
  assert.match(view.el.className, /riding/);
  assert.match(view.el.style.transform, /rotate\(/, 'and teetering with the tower');
});

test('rendering never writes back into sim state', async () => {
  const stage = stubDom();
  const makeRenderer = await loadRenderer();
  const engine = makeEngine({ width: 1400, height: 620, pandaCount: 6 });
  const renderer = makeRenderer(stage);

  let plain = engine.init(23);
  let drawn = engine.init(23);
  for (let i = 0; i < 300; i++) {
    plain = engine.step(plain);
    const prev = drawn;
    drawn = engine.step(drawn);
    renderer.sync(prev, drawn, 0.4, 16);
  }
  assert.deepEqual(engine.encode(drawn), engine.encode(plain));
});
