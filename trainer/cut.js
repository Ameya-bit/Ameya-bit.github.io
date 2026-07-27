// Cutting a corpus — episodes in, shards + a manifest + a readable sample out.
//
// B4 of design/panda-policy-net.md, and the command B6 runs at scale.
//
// ## The manifest is the corpus
//
// The shards are gitignored and the manifest is not, which is a claim as much as a
// convention: **a corpus is re-cuttable from its manifest.** An episode is a pure
// function of (seed, config); the seeds come from one root; the configs come from a
// named spec and that same root. So the manifest holds every input, and the bytes
// are a cache of them. `--verify` makes the claim checkable — it re-cuts one
// episode and compares digests.
//
// For that to hold, the manifest itself must be a pure function of its inputs, so
// nothing in it is a timestamp or a path outside the corpus. Cut the same corpus
// twice and the two manifests are byte-identical; git history is where dates live.
//
// It also carries what the bytes cannot say for themselves: the row template, the
// observation layout and the sensor's parameters, the ground-truth schemas in
// column order, the label vocabularies, the action names — and a golden digest of
// the engine that recorded it, so a corpus cut before an engine change announces
// itself instead of quietly mixing.
//
//   node cut.js --spec natural --name eval-natural --episodes 8 --ticks 12000
//   node cut.js --spec wild --name train-wild --episodes 840 --dry-run
//   node cut.js --verify corpora/eval-natural.manifest.json [--episode 3]

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { makeEngine } from '../assets/pandas/engine/engine.js';
import * as shippedEngine from '../assets/pandas/engine/engine.js';
import { makeObserver, OBS_FIELDS, obsLayout } from '../assets/pandas/engine/policy/obs.js';
import { ACTION, ACTION_NAME, actionName } from '../assets/pandas/engine/actions.js';
import { runTrace, PHASE_A_SEEDS } from '../assets/pandas/engine/tools/trace.js';
import { hex } from '../assets/pandas/engine/tools/checksum.js';

import { configFactory, episodeSeeds, SPECS } from './corpus.js';
import { recordEpisode, TRUTH_VERSION, TRUTH_LABELS, GLOBAL_FIELDS, ENTITY_FIELDS, SLOT_FIELDS } from './truth.js';
import { DEFAULT_ROLLOUT } from './rollout.js';
import {
  rowLayout, rowTemplate, makeShardWriter, readShard, assertFloat32Safe, SHARD_VERSION,
} from './shard.js';

const TRAINER_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CUT = Object.freeze({
  spec: 'natural',
  corpusSeed: 20260727,
  episodes: 8,
  ticks: DEFAULT_ROLLOUT.ticks,
  stride: DEFAULT_ROLLOUT.stride,
  warmup: DEFAULT_ROLLOUT.warmup,
  // Ground truth doubles a shard's size and its cut time (truth.js walks each
  // episode twice). It is what Phase C's oracle and Phase G's probes read; a pure
  // behaviour-cloning corpus does not need it. On by default — a corpus missing
  // labels it could have had is the expensive mistake.
  truth: true,
  // Rows written to the JSONL sample, spread evenly across the first episode so
  // the sample shows a range of states rather than the first two seconds.
  sample: 12,
  out: join(TRAINER_DIR, 'corpora'),
  obs: {}, // observation-encoder overrides (Phase C tunes the cone here)
});

// The engine's fingerprint. Short — this is an identity check, not the Phase-A
// gate, which is `tools/golden.js` at 32 seeds x 10k ticks. Any behavioural change
// to the sim moves this number, so a corpus cut against a different engine cannot
// be silently mixed with one cut against this.
export const GOLDEN = Object.freeze({ seeds: 4, ticks: 2000 });

export function engineFingerprint() {
  const { batch } = runTrace({
    engine: shippedEngine,
    seeds: PHASE_A_SEEDS.slice(0, GOLDEN.seeds),
    ticks: GOLDEN.ticks,
  });
  return { ...GOLDEN, digest: hex(batch) };
}

// How many pandas an episode has. Fixed at init and constant for the episode's
// life, which is what makes a shard a rectangle — so it is read from the state
// rather than from the config, which only *asks* for a count.
export function pandaCountOf(seed, config) {
  return makeEngine(config).init(seed).entities.length;
}

// ---- one episode ----

// Defaults are spelled here rather than left to `recordEpisode`, because an
// explicit `undefined` survives an object spread: forwarding `stride: undefined`
// would overwrite the default with it and silently record nothing.
export function cutEpisode({
  seed,
  config,
  path,
  ticks = DEFAULT_ROLLOUT.ticks,
  stride = DEFAULT_ROLLOUT.stride,
  warmup = DEFAULT_ROLLOUT.warmup,
  truth = true,
  obs = {},
  // A caller may hand in its own observer instead of the overrides — one observer
  // owns one scratch buffer, so a B5 worker wants one of its own, made once and
  // re-`init`ed per episode rather than rebuilt.
  observer = makeObserver(obs),
}) {
  const layout = rowLayout({
    slots: observer.layout.slots,
    entities: pandaCountOf(seed, config),
    truth,
  });
  const writer = makeShardWriter({ path, layout });
  let peak = 0; // largest integer label seen — the float32 headroom watch
  let last = null;

  // Checking every row costs more than the encoding does, and checking only the
  // first is worse than useless: `tick` and the counters derived from it only grow,
  // so the first row is by construction the *safest* one in the episode. So the
  // first row and the last — the floor and the ceiling of every monotonic label.
  const checkLabels = (t, where) => {
    peak = Math.max(peak, assertFloat32Safe(t.global, GLOBAL_FIELDS, `${where} truth.global`));
    for (const e of t.entities) {
      peak = Math.max(peak, assertFloat32Safe(e, ENTITY_FIELDS, `${where} truth.entities[${e.id}]`));
    }
  };

  let summary;
  try {
    summary = recordEpisode({
      seed,
      config,
      ticks,
      stride,
      warmup,
      observer,
      onRow(row) {
        if (truth) {
          if (writer.rows === 0) checkLabels(row.truth, 'first row:');
          // `truth.entities` and `truth.global` are rebuilt per row (unlike `obs`,
          // which is a reused buffer), so holding the last one costs nothing.
          last = row.truth;
        }
        writer.write(row);
      },
    });
  } catch (err) {
    // A half-written shard is not a short shard, it is a corrupt one. Drop the
    // descriptor and the bytes rather than leaving either behind — a B5 worker that
    // catches a bad episode and carries on must not accumulate them.
    writer.abort();
    rmSync(path, { force: true });
    throw err;
  }
  if (last) checkLabels(last, 'last row:');

  return { ...writer.close(), seed, pandaCount: layout.entities, samples: summary.samples, peak };
}

// ---- the corpus ----

// Spreading an options object over the defaults would let an explicit `undefined`
// overwrite one — `episodes: undefined` reads as a zero-episode corpus and writes a
// manifest for it without complaint. Drop the undefined keys first; the same hazard
// is why `cutEpisode` spells its defaults as parameters.
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function cutCorpus(options = {}) {
  const opts = { ...DEFAULT_CUT, ...defined(options) };
  const { spec, corpusSeed, episodes, ticks, stride, warmup, truth, out, obs } = opts;
  if (!SPECS[spec]) throw new Error(`unknown corpus spec: ${spec} (have ${Object.keys(SPECS)})`);
  const name = opts.name ?? `${spec}-${episodes}x${ticks}`;
  const log = opts.log ?? (() => {});

  const configFor = configFactory(spec, corpusSeed);
  const seeds = episodeSeeds(corpusSeed, episodes);
  const observer = makeObserver(obs);

  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });

  const shards = [];
  let samples = 0;
  let bytes = 0;
  let peak = 0;
  const every = Math.max(1, Math.round(episodes / 20));

  for (let i = 0; i < episodes; i++) {
    const file = shardName(i);
    const cut = cutEpisode({
      seed: seeds[i],
      config: configFor(seeds[i], i),
      path: join(dir, file),
      ticks,
      stride,
      warmup,
      truth,
      // Episodes run one at a time, so they share the observer built above for the
      // manifest — its slot memory is minted per episode by `recordEpisode`, and
      // its frame buffer is the same one either way.
      observer,
    });
    shards.push({
      file,
      episode: i,
      seed: cut.seed,
      pandaCount: cut.pandaCount,
      rows: cut.rows,
      width: cut.width,
      bytes: cut.bytes,
      digest: cut.digest,
    });
    samples += cut.rows;
    bytes += cut.bytes;
    peak = Math.max(peak, cut.peak);
    if (i % every === 0 || i === episodes - 1) {
      log(`  ${String(i + 1).padStart(5)}/${episodes}  ${file}  ${cut.pandaCount} pandas  ` +
        `${cut.rows} rows  ${mb(cut.bytes)}  ${cut.digest}`);
    }
  }

  const manifest = {
    name,
    version: SHARD_VERSION,
    spec,
    corpusSeed,
    dir: name,
    rollout: { episodes, ticks, stride, warmup, truth },
    engine: engineFingerprint(),
    observation: { ...obsLayout(observer.layout.slots), params: observer.params },
    truth: truth
      ? {
        version: TRUTH_VERSION,
        global: [...GLOBAL_FIELDS],
        entity: [...ENTITY_FIELDS],
        slot: [...SLOT_FIELDS],
        labels: TRUTH_LABELS,
      }
      : null,
    actions: { count: ACTION.COUNT, names: [...ACTION_NAME] },
    row: rowTemplate({ slots: observer.layout.slots, truth }),
    totals: { episodes, samples, ticks: episodes * ticks, bytes, peakIntLabel: peak },
    shards,
  };

  writeFileSync(manifestPath(out, name), `${JSON.stringify(manifest, null, 2)}\n`);
  const sampleRows = writeSample({ manifest, out, rows: opts.sample });
  return { manifest, sampleRows };
}

const shardName = (i) => `ep-${String(i).padStart(4, '0')}.bin`;
export const manifestPath = (out, name) => join(out, `${name}.manifest.json`);
export const samplePath = (out, name) => join(out, `${name}.sample.jsonl`);

// ---- the readable sample ----
//
// Committed to git next to the manifest, because a format nobody can look at is a
// format nobody checks. It is decoded back **out of the shard's bytes**, not
// re-rendered from the rows in memory: whatever it shows is what the file holds.

export function writeSample({ manifest, out, rows = DEFAULT_CUT.sample }) {
  const first = manifest.shards[0];
  if (!first || rows <= 0) return 0;
  const layout = rowLayout({
    slots: manifest.observation.slots,
    entities: first.pandaCount,
    truth: manifest.rollout.truth,
  });
  const shard = readShard(join(out, manifest.dir, first.file), layout);
  const take = Math.min(rows, shard.rows);
  const step = Math.max(1, Math.floor(shard.rows / take));

  const lines = [];
  for (let n = 0; n < take; n++) {
    const i = Math.min(n * step, shard.rows - 1);
    const row = shard.decode(i);
    const line = {
      episode: first.episode,
      seed: first.seed,
      row: i,
      // The engine tick this row was taken at — recovered from the schedule rather
      // than stored, since a rectangular row has no room for what arithmetic knows.
      tick: manifest.rollout.warmup + (i + 1) * manifest.rollout.stride,
      action: row.action,
      actionName: actionName(row.action),
      obs: describeFrame(row.obs, manifest.observation),
    };
    if (row.truth) line.truth = row.truth;
    lines.push(JSON.stringify(line));
  }
  writeFileSync(samplePath(out, manifest.name), `${lines.join('\n')}\n`);
  return lines.length;
}

// A frame with its field names back on: token 0 is the self token, the rest are
// neighbour slots. Multi-column fields (the facing and pose one-hots, the wall
// clearances) stay arrays — naming them without reshaping them is the point.
export function describeFrame(frame, layout = obsLayout()) {
  const token = (t) => {
    const at = t * layout.width;
    const rec = {};
    for (const f of OBS_FIELDS) {
      rec[f.name] = f.size === 1
        ? frame[at + f.at]
        : Array.from(frame.subarray(at + f.at, at + f.at + f.size));
    }
    return rec;
  };
  return {
    self: token(0),
    slots: Array.from({ length: layout.tokens - 1 }, (_, i) => token(i + 1)),
  };
}

// ---- verification ----

// Re-cut one episode from the manifest alone and compare it to what is recorded.
// This is the claim "the shards are a cache of the manifest", executed.
export function verifyEpisode(manifest, { episode = 0, out, tmpDir } = {}) {
  const entry = manifest.shards[episode];
  if (!entry) throw new Error(`no episode ${episode} in ${manifest.name} (${manifest.shards.length} shards)`);
  const dir = tmpDir ?? join(out, `.verify-${manifest.name}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, entry.file);
  try {
    const configFor = configFactory(manifest.spec, manifest.corpusSeed);
    const seeds = episodeSeeds(manifest.corpusSeed, manifest.rollout.episodes);
    const cut = cutEpisode({
      seed: seeds[episode],
      config: configFor(seeds[episode], episode),
      path,
      ticks: manifest.rollout.ticks,
      stride: manifest.rollout.stride,
      warmup: manifest.rollout.warmup,
      truth: manifest.rollout.truth,
      obs: manifest.observation.params,
    });
    const fields = ['seed', 'rows', 'width', 'bytes', 'digest'];
    const diffs = fields.filter((f) => cut[f] !== entry[f]);
    return { episode, ok: diffs.length === 0, diffs, expected: entry, got: cut };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- CLI ----

const mb = (n) => `${(n / 1e6).toFixed(1)}MB`;
const gb = (n) => (n < 1e9 ? mb(n) : `${(n / 1e9).toFixed(2)}GB`);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'no-truth' || key === 'dry-run') { args[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    args[key] = value;
  }
  return args;
}

// What a cut will cost, without running it: exact byte count (panda counts come
// from init, which is cheap) and a time estimate from the measured record rate.
function dryRun({ spec, corpusSeed, episodes, ticks, stride, warmup, truth, obs }) {
  const configFor = configFactory(spec, corpusSeed);
  const seeds = episodeSeeds(corpusSeed, episodes);
  const slots = makeObserver(obs).layout.slots;
  const rowsPerEpisode = Math.floor(ticks / stride);
  let bytes = 0;
  let pandas = 0;
  for (let i = 0; i < episodes; i++) {
    const n = pandaCountOf(seeds[i], configFor(seeds[i], i));
    pandas += n;
    bytes += rowsPerEpisode * rowLayout({ slots, entities: n, truth }).width * 4;
  }
  return { bytes, rows: episodes * rowsPerEpisode, meanPandas: pandas / episodes, warmup };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out ? resolve(args.out) : DEFAULT_CUT.out;

  if (args.verify) {
    const path = resolve(args.verify);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const episode = args.episode === undefined ? 0 : Number(args.episode);
    console.log(`verifying ${manifest.name} episode ${episode} — re-cutting from the manifest alone\n`);
    const engineNow = engineFingerprint();
    if (engineNow.digest !== manifest.engine.digest) {
      console.log(`⚠ engine digest ${engineNow.digest} != ${manifest.engine.digest} recorded at cut time — ` +
        'the sim has changed; this corpus is stale.');
    }
    const r = verifyEpisode(manifest, { episode, out: dirname(path) });
    if (r.ok) {
      console.log(`OK — ${r.got.rows} rows, ${r.got.width} wide, digest ${r.got.digest}`);
      return;
    }
    console.error(`MISMATCH on ${r.diffs.join(', ')}`);
    for (const f of r.diffs) console.error(`  ${f}: manifest ${r.expected[f]} vs re-cut ${r.got[f]}`);
    process.exitCode = 1;
    return;
  }

  const opts = {
    ...DEFAULT_CUT,
    spec: args.spec ?? DEFAULT_CUT.spec,
    name: args.name,
    corpusSeed: args.seed === undefined ? DEFAULT_CUT.corpusSeed : Number(args.seed),
    episodes: args.episodes === undefined ? DEFAULT_CUT.episodes : Number(args.episodes),
    ticks: args.ticks === undefined ? DEFAULT_CUT.ticks : Number(args.ticks),
    stride: args.stride === undefined ? DEFAULT_CUT.stride : Number(args.stride),
    warmup: args.warmup === undefined ? DEFAULT_CUT.warmup : Number(args.warmup),
    truth: !args['no-truth'],
    sample: args.sample === undefined ? DEFAULT_CUT.sample : Number(args.sample),
    out,
  };

  const plan = dryRun(opts);
  console.log(`${opts.spec} — ${opts.episodes} episodes x ${opts.ticks} ticks, stride ${opts.stride}` +
    `${opts.truth ? ' + ground truth' : ' (observations and actions only)'}`);
  console.log(`  ${plan.rows.toLocaleString()} rows, ${plan.meanPandas.toFixed(1)} pandas/episode mean, ` +
    `${gb(plan.bytes)} on disk\n`);
  if (args['dry-run']) return;

  const t0 = process.hrtime.bigint();
  const { manifest, sampleRows } = cutCorpus({ ...opts, log: (s) => console.log(s) });
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;

  console.log(`\ncut ${manifest.name}: ${manifest.totals.episodes} shards, ` +
    `${manifest.totals.samples.toLocaleString()} rows, ${gb(manifest.totals.bytes)} in ${secs.toFixed(1)}s ` +
    `(${((manifest.totals.ticks / secs) / 1000).toFixed(0)}k ticks/s)`);
  console.log(`  ${manifestPath(out, manifest.name)}`);
  console.log(`  ${samplePath(out, manifest.name)} (${sampleRows} rows)`);
  console.log(`  ${join(out, manifest.dir)}/  — gitignored, re-cut with --verify to check`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
