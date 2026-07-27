import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  rowLayout, rowTemplate, encodeRow, decodeRow, readShard, makeShardWriter,
  describeColumn, assertFloat32Safe, FLOAT32_EXACT_INT,
} from '../shard.js';
import {
  cutCorpus, cutEpisode, verifyEpisode, describeFrame, manifestPath, samplePath, pandaCountOf,
  engineFingerprint, DEFAULT_CUT,
} from '../cut.js';
import { recordEpisode, GLOBAL_FIELDS, ENTITY_FIELDS, SLOT_FIELDS } from '../truth.js';
import { configFactory, episodeSeeds } from '../corpus.js';
import { makeObserver, OBS_WIDTH } from '../../assets/pandas/engine/policy/obs.js';
import { ACTION_NAME } from '../../assets/pandas/engine/actions.js';

// Small but not trivial: long enough that anomalies fire and slots turn over,
// short enough that a dozen cuts stay under a couple of seconds.
const CUT = { spec: 'natural', corpusSeed: 4242, episodes: 2, ticks: 1200, sample: 4 };

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'panda-shard-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the row layout tiles the row exactly, and names every column', () => {
  const layout = rowLayout({ slots: 8, entities: 11, truth: true });
  let at = 0;
  for (const b of layout.blocks) {
    assert.equal(b.at, at, `${b.name} starts at ${b.at}, expected ${at}`);
    assert.equal(b.size, b.repeat * b.width);
    at += b.size;
  }
  assert.equal(layout.width, at);
  assert.equal(layout.width, 9 * OBS_WIDTH + 1 + GLOBAL_FIELDS.length
    + 8 * SLOT_FIELDS.length + 11 * ENTITY_FIELDS.length);
  // Every column belongs to exactly one named field.
  for (let c = 0; c < layout.width; c++) {
    assert.doesNotMatch(describeColumn(layout, c), /outside the row|undefined/);
  }
  assert.equal(describeColumn(layout, layout.at.action), 'action.action');
  assert.equal(describeColumn(layout, layout.at.global), 'global.tick');
  assert.equal(describeColumn(layout, layout.at.entities + ENTITY_FIELDS.length), 'entities[1].id');
});

test('the template is the layout — the manifest cannot describe a different row', () => {
  const template = rowTemplate({ slots: 8, truth: true });
  const layout = rowLayout({ slots: 8, entities: 5, truth: true });
  assert.equal(template.blocks.length, layout.blocks.length);
  let at = 0;
  for (let i = 0; i < template.blocks.length; i++) {
    const t = template.blocks[i];
    const repeat = t.repeat === 'pandaCount' ? 5 : t.repeat;
    assert.equal(layout.blocks[i].name, t.name);
    assert.equal(layout.blocks[i].at, at);
    at += repeat * t.width;
  }
  assert.equal(at, layout.width);
  // Only the entity block may depend on the episode.
  assert.deepEqual(
    template.blocks.filter((b) => b.repeat === 'pandaCount').map((b) => b.name),
    ['entities'],
  );
});

test('a shard round-trips: what was recorded is what the bytes decode to', () => withTmp((dir) => {
  const seed = episodeSeeds(99, 1)[0];
  const config = configFactory('natural', 99)(seed, 0);
  const path = join(dir, 'ep.bin');
  const cut = cutEpisode({ seed, config, path, ticks: 1200, stride: 2, warmup: 0 });

  // Re-record the same episode in memory and compare row for row.
  const expected = [];
  recordEpisode({
    seed,
    config,
    ticks: 1200,
    stride: 2,
    observer: makeObserver(),
    onRow: (row) => expected.push({ ...row, obs: row.obs.slice() }),
  });

  const layout = rowLayout({ slots: 8, entities: cut.pandaCount, truth: true });
  const shard = readShard(path, layout);
  assert.equal(shard.rows, expected.length);
  assert.equal(shard.digest, cut.digest);
  assert.equal(shard.bytes, cut.bytes);

  for (let i = 0; i < shard.rows; i++) {
    const got = shard.decode(i);
    const want = expected[i];
    // The observation is float32 on both sides, so this is exact — the sensor's
    // bit-exactness survives the file.
    assert.deepEqual([...got.obs], [...want.obs], `row ${i} observation`);
    assert.equal(got.action, want.action);
    assert.equal(got.truth.global.tick, want.truth.global.tick);
    for (const f of GLOBAL_FIELDS) {
      if (Number.isInteger(want.truth.global[f])) {
        assert.equal(got.truth.global[f], want.truth.global[f], `row ${i} global.${f}`);
      }
    }
    for (let k = 0; k < want.truth.entities.length; k++) {
      // Entity block k holds panda id k — the join a probe depends on.
      assert.equal(got.truth.entities[k].id, k);
      const w = want.truth.entities[k];
      const g = got.truth.entities[k];
      assert.equal(g.mode, w.mode);
      assert.equal(g.ttl, w.ttl);
      // Positions are the one lossy field: doubles into float32, well under a pixel.
      assert.ok(Math.abs(g.x - w.x) < 0.01, `row ${i} panda ${k} x ${g.x} vs ${w.x}`);
    }
    assert.deepEqual(got.truth.slots.map((s) => s.id), want.truth.slots.map((s) => s.id));
  }
}));

test('integer labels survive float32 — the format is not quietly rounding them', () => {
  const rows = [];
  recordEpisode({
    seed: 7, config: configFactory('dense', 7)(7, 0), ticks: 2000, observer: makeObserver(), onRow: (r) => rows.push(r),
  });
  let peak = 0;
  for (const row of rows) {
    peak = Math.max(peak, assertFloat32Safe(row.truth.global, GLOBAL_FIELDS, 'global'));
    for (const e of row.truth.entities) {
      peak = Math.max(peak, assertFloat32Safe(e, ENTITY_FIELDS, `entities[${e.id}]`));
    }
  }
  assert.ok(peak > 0);
  assert.ok(peak < FLOAT32_EXACT_INT, `largest integer label ${peak} is past float32's exact range`);
});

test('the float32 headroom watch reads the end of the episode, not just its start', () => withTmp((dir) => {
  const seed = episodeSeeds(11, 1)[0];
  const config = configFactory('natural', 11)(seed, 0);
  const ticks = 4000;
  const cut = cutEpisode({ seed, config, path: join(dir, 'ep.bin'), ticks, stride: 2, warmup: 0 });
  // `tick` only grows, so the first row's labels are the smallest in the episode.
  // A watch that never looked past them would report a peak under the last tick and
  // would miss a monotonic counter walking off float32's exact range.
  assert.ok(cut.peak >= ticks, `peak ${cut.peak} is below the episode's last tick ${ticks}`);
  assert.ok(cut.peak < FLOAT32_EXACT_INT);
}));

test('a failed episode leaves no descriptor and no half-written shard', () => withTmp((dir) => {
  const path = join(dir, 'doomed.bin');
  const layout = rowLayout({ slots: 8, entities: 2, truth: false });
  const writer = makeShardWriter({ path, layout, chunkRows: 1 });
  writer.write({ action: 0, obs: new Float32Array(9 * OBS_WIDTH) });
  assert.throws(() => writer.write({ action: 0, obs: null }), /record with an observer/);
  writer.abort();
  assert.throws(() => writer.close(), /already closed/);
  // abort() is idempotent, so a caller that aborts in a catch and again in a finally
  // does not double-close a descriptor the runtime may have handed to someone else.
  assert.doesNotThrow(() => writer.abort());

  // And through cutEpisode: a sensor that fails partway through takes the episode
  // down, and the episode takes its bytes with it.
  const real = makeObserver();
  let seen = 0;
  const flaky = {
    ...real,
    observe(state, mem, out) {
      seen += 1;
      if (seen === 40) throw new Error('sensor failed');
      return real.observe(state, mem, out);
    },
  };
  const seed = episodeSeeds(13, 1)[0];
  const bad = join(dir, 'bad.bin');
  assert.throws(
    () => cutEpisode({
      seed, config: configFactory('natural', 13)(seed, 0), path: bad, ticks: 400, observer: flaky,
    }),
    /sensor failed/,
  );
  assert.equal(existsSync(bad), false, 'a failed episode left its partial shard behind');
}));

test('an explicit undefined does not overwrite a cut default', () => withTmp((dir) => {
  // The hazard the whole options path is written around: `{...DEFAULT, ...opts}`
  // happily lets `episodes: undefined` through, and `0 < undefined` is false — a
  // zero-episode corpus with a manifest and no complaint.
  const { manifest } = cutCorpus({
    ...CUT, name: 'undef', out: dir, episodes: undefined, stride: undefined, ticks: undefined,
  });
  assert.equal(manifest.rollout.episodes, DEFAULT_CUT.episodes);
  assert.equal(manifest.rollout.stride, DEFAULT_CUT.stride);
  assert.equal(manifest.rollout.ticks, DEFAULT_CUT.ticks);
  assert.equal(manifest.shards.length, DEFAULT_CUT.episodes);
}));

test('encodeRow refuses a row that does not match its layout', () => {
  const layout = rowLayout({ slots: 8, entities: 4, truth: true });
  const out = new Float32Array(layout.width);
  const row = {
    action: 0,
    obs: new Float32Array(9 * OBS_WIDTH),
    truth: {
      global: Object.fromEntries(GLOBAL_FIELDS.map((f) => [f, 0])),
      slots: Array.from({ length: 8 }, (_, i) => ({ slot: i, id: -1, heldFor: -1, visible: 0 })),
      entities: Array.from({ length: 4 }, (_, i) => Object.fromEntries(ENTITY_FIELDS.map((f) => [f, f === 'id' ? i : 0]))),
    },
  };
  assert.doesNotThrow(() => encodeRow(row, layout, out, 0, { deep: true }));

  assert.throws(() => encodeRow({ ...row, obs: null }, layout, out), /record with an observer/);
  assert.throws(
    () => encodeRow({ ...row, truth: { ...row.truth, entities: row.truth.entities.slice(1) } }, layout, out),
    /roster changed mid-episode/,
  );
  const shuffled = [...row.truth.entities].reverse();
  assert.throws(
    () => encodeRow({ ...row, truth: { ...row.truth, entities: shuffled } }, layout, out),
    /not in id order/,
  );
  // A missing field reads as undefined, lands as NaN, and the first-row deep check
  // is what makes that loud instead of a column of quiet garbage.
  const holed = { ...row.truth.global };
  delete holed.cascadeFelled;
  assert.throws(
    () => encodeRow({ ...row, truth: { ...row.truth, global: holed } }, layout, out, 0, { deep: true }),
    /global\.cascadeFelled/,
  );
});

test('a corpus is re-cuttable from its manifest, byte for byte', () => withTmp((dir) => {
  const a = cutCorpus({ ...CUT, name: 'twice', out: join(dir, 'a') }).manifest;
  const b = cutCorpus({ ...CUT, name: 'twice', out: join(dir, 'b') }).manifest;
  // Nothing in a manifest is a clock or a path, so two cuts of one corpus agree
  // exactly — that is what makes it a contract rather than a log.
  assert.deepEqual(a, b);
  assert.equal(
    readFileSync(manifestPath(join(dir, 'a'), 'twice'), 'utf8'),
    readFileSync(manifestPath(join(dir, 'b'), 'twice'), 'utf8'),
  );
  for (const shard of a.shards) {
    assert.deepEqual(
      readFileSync(join(dir, 'a', a.dir, shard.file)),
      readFileSync(join(dir, 'b', b.dir, shard.file)),
    );
  }
  // And one episode alone can be re-cut and checked, which is the claim that lets
  // the bytes stay out of git.
  const ok = verifyEpisode(a, { episode: 1, out: join(dir, 'a') });
  assert.equal(ok.ok, true, `re-cut differed on ${ok.diffs.join(', ')}`);

  // A manifest whose inputs have been edited must not verify.
  const tampered = { ...a, corpusSeed: a.corpusSeed + 1 };
  const bad = verifyEpisode(tampered, { episode: 1, out: join(dir, 'a') });
  assert.equal(bad.ok, false);
  assert.ok(bad.diffs.includes('digest'));
}));

test('the manifest describes the shards it actually wrote', () => withTmp((dir) => {
  const { manifest } = cutCorpus({ ...CUT, name: 'described', out: dir });

  assert.equal(manifest.shards.length, CUT.episodes);
  assert.equal(manifest.totals.episodes, CUT.episodes);
  assert.equal(manifest.totals.ticks, CUT.episodes * CUT.ticks);
  assert.equal(manifest.engine.digest, engineFingerprint().digest);
  assert.deepEqual(manifest.actions.names, [...ACTION_NAME]);
  assert.equal(manifest.actions.count, 17);

  let bytes = 0;
  let samples = 0;
  for (const shard of manifest.shards) {
    const path = join(dir, manifest.dir, shard.file);
    assert.equal(statSync(path).size, shard.bytes, `${shard.file} size`);
    assert.equal(shard.bytes, shard.rows * shard.width * 4);
    assert.equal(shard.rows, Math.floor(CUT.ticks / manifest.rollout.stride));
    // The width the manifest promises is the width the layout computes.
    assert.equal(
      rowLayout({ slots: manifest.observation.slots, entities: shard.pandaCount, truth: true }).width,
      shard.width,
    );
    assert.equal(shard.pandaCount, pandaCountOf(shard.seed, configFactory(manifest.spec, manifest.corpusSeed)(shard.seed, shard.episode)));
    bytes += shard.bytes;
    samples += shard.rows;
  }
  assert.equal(manifest.totals.bytes, bytes);
  assert.equal(manifest.totals.samples, samples);

  // The truth schemas in the manifest are the record's own keys, in order.
  assert.deepEqual(manifest.truth.global, [...GLOBAL_FIELDS]);
  assert.deepEqual(manifest.truth.entity, [...ENTITY_FIELDS]);
  assert.deepEqual(manifest.truth.slot, [...SLOT_FIELDS]);
}));

test('the JSONL sample is a decode of the bytes, not a second rendering of them', () => withTmp((dir) => {
  const { manifest, sampleRows } = cutCorpus({ ...CUT, name: 'sampled', out: dir, sample: 5 });
  const lines = readFileSync(samplePath(dir, 'sampled'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(sampleRows, 5);

  const first = manifest.shards[0];
  const layout = rowLayout({ slots: manifest.observation.slots, entities: first.pandaCount, truth: true });
  const shard = readShard(join(dir, manifest.dir, first.file), layout);

  for (const text of lines) {
    const line = JSON.parse(text);
    assert.equal(line.episode, 0);
    assert.equal(line.seed, first.seed);
    const row = shard.decode(line.row);
    assert.equal(line.action, row.action);
    assert.equal(line.actionName, ACTION_NAME[row.action]);
    assert.deepEqual(line.truth, JSON.parse(JSON.stringify(row.truth)));
    // The tick is derived from the recording schedule; ground truth carries the
    // engine's own. They agree, or the schedule arithmetic is wrong.
    assert.equal(line.tick, row.truth.global.tick);
    // Named observation fields point back at the same floats.
    const named = describeFrame(row.obs, manifest.observation);
    assert.deepEqual(line.obs.self, JSON.parse(JSON.stringify(named.self)));
    assert.equal(line.obs.slots.length, manifest.observation.slots);
    assert.equal(line.obs.self.self, 1);
    assert.equal(line.obs.self.hatOn, 1);
  }
  // Spread across the episode rather than bunched at the front.
  const rowsUsed = lines.map((l) => JSON.parse(l).row);
  assert.ok(rowsUsed[rowsUsed.length - 1] > shard.rows / 2, `sample stops at row ${rowsUsed.at(-1)}`);
}));

test('a corpus can be cut without ground truth — narrower rows, same observations', () => withTmp((dir) => {
  const lean = cutCorpus({ ...CUT, name: 'lean', out: dir, truth: false }).manifest;
  const full = cutCorpus({ ...CUT, name: 'full', out: dir, truth: true }).manifest;

  assert.equal(lean.truth, null);
  assert.equal(lean.row.blocks.length, 2);
  assert.equal(lean.shards[0].width, 9 * OBS_WIDTH + 1);
  // Labels are a large share of a row, and a larger one the busier the stage: on
  // `natural`'s half-dozen pandas dropping them saves ~44% of the bytes, on a
  // crowded `wild` world considerably more.
  assert.ok(lean.totals.bytes < full.totals.bytes * 0.6);

  const layout = rowLayout({ slots: 8, entities: lean.shards[0].pandaCount, truth: false });
  const leanShard = readShard(join(dir, lean.dir, lean.shards[0].file), layout);
  const fullShard = readShard(
    join(dir, full.dir, full.shards[0].file),
    rowLayout({ slots: 8, entities: full.shards[0].pandaCount, truth: true }),
  );
  assert.equal(leanShard.rows, fullShard.rows);
  // Same seed, same config, so the observations and actions are identical — the
  // only difference is what got written next to them.
  for (let i = 0; i < leanShard.rows; i += 97) {
    const a = leanShard.decode(i);
    const b = fullShard.decode(i);
    assert.equal(a.truth, undefined);
    assert.equal(a.action, b.action);
    assert.deepEqual([...a.obs], [...b.obs]);
  }
  // The sample follows suit.
  const line = JSON.parse(readFileSync(samplePath(dir, 'lean'), 'utf8').split('\n')[0]);
  assert.equal(line.truth, undefined);
  assert.ok(line.obs.self);
}));

test('a shard read with the wrong layout is refused, not misread', () => withTmp((dir) => {
  const seed = episodeSeeds(3, 1)[0];
  const config = configFactory('natural', 3)(seed, 0);
  const path = join(dir, 'ep.bin');
  const cut = cutEpisode({ seed, config, path, ticks: 600, stride: 2, warmup: 0 });
  assert.throws(
    () => readShard(path, rowLayout({ slots: 8, entities: cut.pandaCount + 1, truth: true })),
    /not a whole number of|truncated/,
  );
}));

test('an empty shard is a legal, empty rectangle', () => withTmp((dir) => {
  const path = join(dir, 'empty.bin');
  const layout = rowLayout({ slots: 8, entities: 4, truth: false });
  const entry = makeShardWriter({ path, layout }).close();
  assert.equal(entry.rows, 0);
  assert.equal(entry.bytes, 0);
  assert.equal(readShard(path, layout).rows, 0);
  assert.equal(readShard(path, layout).digest, entry.digest);
}));

test('decodeRow is the inverse of encodeRow', () => {
  const layout = rowLayout({ slots: 2, entities: 2, truth: true });
  const obs = new Float32Array(3 * OBS_WIDTH);
  for (let i = 0; i < obs.length; i++) obs[i] = i / 8;
  const row = {
    action: 9,
    obs,
    truth: {
      global: Object.fromEntries(GLOBAL_FIELDS.map((f, i) => [f, i - 3])),
      slots: [{ slot: 0, id: 4, heldFor: 2, visible: 1 }, { slot: 1, id: -1, heldFor: -1, visible: 0 }],
      entities: [0, 1].map((id) => Object.fromEntries(ENTITY_FIELDS.map((f, i) => [f, f === 'id' ? id : i * 2 - 1]))),
    },
  };
  const flat = new Float32Array(layout.width);
  encodeRow(row, layout, flat, 0, { deep: true });
  const back = decodeRow(flat, layout);
  assert.equal(back.action, 9);
  assert.deepEqual([...back.obs], [...obs]);
  assert.deepEqual(back.truth.global, row.truth.global);
  assert.deepEqual(back.truth.slots, row.truth.slots);
  assert.deepEqual(back.truth.entities, row.truth.entities);
});
