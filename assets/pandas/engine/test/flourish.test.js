// The hand-authored beats. The gaze is cosmetic and hard to assert on, so what is
// tested here is the part with teeth: the hat skit drives the real 17-way action
// seam, walks him to the hat, and hands him back — and the sim it drives stays
// exactly as pure as it was without it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine } from '../engine.js';
import { MODE, beginKnock } from '../state.js';
import { Rng } from '../rng.js';
import { isStep, ACTION } from '../actions.js';
import { hypot } from '../mathx.js';

// A DOM small enough to satisfy the loose hat's element, and nothing more.
function stubDom() {
  const el = () => ({
    style: {},
    className: '',
    innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {},
    remove() {},
  });
  globalThis.document = { createElement: el };
  globalThis.requestAnimationFrame = (fn) => fn(0);
  return { appendChild() {} };
}

let FETCH_GRAB_X = 0;
let FETCH_GRAB_Y = 0;

async function loadFlourish() {
  const mod = await import('../render/flourish.js');
  ({ FETCH_GRAB_X, FETCH_GRAB_Y } = mod);
  return mod.makeFlourish;
}

test('the skit drops the hat on a knock and walks him back to it', async () => {
  const stage = stubDom();
  const makeFlourish = await loadFlourish();
  const engine = makeEngine({ entrance: false, width: 1400, height: 620, pandaCount: 8 });
  const flourish = makeFlourish(stage);

  let state = engine.init(42);
  for (let i = 0; i < 40; i++) state = engine.step(state, flourish.action(state));
  assert.equal(flourish.skit, 'worn', 'nothing dropped while he is upright');

  // Shove him over.
  const hat = state.entities.find((e) => e.hasHat);
  beginKnock(hat, state.cfg, new Rng(state.rng), { faceDir: hat.dir, slideVx: 40, slideVy: 20 });
  state = engine.step(state, flourish.action(state));
  assert.equal(flourish.skit, 'dropped', 'the hat comes off on the way down');

  // Run until the skit hands him back, collecting what it did with the seam.
  const steps = [];
  let fetched = false;
  for (let i = 0; i < 1200 && !fetched; i++) {
    const a = flourish.action(state);
    if (a != null && isStep(a)) steps.push(a);
    state = engine.step(state, a);
    if (flourish.skit === 'worn') fetched = true;
  }
  assert.ok(fetched, 'the skit finishes and gives him back to the expert');
  assert.ok(steps.length > 0, 'he actually walked there');
  // Everything it emitted was a legal action, and never the dive-roll (he is
  // fetching a hat, not escaping).
  for (const a of steps) assert.ok(a >= ACTION.STEP_BASE && a < ACTION.ROLL_BASE);
  assert.equal(flourish.action(state), null, 'control is released, not held');
});

test('the fetch heads toward the hat, not away from it', async () => {
  const stage = stubDom();
  const makeFlourish = await loadFlourish();
  const engine = makeEngine({ entrance: false, width: 1400, height: 620, pandaCount: 8 });
  const flourish = makeFlourish(stage);

  let state = engine.init(9);
  const hat = state.entities.find((e) => e.hasHat);
  beginKnock(hat, state.cfg, new Rng(state.rng), { faceDir: hat.dir, slideVx: 0, slideVy: 0 });

  // He walks to a spot beside the hat (so his body ends up over it), not to the
  // hat's own top-left corner — that offset is what the gap is measured against.
  const gapTo = (h, rest) => hypot(h.lx - (rest.x - FETCH_GRAB_X), h.ly - (rest.y - FETCH_GRAB_Y));

  let closing = 0;
  let opening = 0;
  let firstGap = null;
  let lastGap = null;
  for (let i = 0; i < 1200; i++) {
    const a = flourish.action(state);
    const rest = flourish.hatRest;
    const before = rest ? gapTo(state.entities.find((e) => e.hasHat), rest) : null;
    state = engine.step(state, a);
    if (rest && a != null && isStep(a)) {
      const after = gapTo(state.entities.find((e) => e.hasHat), rest);
      if (after < before) closing++;
      else opening++;
      if (firstGap === null) firstGap = before;
      lastGap = after;
    }
    if (flourish.skit === 'worn' && closing > 0) break;
  }
  assert.ok(closing > opening, `strides closed the gap (${closing} closing / ${opening} opening)`);
  assert.ok(lastGap < firstGap, `he ended up nearer the hat (${firstGap} -> ${lastGap})`);
});
