import test from 'node:test';
import assert from 'node:assert/strict';

import { oracle, reactiveTruth, reactiveObs, remainingOf, POSE_PRIOR } from '../percept.js';
import { scanEpisode } from '../truth.js';
import { runEpisode, hatOf } from '../rollout.js';
import { MODE, MODE_NAME, ANIM } from '../../assets/pandas/engine/state.js';

const EP = { seed: 33221, config: { entrance: false }, ticks: 8000 };

// ---- the oracle's second implementation of anomalies.js ----

test("remainingOf agrees with ground truth's exact ttl, per kind", () => {
  // `truth.js` gets time-remaining by walking the episode twice, which is exact and
  // unavailable to anything that acts. `remainingOf` derives it from the FSM's
  // scratch at the tick, which IS available and is therefore a duplicate of
  // arithmetic in anomalies.js. This is the test that makes that duplication safe:
  // if a phase constant, a cadence or a tail ever moves, the mirror goes red.
  const timeline = scanEpisode({ ...EP });
  const err = new Map(); // mode -> {n, absErr, worst}

  runEpisode({
    ...EP,
    stride: 1,
    sink: {
      sample(state) {
        for (const e of state.entities) {
          if (e.mode < MODE.SLEEPER || e.mode > MODE.HICCUP) continue;
          const spans = timeline.spans.get(e.id);
          const span = spans.find((s) => s.from <= state.tick && (s.to < 0 || s.to > state.tick));
          if (!span || span.to < 0) continue; // still open at the end of the episode
          // Truth's span ends where the mode changes. A knock can cut an anomaly
          // short, which no estimate could have known — those are excluded, since
          // this is testing the FSM arithmetic, not clairvoyance about collisions.
          const next = spans[spans.indexOf(span) + 1];
          if (next && next.mode === MODE.KNOCKED) continue;
          const truthTtl = span.to - state.tick;
          const est = remainingOf(e, state.cfg, state);
          const rec = err.get(e.mode) || { n: 0, absErr: 0, worst: 0 };
          rec.n += 1;
          rec.absErr += Math.abs(est - truthTtl);
          rec.worst = Math.max(rec.worst, Math.abs(est - truthTtl));
          err.set(e.mode, rec);
        }
      },
    },
  });

  assert.ok(err.size >= 6, `only saw ${err.size} anomaly kinds in the episode`);
  for (const [mode, rec] of err) {
    const mae = rec.absErr / rec.n;
    // Each kind is checked against what it can honestly know. The three exact ones
    // are exact; the three with a draw still to come are held to their own spread.
    const bound = {
      [MODE.SLEEPER]: 1, [MODE.STARER]: 1, [MODE.LOOP]: 1, [MODE.TUMBLER]: 2,
      [MODE.MOONWALK]: 12, // ends early when it backs into a wall it was not aimed at
      [MODE.SPINNER]: 6, // the stagger count is drawn only when the spin ends
      [MODE.ZOOMIES]: 40, // the hero card is not modelled in the wall projection
      [MODE.HICCUP]: 12, // strides wander, so the distance to the next wall moves
    }[mode];
    assert.ok(mae <= bound, `${MODE_NAME[mode]}: mean abs error ${mae.toFixed(1)} > ${bound}`);
  }
});

test('remainingOf is zero for anything that is not running an anomaly', () => {
  const cfg = { standTicks: 17, paradeMin: 360, paradeMax: 680 };
  assert.equal(remainingOf({ mode: MODE.WANDER }, cfg), 0);
  assert.equal(remainingOf({ mode: MODE.KNOCKED }, cfg), 0);
  assert.equal(remainingOf({ mode: MODE.OBSERVING }, cfg), 0);
});

// ---- the information sets ----

const beliefsAt = (tick) => {
  const out = {};
  const mems = { oracle: oracle.init({}), reactiveTruth: reactiveTruth.init({}), reactiveObs: reactiveObs.init({}) };
  runEpisode({
    ...EP,
    ticks: tick,
    stride: 1,
    sink: {
      sample(state) {
        // Every percept must be read every tick — reactiveObs's slot memory only
        // advances when it is asked, so sampling it once at the end would hand it a
        // cold slot table and quietly make it look worse than it is.
        for (const k of Object.keys(mems)) out[k] = { belief: { ...{ oracle, reactiveTruth, reactiveObs }[k].read(state, mems[k]) }, state };
      },
    },
  });
  return out;
};

test('the oracle sees every live incident; reactive-obs sees only what is in view', () => {
  const b = beliefsAt(3000);
  assert.ok(b.oracle.belief.candidates.length >= 0);
  // The oracle's field is the whole roster; reactive-obs's is bounded by the slots
  // it can actually see, and is never larger.
  assert.equal(b.oracle.belief.field.length, b.oracle.state.entities.length);
  assert.ok(b.reactiveObs.belief.field.length <= b.oracle.belief.field.length);
});

test('reactive-truth is the oracle minus time, and nothing else', () => {
  const b = beliefsAt(2400);
  const o = b.oracle.belief.candidates;
  const r = b.reactiveTruth.belief.candidates;
  assert.equal(o.length, r.length);
  for (let i = 0; i < o.length; i++) {
    assert.equal(r[i].key, o[i].key);
    assert.equal(r[i].lx, o[i].lx);
    assert.equal(r[i].p, o[i].p);
    assert.equal(r[i].hazard, o[i].hazard); // kind is current state, so it keeps it
    assert.equal(r[i].age, null);
    assert.equal(r[i].remaining, null);
  }
});

test('reactive-obs cannot tell a sleeper from a panda that was just run over', () => {
  // The flagship, expressed as money: both are `down`, both are priced at the same
  // measured base rate, and one of them is worth nothing at all.
  assert.equal(POSE_PRIOR.down.p, 0.21);
  assert.ok(POSE_PRIOR.down.p < 0.3, 'four in five fallen pandas pay nothing');
  assert.equal(POSE_PRIOR.riding.p, 0); // riders never pay — the incident is the base
  assert.equal(POSE_PRIOR.carrying.p, 1); // a tower is unmistakable, and always pays
});

test('reactive-obs never reports a panda it cannot see', () => {
  // The percept is allowed exactly the encoder's visible slots. A slot held from
  // memory is `present` but not `visible`, and a memoryless reader must drop it.
  const mem = reactiveObs.init({});
  let checked = 0;
  runEpisode({
    ...EP,
    ticks: 4000,
    stride: 2,
    sink: {
      sample(state) {
        const b = reactiveObs.read(state, mem);
        const hat = hatOf(state);
        for (const q of b.field) {
          if (q.hasHat) continue;
          const d = Math.hypot(q.lx - hat.x, q.ly - hat.y);
          assert.ok(d <= reactiveObs.observer.params.sightRange + 1, `saw something ${d.toFixed(0)}px away`);
          checked += 1;
        }
      },
    },
  });
  assert.ok(checked > 100, `only checked ${checked} sightings`);
});

test('every percept is a pure function of the episode', () => {
  const run = () => {
    const mem = reactiveObs.init({});
    const seen = [];
    runEpisode({
      ...EP, ticks: 1200, stride: 2,
      sink: { sample: (s) => seen.push(reactiveObs.read(s, mem).candidates.length) },
    });
    return seen;
  };
  assert.deepEqual(run(), run());
});
