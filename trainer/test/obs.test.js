// The observation encoder against real episodes.
//
// The encoder itself lives in the engine (assets/pandas/engine/policy/obs.js) and
// is unit-tested there on hand-placed worlds. What is checked here is the thing
// only a rollout can show: that it behaves across the corpus specs — every value
// in band on every frame of a dense field, slots that stay put through a real
// walk, and enough seen and unseen to make the memory task the one we intended.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runEpisode } from '../rollout.js';
import { SPECS, configFactory, episodeSeeds } from '../corpus.js';
import { makeObserver, OBS_FIELDS } from '../../assets/pandas/engine/policy/obs.js';

const at = (name) => OBS_FIELDS.find((f) => f.name === name).at;

// The recording pattern the corpus writer will use: one observer, one slot memory,
// carried across the whole episode and advanced once per recorded sample.
function observeEpisode({ seed, config, ticks = 3000, params = {} }) {
  const obs = makeObserver(params);
  const mem = obs.init();
  const frames = [];
  runEpisode({
    seed,
    config,
    ticks,
    sink: { sample: (state) => frames.push(obs.observe(state, mem).slice()) },
  });
  return { obs, frames };
}

// Per-slot occupancy over a run: how many frames each slot was visible/present,
// and how often a slot was handed from one panda straight to another.
function slotStats(obs, frames) {
  const { slots, width } = obs.layout;
  let visible = 0;
  let held = 0;
  let anyVisible = 0;
  let nobody = 0;
  for (const f of frames) {
    let seen = 0;
    for (let s = 0; s < slots; s++) {
      const base = (1 + s) * width;
      if (f[base + at('visible')] === 1) seen += 1;
      else if (f[base + at('present')] === 1) held += 1;
    }
    visible += seen;
    if (seen > 0) anyVisible += 1;
    else nobody += 1;
  }
  return { visible, held, anyVisible, nobody, frames: frames.length };
}

test('every frame of every spec is finite, in band, and self-headed', () => {
  for (const name of Object.keys(SPECS)) {
    const configFor = configFactory(name, 4242);
    const seeds = episodeSeeds(4242, 2);
    for (let i = 0; i < seeds.length; i++) {
      const { obs, frames } = observeEpisode({
        seed: seeds[i], config: configFor(seeds[i], i), ticks: 2400,
      });
      assert.ok(frames.length > 1000, `${name}: only ${frames.length} frames`);
      for (const f of frames) {
        assert.equal(f.length, obs.layout.length);
        assert.equal(f[at('self')], 1, `${name}: token 0 is not the self token`);
        for (let k = 0; k < f.length; k++) {
          assert.ok(Number.isFinite(f[k]) && f[k] >= -1 && f[k] <= 1,
            `${name}: frame value ${f[k]} at ${k}`);
        }
        // Only token 0 may claim to be him.
        for (let s = 0; s < obs.layout.slots; s++) {
          assert.equal(f[(1 + s) * obs.layout.width + at('self')], 0);
        }
      }
    }
  }
});

test('the same episode encodes to the same bytes twice', () => {
  const config = configFactory('wild', 11)(0, 0);
  const a = observeEpisode({ seed: 20260727, config, ticks: 1600 });
  const b = observeEpisode({ seed: 20260727, config, ticks: 1600 });
  assert.deepEqual(a.frames.map((f) => [...f]), b.frames.map((f) => [...f]));
});

test('he usually sees somebody, and regularly sees nobody at all', () => {
  // Both halves matter. All-seeing means the cone is too generous and there is
  // nothing to remember; never-seeing means the sensor is blind and the game is
  // unplayable. This is the health check on D1's headline knob.
  const configFor = configFactory('natural', 909);
  const seeds = episodeSeeds(909, 3);
  let anyVisible = 0;
  let nobody = 0;
  let frames = 0;
  for (let i = 0; i < seeds.length; i++) {
    const run = observeEpisode({ seed: seeds[i], config: configFor(seeds[i], i), ticks: 6000 });
    const s = slotStats(run.obs, run.frames);
    anyVisible += s.anyVisible;
    nobody += s.nobody;
    frames += s.frames;
  }
  assert.ok(anyVisible / frames > 0.4, `he sees someone in only ${anyVisible / frames} of frames`);
  assert.ok(nobody / frames > 0.02, `he is never alone (${nobody / frames}) — the cone is too wide`);
});

test('slots are sticky through a real walk, not reshuffled every frame', () => {
  const configFor = configFactory('dense', 31337);
  const seeds = episodeSeeds(31337, 2);
  let handovers = 0;
  let samples = 0;
  for (let i = 0; i < seeds.length; i++) {
    const obs = makeObserver();
    const mem = obs.init();
    let prev = [...mem.id];
    runEpisode({
      seed: seeds[i],
      config: configFor(seeds[i], i),
      ticks: 6000,
      sink: {
        sample: (state) => {
          obs.observe(state, mem);
          for (let s = 0; s < mem.id.length; s++) {
            // A handover is one panda replacing another in the same slot: the
            // churn stickiness exists to suppress. Binding a free slot, or
            // releasing one, is not churn.
            if (prev[s] >= 0 && mem.id[s] >= 0 && mem.id[s] !== prev[s]) handovers += 1;
          }
          prev = [...mem.id];
          samples += 1;
        },
      },
    });
  }
  // Fewer than one eviction per slot-second, on the busiest corpus there is.
  assert.ok(handovers / samples < 0.5, `${handovers / samples} handovers per frame`);
  assert.ok(handovers > 0, 'no slot ever changed hands — the field is too quiet to be a test');
});

test('a bound slot is held through short occlusions rather than dropped', () => {
  const configFor = configFactory('dense', 5150);
  const seed = episodeSeeds(5150, 1)[0];
  const { obs, frames } = observeEpisode({ seed, config: configFor(seed, 0), ticks: 6000 });
  const s = slotStats(obs, frames);
  assert.ok(s.held > 0, 'no slot was ever held while out of sight — object permanence is off');
  // Held frames are the memory task's raw material, but they should be a minority
  // of occupancy: a sensor that mostly reports "present, unseen" is a blindfold.
  assert.ok(s.held < s.visible, `held ${s.held} vs visible ${s.visible}`);
});

test('a wider cone sees more — the FOV parameters are live', () => {
  const config = configFactory('natural', 24)(0, 0);
  const seed = episodeSeeds(24, 1)[0];
  const narrow = observeEpisode({ seed, config, ticks: 4000, params: { coneDeg: 60 } });
  const wide = observeEpisode({ seed, config, ticks: 4000, params: { coneDeg: 300 } });
  assert.ok(slotStats(wide.obs, wide.frames).visible > slotStats(narrow.obs, narrow.frames).visible);
});
