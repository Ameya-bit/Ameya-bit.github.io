import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scanEpisode, recordEpisode, truthAt, globalTruth, entityTruth,
  GLOBAL_FIELDS, ENTITY_FIELDS, TRUTH_LABELS, TRUTH_VERSION,
} from '../truth.js';
import { runEpisode, hatOf } from '../rollout.js';
import { configFactory, episodeSeeds } from '../corpus.js';
import { makeObserver } from '../../assets/pandas/engine/policy/obs.js';
import { MODE, MODE_NAME } from '../../assets/pandas/engine/state.js';
import { isValidAction } from '../../assets/pandas/engine/actions.js';

// A world busy enough that every machine fires inside a short episode: a tower by
// ~15 s, a cascade armed early, anomalies on a quick cadence.
const BUSY = {
  width: 1200,
  height: 640,
  forbid: { l: 420, t: 120, r: 800, b: 400 },
  pandaCount: 12,
  entrance: true,
  anomKick: 60,
  anomGapMin: 60,
  anomGapMax: 140,
  stackKick: 300,
  cascadeKick: 400,
  cascadeArmMin: 600,
  cascadeArmMax: 900,
};

function record(opts = {}) {
  const rows = [];
  const observer = makeObserver();
  const summary = recordEpisode({
    seed: 20260727,
    config: BUSY,
    ticks: 4000,
    observer,
    onRow: (row) => rows.push({ ...row, obs: row.obs.slice() }),
    ...opts,
  });
  return { rows, summary, observer };
}

test('the record schema is the record — the manifest cannot drift from the data', () => {
  const { rows } = record({ ticks: 400 });
  assert.deepEqual(Object.keys(rows[0].truth.global), [...GLOBAL_FIELDS]);
  assert.deepEqual(Object.keys(rows[0].truth.entities[0]), [...ENTITY_FIELDS]);
  assert.equal(TRUTH_VERSION, 1);
  assert.equal(TRUTH_LABELS.mode.length, MODE_NAME.length);
  assert.equal(TRUTH_LABELS.anomalyKind.length, 8);
  // Every value is a plain number: shard-writable, and no booleans to guess at.
  for (const rec of [rows[0].truth.global, ...rows[0].truth.entities]) {
    for (const [k, v] of Object.entries(rec)) {
      assert.equal(typeof v, 'number', `${k} is ${typeof v}`);
      assert.ok(Number.isFinite(v), `${k} is ${v}`);
    }
  }
});

test('truth is aligned to the observation it was taken with', () => {
  const { rows, observer } = record({ ticks: 1200 });
  for (const row of rows) {
    assert.equal(row.truth.global.tick, row.tick);
    assert.ok(isValidAction(row.action));
    assert.equal(row.truth.slots.length, observer.layout.slots);
    for (const slot of row.truth.slots) {
      if (slot.id < 0) {
        assert.equal(slot.visible, 0);
        assert.equal(slot.heldFor, -1);
        continue;
      }
      // A slot names a real panda, and the truth for it is one lookup away.
      const subject = row.truth.entities.find((e) => e.id === slot.id);
      assert.ok(subject, `slot ${slot.slot} names panda ${slot.id}, which is not in the roster`);
      assert.ok(slot.heldFor >= 0);
      // Visible this frame means it was seen this tick, so the hold age is 0.
      if (slot.visible === 1) assert.equal(slot.heldFor, 0);
    }
  }
  // The join is worth something only if slots are actually occupied.
  assert.ok(rows.some((r) => r.truth.slots.some((s) => s.visible === 1)));
  assert.ok(rows.some((r) => r.truth.slots.some((s) => s.id >= 0 && s.visible === 0)));
});

test('ttl counts down to the tick the behaviour actually ends', () => {
  const { rows } = record();
  const byTick = new Map(rows.map((r) => [r.tick, r]));
  let checked = 0;

  for (const row of rows) {
    for (const e of row.truth.entities) {
      if (e.ttl <= 0 || e.mode === MODE.WANDER) continue;
      const then = byTick.get(row.tick + e.ttl);
      if (!then) continue; // the end falls outside the recorded window
      const same = then.truth.entities.find((q) => q.id === e.id);
      // At exactly ttl ticks later the panda is doing something else, and that
      // something is what nextMode promised.
      assert.notEqual(same.mode, e.mode,
        `panda ${e.id} still ${MODE_NAME[e.mode]} at ttl 0 (tick ${then.tick})`);
      assert.equal(same.mode, e.nextMode);
      checked += 1;
    }
  }
  assert.ok(checked > 200, `only ${checked} resolvable ttls — the episode is too quiet to test`);
});

test('age counts up from the tick the behaviour began', () => {
  const { rows } = record();
  const byTick = new Map(rows.map((r) => [r.tick, r]));
  let checked = 0;
  for (const row of rows) {
    for (const e of row.truth.entities) {
      if (e.age < 4) continue;
      // `tick - age` is where this behaviour began: same mode, age zero. (Half of
      // those ticks are odd and so were never sampled — skip, plenty remain.)
      const start = byTick.get(row.tick - e.age);
      if (!start) continue;
      const was = start.truth.entities.find((q) => q.id === e.id);
      assert.equal(was.mode, e.mode, `panda ${e.id} changed mode inside its own span`);
      assert.equal(was.age, 0, `panda ${e.id} age ${e.age} does not point at its span start`);
      checked += 1;
    }
  }
  assert.ok(checked > 200);
});

test('a nap is labelled all the way through, fall to stand-up', () => {
  // The flagship pairing needs this: the observation cannot tell a sleeper from a
  // knock, so the label had better cover the whole nap and not just its middle.
  const { rows } = record();
  const naps = new Map(); // id -> the ticks it was labelled SLEEPER
  for (const row of rows) {
    for (const e of row.truth.entities) {
      if (e.mode !== MODE.SLEEPER) continue;
      if (!naps.has(e.id)) naps.set(e.id, []);
      naps.get(e.id).push(e);
    }
  }
  assert.ok(naps.size > 0, 'nobody napped');
  for (const samples of naps.values()) {
    const ages = samples.map((s) => s.age);
    assert.ok(Math.min(...ages) <= 2, 'the nap label starts late');
    // ttl and age move in opposite directions across the span, by construction.
    for (const s of samples) {
      if (s.ttl >= 0) assert.ok(s.age + s.ttl > 0);
    }
  }
});

test('the cascade is recorded as arming, igniting, and sweeping', () => {
  const { rows } = record({ ticks: 8000 });
  const armed = rows.filter((r) => r.truth.global.cascadeArmed === 1);
  const active = rows.filter((r) => r.truth.global.cascadeActive === 1);
  assert.ok(armed.length > 0, 'never armed');
  assert.ok(active.length > 0, 'never ignited');
  assert.ok(active.some((r) => r.truth.global.cascadeClaims > 0), 'no claims recorded');
  assert.ok(active.some((r) => r.truth.entities.some((e) => e.claimed === 1)),
    'no panda ever carried a cascade claim');

  // The negative control: the countdown to ignition is real (it hits 0 exactly when
  // the sweep starts) and it is the one label with no observable signature at all.
  const countdown = rows.filter((r) => r.truth.global.cascadeIgnitesIn === 0);
  assert.ok(countdown.length > 0);
  for (const r of countdown) assert.equal(r.truth.global.cascadeActive, 1);
});

test('the stack machine is recorded through assembly and parade', () => {
  const { rows } = record({ ticks: 8000 });
  const towers = rows.filter((r) => r.truth.global.stackBase >= 0);
  assert.ok(towers.length > 0, 'no tower ever formed');
  assert.ok(towers.some((r) => r.truth.global.stackRiders > 0));
  assert.ok(towers.some((r) => r.truth.entities.some((e) => e.riding === 1 && e.stackLevel > 0)));
  // No tower alive means the clock to the next one is running, and never both.
  for (const r of rows) {
    const g = r.truth.global;
    assert.ok((g.stackBase >= 0) === (g.stackFormsIn === -1));
  }
});

test('the expert’s attention is recorded as a label', () => {
  const { rows } = record({ ticks: 4000 });
  assert.ok(rows.some((r) => r.truth.global.expertSubject >= 0));
  assert.ok(rows.some((r) => r.truth.global.expertIncident >= 0), 'the expert never held an incident');
  assert.ok(rows.some((r) => r.truth.global.expertRelocating === 1));
  assert.ok(rows.some((r) => r.truth.global.topTier > 1), 'no tier-2/3 incident was ever top');
});

test('recording is deterministic, and the two passes agree', () => {
  const a = record({ ticks: 1500 });
  const b = record({ ticks: 1500 });
  assert.deepEqual(a.rows.map((r) => r.truth), b.rows.map((r) => r.truth));
  assert.deepEqual(a.rows.map((r) => [...r.obs]), b.rows.map((r) => [...r.obs]));
});

test('a timeline from a different episode is refused, not silently believed', () => {
  const timeline = scanEpisode({ seed: 1, config: BUSY, ticks: 3000 });
  assert.throws(() => {
    runEpisode({
      seed: 2, // a different world entirely
      config: BUSY,
      ticks: 3000,
      sink: { sample: (state) => truthAt(state, timeline) },
    });
  }, /timeline says panda/);
});

test('the warmup is covered by the timeline, so ages survive it', () => {
  const rows = [];
  recordEpisode({
    seed: 99,
    config: BUSY,
    ticks: 600,
    warmup: 2000,
    observer: makeObserver(),
    onRow: (row) => rows.push({ tick: row.tick, truth: row.truth }),
  });
  assert.equal(rows[0].truth.global.tick, 2002);
  // Something in the first recorded frame must have begun before recording did —
  // otherwise the timeline is being rebuilt from the window rather than the episode.
  assert.ok(rows[0].truth.entities.some((e) => e.age > 100));
});

test('truth works without an observer — the slot join is optional', () => {
  const timeline = scanEpisode({ seed: 5, config: BUSY, ticks: 400 });
  runEpisode({
    seed: 5,
    config: BUSY,
    ticks: 400,
    sink: {
      sample(state) {
        const t = truthAt(state, timeline);
        assert.deepEqual(t.slots, []);
        assert.equal(t.global.tick, state.tick);
        assert.equal(t.entities.length, state.entities.length);
        assert.deepEqual(
          globalTruth(state, timeline),
          t.global,
        );
        assert.deepEqual(entityTruth(state, hatOf(state), timeline),
          t.entities.find((e) => e.id === hatOf(state).id));
      },
    },
  });
});

test('every corpus spec records cleanly end to end', () => {
  for (const name of ['natural', 'dense', 'wild']) {
    const configFor = configFactory(name, 606);
    const seed = episodeSeeds(606, 1)[0];
    let rows = 0;
    let modes = new Set();
    recordEpisode({
      seed,
      config: configFor(seed, 0),
      ticks: 3000,
      observer: makeObserver(),
      onRow: (row) => {
        rows += 1;
        for (const e of row.truth.entities) modes.add(e.mode);
      },
    });
    assert.equal(rows, 1500);
    assert.ok(modes.size > 3, `${name}: only ${modes.size} distinct modes seen`);
  }
});
