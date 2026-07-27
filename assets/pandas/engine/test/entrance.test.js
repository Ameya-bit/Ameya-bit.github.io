// The entrance: the troupe walks on from off-stage rather than appearing.
//
// It matters twice over — it is the opening beat of the page, and it is the first
// ~20 seconds of every episode a policy will be deployed into, so the training
// corpora need to contain it (hence `cfg.entrance` rather than a host-side script).

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine } from '../engine.js';
import { MODE } from '../state.js';
import { inBounds } from '../geometry.js';
import { detectCollisions } from '../collision.js';

const CFG = { entrance: true, width: 1600, height: 700, pandaCount: 9 };

// Step until nobody is still walking on (or give up, which is a failure).
function settle(engine, state, cap = 4000) {
  let ticks = 0;
  while (state.entities.some((e) => e.entering) && ticks < cap) {
    state = engine.step(state);
    ticks++;
  }
  return { state, ticks };
}

test('everyone starts off-stage and walks on to a spot inside it', () => {
  const engine = makeEngine(CFG);
  const start = engine.init(31);

  for (const e of start.entities) {
    assert.equal(e.mode, MODE.ENTERING);
    assert.ok(e.entering, `#${e.id} is a ghost while entering`);
    assert.ok(!inBounds(engine.cfg, e.lx, e.ly), `#${e.id} starts off-stage`);
  }

  // Catch each one at the tick it arrives: after that it is an ordinary roamer and
  // has already walked off somewhere else.
  const arrivals = new Map();
  let state = start;
  let ticks = 0;
  while (state.entities.some((e) => e.entering) && ticks < 4000) {
    const wasEntering = new Set(state.entities.filter((e) => e.entering).map((e) => e.id));
    state = engine.step(state);
    ticks++;
    for (const e of state.entities) {
      if (wasEntering.has(e.id) && !e.entering) arrivals.set(e.id, { e, pos: [e.lx, e.ly], home: e.home });
    }
  }
  assert.ok(ticks < 4000, 'the whole troupe arrives');
  assert.equal(arrivals.size, start.entities.length, 'every one of them arrived');
  for (const [id, { e, pos, home }] of arrivals) {
    assert.ok(inBounds(engine.cfg, ...pos), `#${id} arrived on stage`);
    // It steps onto its target exactly — unless the field knocked it over on the
    // very tick it stopped being a ghost, in which case the knock owns its
    // position (and it has had an eventful arrival).
    if (e.mode !== MODE.KNOCKED) {
      assert.deepEqual(pos, home, `#${id} arrived exactly at its target`);
    }
  }
});

test('the hat panda gets his solo beat, and starts watching on arrival', () => {
  const engine = makeEngine(CFG);
  let state = engine.init(8);
  const hat = state.entities.find((e) => e.hasHat);
  assert.equal(hat.aTimer, 0, 'he leaves immediately');
  assert.ok(
    state.entities.filter((e) => !e.hasHat).every((e) => e.aTimer >= engine.cfg.entranceLead),
    'everyone else waits out his head start',
  );

  // He is on stage and watching well before the troupe has finished arriving.
  let arrivedAlone = false;
  for (let i = 0; i < 4000; i++) {
    state = engine.step(state);
    const h = state.entities.find((e) => e.hasHat);
    if (!h.entering) {
      assert.equal(h.mode, MODE.OBSERVING, 'he settles straight into watching');
      arrivedAlone = state.entities.some((e) => e.entering);
      break;
    }
  }
  assert.ok(arrivedAlone, 'he is in place while the rest are still walking on');
});

test('nobody collides on the way in — an entering panda is a ghost', () => {
  const engine = makeEngine({ ...CFG, pandaCount: 14 });
  let state = engine.init(77);
  for (let i = 0; i < 600 && state.entities.some((e) => e.entering); i++) {
    state = engine.step(state);
    const entering = new Set(state.entities.filter((e) => e.entering).map((e) => e.id));
    for (const { id } of detectCollisions(state.entities, engine.cfg)) {
      assert.ok(!entering.has(id), `#${id} collided while walking in`);
    }
  }
});

test('no anomaly, tower or cascade fires at a panda still walking on', () => {
  const engine = makeEngine({ ...CFG, anomKick: 1, anomGapMin: 1, anomGapMax: 2, stackKick: 1 });
  let state = engine.init(404);
  for (let i = 0; i < 900; i++) {
    state = engine.step(state);
    for (const e of state.entities) {
      if (!e.entering) continue;
      assert.equal(e.mode, MODE.ENTERING, `#${e.id} was recruited mid-entrance`);
    }
  }
});

test('the entrance is config, so a corpus can open mid-scene instead', () => {
  const engine = makeEngine({ ...CFG, entrance: false });
  const state = engine.init(31);
  assert.ok(state.entities.every((e) => !e.entering));
  assert.ok(state.entities.every((e) => inBounds(engine.cfg, e.lx, e.ly)));
  assert.equal(state.entities.find((e) => e.hasHat).mode, MODE.OBSERVING);
});

test('the walk-in is deterministic and pure, like everything else', () => {
  const engine = makeEngine(CFG);
  const a = settle(engine, engine.init(12));
  const b = settle(engine, engine.init(12));
  assert.equal(a.ticks, b.ticks);
  assert.deepEqual(engine.encode(a.state), engine.encode(b.state));

  // …and the tick that starts it does not mutate the state it was handed.
  const s0 = engine.init(12);
  const before = engine.encode(s0).join(',');
  engine.step(s0);
  assert.equal(engine.encode(s0).join(','), before);
});
