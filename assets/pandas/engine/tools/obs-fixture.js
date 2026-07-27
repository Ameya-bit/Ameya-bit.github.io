// The observation encoder's cross-language contract.
//
// `policy/obs.js` is bit-exact by construction — its arithmetic is +,-,*,/ and
// sqrt into a Float32Array, all IEEE-754-mandated. This turns that claim into
// something another implementation can be *held to*: a handful of (world, slot
// memory) -> (frame, slot memory) cases, written out as plain JSON.
//
// The cases carry the observable projection of a real engine state — literally the
// fields the encoder is allowed to read — so a consumer needs no simulator, only
// the encoder. A Python (or Rust, or WASM) port passes when it reproduces every
// `obs` array exactly and lands on the same `memOut`. That is the "encoder parity
// tests green" line in Phase B, made checkable before the Python side exists.
//
//   node tools/obs-fixture.js            # rewrite policy/obs-fixture.json
//   node tools/obs-fixture.js --check    # fail if the encoder has drifted from it
//
// A unit test runs `--check`, so a change to the layout, the FOV or the slot rules
// cannot land quietly: it has to be re-baked, and the diff shows what moved.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeEngine } from '../engine.js';
import { MODE, ANIM } from '../state.js';
import { makeObserver, observerOf, OBS_FIELDS } from '../policy/obs.js';

const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = join(ENGINE_DIR, 'policy', 'obs-fixture.json');

// A world that reaches the interesting states quickly: a tower inside the first
// minute, no cascade (its bodies are just knocks, already covered), entrance on so
// the walk-in — the first thing a deployed policy ever sees — is in the fixture.
const WORLD = Object.freeze({
  width: 1360,
  height: 760,
  forbid: { l: 470, t: 120, r: 900, b: 430 },
  pandaCount: 11,
  entrance: true,
  stackKick: 220,
  cascadeKick: 100000,
});
const SEED = 20260727;
const TICKS = 3000;

// Only these fields of an entity may be read (see policy/obs.js), so only these
// are recorded. The list doubling as the fixture's schema is the point: if the
// encoder ever needs a field that is not here, the fixture cannot express it.
const ENTITY_FIELDS = [
  'id', 'hasHat', 'x', 'y', 'dir', 'anim', 'mode', 'flying', 'stackLevel',
  'aPhase', 'aTimer', 'rollReadyAt',
];
const CFG_FIELDS = [
  'width', 'height', 'forbid', 'cell', 'foot', 'hiccupRise', 'hiccupHopTicks',
  'rollCooldownTicks',
];

const pick = (src, keys) => Object.fromEntries(keys.map((k) => [k, src[k]]));
const copyMem = (m) => ({ id: [...m.id], seen: [...m.seen], dist: [...m.dist] });

// The four states worth pinning, most-specific first: each predicate claims the
// first frame that satisfies it and no later frame overwrites it.
const WANTED = [
  {
    name: 'tower',
    why: 'a rider seated on a base — level, riding and carrying all lit',
    ok: (tok) => tok.some((t) => t.visible && (t.riding || t.carrying)),
  },
  {
    name: 'occluded',
    why: 'a slot bound to a panda he cannot currently see: present, not visible',
    ok: (tok) => tok.some((t) => t.present && !t.visible),
  },
  {
    name: 'entrance',
    why: 'the walk-on, when the field is still filling and the cone is nearly empty',
    ok: (tok, tick) => tick < 300 && tok.some((t) => t.visible),
  },
  {
    name: 'crowd',
    why: 'the ordinary case — several bodies in the cone at once',
    ok: (tok) => tok.filter((t) => t.visible).length >= 3,
  },
];

// Slot tokens as {present, visible, riding, carrying}, for the predicates above.
function slotSummary(frame, layout) {
  const at = (name) => OBS_FIELDS.find((f) => f.name === name).at;
  return [...Array(layout.slots).keys()].map((s) => {
    const base = (1 + s) * layout.width;
    return {
      present: frame[base + at('present')] === 1,
      visible: frame[base + at('visible')] === 1,
      riding: frame[base + at('riding')] === 1,
      carrying: frame[base + at('carrying')] === 1,
    };
  });
}

function buildFixture() {
  const engine = makeEngine(WORLD);
  const obs = makeObserver();
  const mem = obs.init();
  let state = engine.init(SEED);
  const found = new Map();

  for (let t = 1; t <= TICKS; t++) {
    state = engine.step(state);
    if (t % 2) continue; // the policy's own 10 Hz clock
    const memIn = copyMem(mem);
    const frame = obs.observe(state, mem);
    const tokens = slotSummary(frame, obs.layout);
    for (const want of WANTED) {
      if (found.has(want.name) || !want.ok(tokens, state.tick)) continue;
      found.set(want.name, {
        case: want.name,
        why: want.why,
        tick: state.tick,
        cfg: pick(state.cfg, CFG_FIELDS),
        stackBaseId: state.stack.baseId,
        entities: state.entities.map((e) => pick(e, ENTITY_FIELDS)),
        memIn,
        memOut: copyMem(mem),
        obs: [...frame],
      });
    }
  }

  const missing = WANTED.filter((w) => !found.has(w.name)).map((w) => w.name);
  if (missing.length) throw new Error(`obs-fixture: never reached ${missing.join(', ')}`);

  return {
    note: 'Generated by tools/obs-fixture.js — do not hand-edit. See policy/obs.js.',
    ...obs.describe(),
    // The consumer has to know which mode/anim integers mean what, and which
    // hiccup sub-phase is the airborne one (a private constant in anomalies.js,
    // surfaced here because the drawn pop height depends on it).
    enums: {
      MODE: pick(MODE, ['RIDING', 'MOUNTING', 'HICCUP']),
      ANIM: { ...ANIM },
      HICCUP_POP_PHASE: 6,
    },
    source: { world: WORLD, seed: SEED, ticks: TICKS },
    cases: WANTED.map((w) => found.get(w.name)),
  };
}

const fixture = buildFixture();
const baked = `${JSON.stringify(fixture, null, 1)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURE_PATH, 'utf8') !== baked) {
    console.error('policy/obs-fixture.json is stale — re-run: node tools/obs-fixture.js');
    process.exit(1);
  }
  console.log('obs-fixture.json matches the encoder');
} else {
  writeFileSync(FIXTURE_PATH, baked);
  console.log(`wrote ${FIXTURE_PATH} (${(baked.length / 1024).toFixed(1)} KB) — ` +
    `${fixture.cases.map((c) => c.case).join(', ')}`);
}
