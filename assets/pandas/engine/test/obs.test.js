import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeEngine } from '../engine.js';
import { MODE, ANIM, KNOCK } from '../state.js';
import { DIR_COUNT } from '../dirs.js';
import {
  makeObserver, obsLayout, observerOf, OBS_WIDTH, OBS_FIELDS, OBS_VERSION, DEFAULT_OBS,
} from '../policy/obs.js';

// ---- a hand-placed world ----
//
// The FOV and the slot table are geometry, so the tests put bodies exactly where
// they need them rather than fishing for a seed that happens to arrange the field.
// The state is a real engine state (never stepped), so nothing here can drift from
// the entity shape the sim actually produces.

const STAGE = { width: 1400, height: 800, forbid: null, entrance: false };

function world({ pandas = 4, ...cfg } = {}) {
  const engine = makeEngine({ ...STAGE, ...cfg, pandaCount: pandas });
  const state = engine.init(7);
  // Park everyone far off in a corner; each test then places the ones it cares
  // about. The hat starts centred, facing up (dir 0).
  for (const e of state.entities) place(e, 20, 20);
  place(observerOf(state), 700, 400, { dir: 0, anim: ANIM.IDLE });
  return state;
}

function place(e, x, y, opts = {}) {
  e.x = x;
  e.y = y;
  e.lx = x;
  e.ly = y;
  e.g0x = x;
  e.g0y = y;
  e.gtx = x;
  e.gty = y;
  e.dir = opts.dir ?? 0;
  e.anim = opts.anim ?? ANIM.WALK;
  e.mode = opts.mode ?? MODE.WANDER;
  return e;
}

// The roamers, in id order — index 0 is always the hat panda.
const roamers = (state) => state.entities.filter((e) => !e.hasHat);

// One neighbour token as a plain object, by slot index.
function token(frame, slot) {
  const base = (1 + slot) * OBS_WIDTH;
  const at = (name) => OBS_FIELDS.find((f) => f.name === name).at;
  const one = (name, size) => {
    for (let i = 0; i < size; i++) if (frame[base + at(name) + i] === 1) return i;
    return -1;
  };
  return {
    present: frame[base + at('present')],
    visible: frame[base + at('visible')],
    relX: frame[base + at('relX')],
    relY: frame[base + at('relY')],
    dist: frame[base + at('dist')],
    lift: frame[base + at('lift')],
    facing: one('facing', DIR_COUNT),
    pose: one('pose', 7),
  };
}

const visibleSlots = (frame, slots = DEFAULT_OBS.slots) =>
  [...Array(slots).keys()].filter((s) => token(frame, s).visible === 1);

// ---- layout ----

test('the field table tiles the token width exactly once', () => {
  const covered = new Array(OBS_WIDTH).fill(0);
  for (const f of OBS_FIELDS) {
    for (let i = 0; i < f.size; i++) covered[f.at + i] += 1;
  }
  assert.deepEqual(covered, new Array(OBS_WIDTH).fill(1), 'fields overlap or leave a gap');
});

test('the layout describes the frame the encoder actually writes', () => {
  const obs = makeObserver();
  const frame = obs.observe(world(), obs.init());
  assert.equal(frame.length, obs.layout.length);
  assert.equal(obs.layout.length, (1 + DEFAULT_OBS.slots) * OBS_WIDTH);
  assert.equal(obs.layout.version, OBS_VERSION);
  assert.deepEqual(obs.describe().params, { ...DEFAULT_OBS });
  assert.equal(obsLayout(3).length, 4 * OBS_WIDTH);
});

test('a typo in an observation parameter throws instead of quietly defaulting', () => {
  assert.throws(() => makeObserver({ sightRadius: 900 }), /unknown observation parameter/);
  const obs = makeObserver({ slots: 4 });
  assert.throws(() => obs.observe(world(), makeObserver().init()), /must have 4 slots/);
});

// ---- the self token ----

test('the self token carries proprioception and nothing about anyone else', () => {
  const state = world({ forbid: { l: 300, t: 200, r: 500, b: 400 } });
  const self = observerOf(state);
  place(self, 700, 400, { dir: 2, anim: ANIM.WALK });
  self.rollReadyAt = state.tick + state.cfg.rollCooldownTicks; // just rolled

  const obs = makeObserver();
  const f = obs.observe(state, obs.init());
  const at = (name) => OBS_FIELDS.find((x) => x.name === name).at;
  assert.equal(f[at('self')], 1);
  assert.equal(f[at('present')], 1);
  assert.equal(f[at('visible')], 1);
  assert.equal(f[at('facing') + 2], 1);
  assert.equal(f[at('pose') + ANIM.WALK], 1);
  assert.equal(f[at('hatOn')], 1);
  assert.equal(f[at('rollCooldown')], 1);
  assert.equal(f[at('fencePresent')], 1);
  // He is right of and below the card, so its edges read negative on both axes.
  assert.ok(f[at('fenceOffset') + 0] < 0 && f[at('fenceOffset') + 1] < 0);
  assert.ok(f[at('fenceOffset') + 2] < 0 && f[at('fenceOffset') + 3] < 0);
  // Walls: both side walls are further off than he can see, so they saturate;
  // the floor and ceiling of this stage are inside sight and read as fractions.
  assert.equal(f[at('edgeClear') + 0], 1);
  assert.equal(f[at('edgeClear') + 1], 1);
  assert.ok(f[at('edgeClear') + 2] < 1 && f[at('edgeClear') + 3] < 1);
  assert.ok(f[at('edgeClear') + 2] > f[at('edgeClear') + 3], 'he is below the middle');

  const noFence = makeObserver().observe(world(), obs.init());
  assert.equal(noFence[at('fencePresent')], 0);
  for (let i = 0; i < 4; i++) assert.equal(noFence[at('fenceOffset') + i], 0);
});

test('the roll cooldown counts down to ready', () => {
  const state = world();
  const obs = makeObserver();
  const cd = () => obs.observe(state, obs.init())[OBS_FIELDS.find((f) => f.name === 'rollCooldown').at];
  observerOf(state).rollReadyAt = state.tick + state.cfg.rollCooldownTicks / 2;
  assert.equal(cd(), 0.5);
  observerOf(state).rollReadyAt = state.tick;
  assert.equal(cd(), 0);
});

// ---- the field of view ----

test('he sees down his heading cone, not behind him', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();

  place(q, 700, 200); // 200 px straight ahead of a hat facing up
  assert.deepEqual(visibleSlots(obs.observe(state, obs.init())), [0]);

  place(q, 700, 600); // …the same distance straight behind
  assert.deepEqual(visibleSlots(obs.observe(state, obs.init())), []);
});

test('the peripheral stub catches what is on top of him, whatever way he faces', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();
  place(q, 700, 400 + DEFAULT_OBS.peripheralR - 10); // behind, but inside the stub
  assert.deepEqual(visibleSlots(obs.observe(state, obs.init())), [0]);
  place(q, 700, 400 + DEFAULT_OBS.peripheralR + 10); // …and just outside it
  assert.deepEqual(visibleSlots(obs.observe(state, obs.init())), []);
});

test('sight has a range, cone or not', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();
  place(q, 700, 400 - DEFAULT_OBS.sightRange + 10);
  assert.deepEqual(visibleSlots(obs.observe(state, obs.init())), [0]);
  place(q, 700, 400 - DEFAULT_OBS.sightRange - 10);
  assert.deepEqual(visibleSlots(obs.observe(state, obs.init())), []);
});

test('the hero card is opaque — and that is a knob, not a law', () => {
  const state = world({ forbid: { l: 600, t: 150, r: 900, b: 300 } });
  const [q] = roamers(state);
  place(q, 700, 60); // directly ahead, but the card is between them

  assert.deepEqual(visibleSlots(makeObserver().observe(state, makeObserver().init())), []);
  const through = makeObserver({ occludeFence: false });
  assert.deepEqual(visibleSlots(through.observe(state, through.init())), [0]);
});

test('a visible neighbour is encoded as the drawn body, egocentrically', () => {
  const state = world();
  const [q] = roamers(state);
  place(q, 700 + 130, 400 - 130, { dir: 5, anim: ANIM.FALLEN });
  const obs = makeObserver();
  const t = token(obs.observe(state, obs.init()), 0);
  assert.equal(t.visible, 1);
  assert.ok(Math.abs(t.relX - 130 / DEFAULT_OBS.sightRange) < 1e-6);
  assert.ok(Math.abs(t.relY + 130 / DEFAULT_OBS.sightRange) < 1e-6);
  assert.ok(t.dist > 0 && t.dist < 1);
  assert.equal(t.facing, 5);
  assert.equal(t.pose, ANIM.FALLEN);
});

// ---- slot identity ----

test('a slot keeps its panda while it is in view, and holds it briefly after', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();
  const mem = obs.init();

  place(q, 700, 200);
  obs.observe(state, mem);
  assert.equal(mem.id[0], q.id);

  // Out of view: the binding survives, the observation does not.
  place(q, 700, 600);
  state.tick += 1;
  let t = token(obs.observe(state, mem), 0);
  assert.equal(t.present, 1);
  assert.equal(t.visible, 0);
  assert.equal(t.relX, 0, 'an unseen panda must not leave a stale position behind');
  assert.equal(t.relY, 0);
  assert.equal(t.facing, -1);
  assert.equal(t.pose, -1);

  // …and re-binds to the SAME slot when he looks back in time.
  place(q, 700, 190);
  state.tick += 1;
  assert.equal(token(obs.observe(state, mem), 0).visible, 1);
  assert.equal(mem.id[0], q.id);

  // Gone longer than the hold window: the slot is released.
  place(q, 700, 600);
  state.tick += DEFAULT_OBS.holdTicks + 2;
  t = token(obs.observe(state, mem), 0);
  assert.equal(t.present, 0);
  assert.equal(mem.id[0], -1);
});

test('slots are stable across frames — the same panda keeps the same address', () => {
  const state = world({ pandas: 5 });
  const obs = makeObserver({ slots: 4 });
  const mem = obs.init();
  const qs = roamers(state);
  qs.forEach((q, i) => place(q, 600 + i * 40, 300 - i * 30));

  obs.observe(state, mem);
  const first = [...mem.id];
  assert.ok(first.every((id) => id >= 0), 'four visible pandas should fill four slots');
  for (let t = 0; t < 20; t++) {
    // Everyone shuffles about; nobody leaves the cone.
    qs.forEach((q, i) => place(q, 600 + i * 40 + (t % 3) * 7, 300 - i * 30 - (t % 5) * 5));
    state.tick += 1;
    obs.observe(state, mem);
  }
  assert.deepEqual([...mem.id], first, 'slot addresses drifted while everyone stayed in view');
});

test('a nearer stranger only takes a slot if it clearly beats the incumbent', () => {
  const state = world({ pandas: 3 });
  const obs = makeObserver({ slots: 1 });
  const mem = obs.init();
  const [a, b] = roamers(state);

  place(a, 700, 200); // 200 px ahead — takes the only slot
  place(b, 20, 20); // far away, out of view
  obs.observe(state, mem);
  assert.equal(mem.id[0], a.id);

  // A hair nearer is not enough: inside the hysteresis band, the slot holds.
  place(b, 700, 200 + DEFAULT_OBS.hysteresisPx - 10);
  state.tick += 1;
  obs.observe(state, mem);
  assert.equal(mem.id[0], a.id);

  // Clearly nearer, and it takes the slot.
  place(b, 700, 380);
  state.tick += 1;
  obs.observe(state, mem);
  assert.equal(mem.id[0], b.id);
});

test('slot assignment is nearest-first and reproducible', () => {
  const state = world({ pandas: 5 });
  const obs = makeObserver({ slots: 2 });
  const qs = roamers(state);
  place(qs[0], 700, 100); // 300 away
  place(qs[1], 700, 300); // 100 away — nearest
  place(qs[2], 700, 200); // 200 away
  place(qs[3], 700, 150); // 250 away

  const mem = obs.init();
  obs.observe(state, mem);
  assert.deepEqual([...mem.id], [qs[1].id, qs[2].id]);

  const again = obs.init();
  obs.observe(state, again);
  assert.deepEqual([...again.id], [...mem.id]);
});

// ---- what must NOT be visible ----

// The operational rule: of another panda, the encoder may read exactly what
// render/renderer.js reads — which is the definition of "what a bystander can see".
// `rollReadyAt` is the one addition, and it is his own legs.
const RENDERER_READS = new Set([
  'id', 'hasHat', 'x', 'y', 'dir', 'anim', 'mode', 'flying', 'stackLevel',
  'aPhase', 'aTimer', // via hiccupLift — the drawn height of a hiccup pop
  'rollReadyAt', // self only: proprioception, not vision
]);

test('the encoder reads no more of a panda than the renderer draws', () => {
  const state = world({ pandas: 6 });
  roamers(state).forEach((q, i) => place(q, 620 + i * 30, 260 + i * 20, { dir: i % 8 }));
  const read = new Set();
  const spy = {
    ...state,
    entities: state.entities.map((e) => new Proxy(e, {
      get(target, key) {
        if (typeof key === 'string') read.add(key);
        return target[key];
      },
    })),
  };
  const obs = makeObserver();
  obs.observe(spy, obs.init());

  assert.ok(read.size > 5, 'the spy recorded nothing — the test is not exercising the encoder');
  const leaked = [...read].filter((k) => !RENDERER_READS.has(k));
  assert.deepEqual(leaked, [], `the observation reads privileged state: ${leaked.join(', ')}`);
  // Named explicitly, because these are the ones that would silently hand over the
  // answer: the anomaly clocks, the identity of the oblivious one, and the rules
  // watcher's brain — the very thing the network is being asked to replace.
  for (const k of ['aCount', 'aLie', 'aStep', 'oblivious', 'home', 'moveSpeed',
    'subject', 'incSubject', 'incBorn', 'td', 'relocating', 'knockPhase', 'knockTimer']) {
    assert.ok(!read.has(k), `read privileged field ${k}`);
  }
});

test('the flagship: a sleeper and a freshly-knocked panda encode identically', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();

  // A nap: lying down deliberately, mid-anomaly.
  place(q, 700, 250, { mode: MODE.SLEEPER, anim: ANIM.FALLEN });
  q.aPhase = 11;
  q.aTimer = 300;
  q.aLie = 300;
  const asleep = obs.observe(state, obs.init()).slice();

  // Floored a moment ago by a collision: the same cels, in the same place.
  place(q, 700, 250, { mode: MODE.KNOCKED, anim: ANIM.FALLEN });
  q.aPhase = 0;
  q.aTimer = 0;
  q.knockPhase = KNOCK.LIE;
  q.knockTimer = 60;
  const floored = obs.observe(state, obs.init()).slice();

  assert.deepEqual([...floored], [...asleep],
    'the sensor tells nap from knock — the memory task the whole project rests on is gone');
});

test('no anomaly kind is legible from a single frame', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();
  const kinds = [MODE.SLEEPER, MODE.TUMBLER, MODE.SPINNER, MODE.LOOP,
    MODE.STARER, MODE.ZOOMIES, MODE.MOONWALK, MODE.HICCUP, MODE.WANDER];
  const frames = kinds.map((mode) => {
    place(q, 700, 250, { mode, anim: ANIM.WALK, dir: 3 });
    q.aPhase = 0; // no hiccup mid-pop: that one IS drawn, see below
    q.aTimer = 0;
    return [...obs.observe(state, obs.init())];
  });
  for (const f of frames) assert.deepEqual(f, frames[0]);
});

test('…but a hiccup pop is genuinely in the air, and shows', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();
  place(q, 700, 250, { mode: MODE.HICCUP, anim: ANIM.WALK });
  q.aPhase = 6; // H_POP
  q.aTimer = state.cfg.hiccupHopTicks / 2; // mid-arc, at the peak
  const t = token(obs.observe(state, obs.init()), 0);
  assert.ok(t.lift > 0.9 && t.lift <= 1, `lift ${t.lift}`);
});

// ---- freezing ----

test('every value is float32-exact, finite, and in band', () => {
  const engine = makeEngine({ width: 1300, height: 700, pandaCount: 12, entrance: true });
  const obs = makeObserver();
  const mem = obs.init();
  let state = engine.init(20260727);
  for (let t = 0; t < 4000; t++) {
    state = engine.step(state);
    if (t % 2) continue; // the policy clock
    const f = obs.observe(state, mem);
    for (let i = 0; i < f.length; i++) {
      assert.ok(Number.isFinite(f[i]), `non-finite at ${i} on tick ${t}`);
      assert.ok(f[i] >= -1 && f[i] <= 1, `out of band at ${i}: ${f[i]}`);
      assert.equal(f[i], Math.fround(f[i]));
    }
  }
});

test('the same episode encodes to the same bytes twice', () => {
  const run = () => {
    const engine = makeEngine({ width: 1100, height: 600, pandaCount: 9 });
    const obs = makeObserver();
    const mem = obs.init();
    let state = engine.init(4242);
    const bytes = [];
    for (let t = 0; t < 1200; t++) {
      state = engine.step(state);
      if (t % 2 === 0) bytes.push(...obs.observe(state, mem));
    }
    return bytes;
  };
  assert.deepEqual(run(), run());
});

// ---- the cross-language fixture ----

const engineDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('the fixture still matches the encoder', () => {
  // Fails loudly on any change to the layout, the FOV or the slot rules — those
  // invalidate a cut corpus, so they must be re-baked deliberately:
  // `node tools/obs-fixture.js`.
  execFileSync(process.execPath, [join(engineDir, 'tools', 'obs-fixture.js'), '--check']);
});

test('the fixture carries everything a foreign encoder needs — and no simulator', () => {
  const fixture = JSON.parse(readFileSync(join(engineDir, 'policy', 'obs-fixture.json'), 'utf8'));
  const obs = makeObserver(fixture.params);
  assert.ok(fixture.cases.length >= 4);

  for (const c of fixture.cases) {
    // Rebuilt from the JSON alone: a partial cfg, plain entity records, one stack
    // id. If the encoder ever needed more than the fixture records, this throws or
    // diverges — which is exactly the failure a Python port would hit.
    const state = { tick: c.tick, cfg: c.cfg, entities: c.entities, stack: { baseId: c.stackBaseId } };
    const mem = { id: [...c.memIn.id], seen: [...c.memIn.seen], dist: [...c.memIn.dist] };
    assert.deepEqual([...obs.observe(state, mem)], c.obs, `case ${c.case}: frame`);
    assert.deepEqual(mem, c.memOut, `case ${c.case}: slot memory`);
  }
});

test('the returned frame is a reused buffer — copy it if you keep it', () => {
  const state = world();
  const [q] = roamers(state);
  const obs = makeObserver();
  const mem = obs.init();
  place(q, 700, 200);
  const first = obs.observe(state, mem);
  const kept = first.slice();
  place(q, 700, 600);
  state.tick += 1;
  const second = obs.observe(state, mem);
  assert.equal(second, first, 'the buffer should be the same object');
  assert.notDeepEqual([...second], [...kept]);

  // …unless the caller supplies its own, which a shard writer will.
  const own = new Float32Array(obs.layout.length);
  assert.equal(obs.observe(state, mem, own), own);
  assert.deepEqual([...own], [...second]);
});
