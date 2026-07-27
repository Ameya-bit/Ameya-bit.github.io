// Corpus specs — what worlds the episodes are drawn from.
//
// This is not bookkeeping; it is the emergence lever. A belief only becomes
// legible along axes the training distribution actually varies (appendix of
// design/panda-policy-net.md: Sokoban's cell-square bijection, Chess-GPT's skill
// latent — both grew where the data moved). A policy trained on one stage size
// with one anomaly cadence can memorise arrival times instead of inferring them.
// So the specs below vary the world on purpose, and record exactly how, because a
// corpus you cannot describe is a result you cannot interpret.
//
// Three specs, per the phase plan:
//   natural — the live site's distribution. The eval corpus: scores on it are the
//             scores that matter, because it is what a visitor gets.
//   dense   — cranked density. The curriculum corpus: more neighbours, more
//             incidents, more collisions per minute.
//   wild    — everything randomised inside plausible bounds. The training corpus.
//
// A spec is a pure function (rng) -> config overrides. Same seed, same worlds.

import { Rng } from '../assets/pandas/engine/rng.js';
import { pandaCountForViewport, DEFAULT_DENSITY } from '../assets/pandas/engine/layout.js';
import { msToTicks } from '../assets/pandas/engine/tick.js';

// Real hero-region geometry, measured from the site: the stage spans the viewport
// width and sits under the header, and the hero card is fenced out of it.
const VIEWPORT = { wMin: 900, wMax: 2560, hMin: 420, hMax: 1200 };

// The hero card, as a fraction of the stage. Sampled rather than fixed so the
// fence is not a landmark the policy can navigate by.
function sampleFence(rng, width, height) {
  const w = Math.round(width * rng.float(0.28, 0.52));
  const h = Math.round(height * rng.float(0.30, 0.55));
  const l = Math.round((width - w) * rng.float(0.15, 0.85));
  const t = Math.round((height - h) * rng.float(0.10, 0.60));
  return { l, t, r: l + w, b: t + h };
}

function sampleStage(rng) {
  const width = Math.round(rng.float(VIEWPORT.wMin, VIEWPORT.wMax));
  const height = Math.round(rng.float(VIEWPORT.hMin, VIEWPORT.hMax));
  return { width, height, forbid: sampleFence(rng, width, height) };
}

// ---- the specs ----

// The live distribution: a real viewport, the shipped density rule, shipped
// timings, entrance on. Nothing is cranked; this is the site.
export function natural(rng) {
  const stage = sampleStage(rng);
  return {
    ...stage,
    pandaCount: pandaCountForViewport(stage.width, stage.height, stage.forbid),
    entrance: true,
  };
}

// Curriculum: the same worlds, packed. Density is the single strongest knob on
// how often anything happens, so it gets its own spec rather than being buried in
// `wild` — a policy that never trains under pressure never learns to triage.
export function dense(rng) {
  const stage = sampleStage(rng);
  const base = pandaCountForViewport(stage.width, stage.height, stage.forbid);
  return {
    ...stage,
    pandaCount: Math.min(DEFAULT_DENSITY.max, Math.round(base * rng.float(1.6, 2.6))),
    entrance: true,
    // More bodies with the shipped anomaly cadence would dilute incidents per
    // panda; keep incident pressure scaling with the crowd.
    anomGapMin: msToTicks(Math.round(rng.float(3000, 6000))),
    anomGapMax: msToTicks(Math.round(rng.float(6000, 11000))),
  };
}

// The training distribution. Every axis the observation could correlate with is
// moved: how big the world is, how crowded, how often things happen, how long
// they last, and whether the episode opens on the entrance or mid-scene.
export function wild(rng) {
  const stage = sampleStage(rng);
  const base = pandaCountForViewport(stage.width, stage.height, stage.forbid);
  const gapMin = Math.round(rng.float(2500, 8000));
  return {
    ...stage,
    pandaCount: Math.max(
      DEFAULT_DENSITY.min,
      Math.min(DEFAULT_DENSITY.max, Math.round(base * rng.float(0.7, 2.8))),
    ),
    // Half the episodes open mid-scene. The entrance is real (it is the first 20 s
    // of every visit) but it is also the calmest stretch there is, and a corpus
    // made only of openings would over-weight the relax beats.
    entrance: rng.chance(0.5),
    // Incident cadence.
    anomGapMin: msToTicks(gapMin),
    anomGapMax: msToTicks(gapMin + Math.round(rng.float(1500, 7000))),
    anomKick: msToTicks(Math.round(rng.float(0, 9000))),
    // Duration priors — the quantity the anticipation pay is a wager on. If naps
    // are always 8-20 s the posterior is a constant; vary it and "worth the trip?"
    // becomes a real question.
    sleepMin: msToTicks(Math.round(rng.float(4000, 12000))),
    sleepMax: msToTicks(Math.round(rng.float(12000, 30000))),
    stareMin: msToTicks(Math.round(rng.float(3000, 9000))),
    stareMax: msToTicks(Math.round(rng.float(9000, 18000))),
    // Set-piece clocks, so tier 2 and 3 are not on a metronome the net can count to.
    stackGapMin: msToTicks(Math.round(rng.float(30000, 90000))),
    stackGapMax: msToTicks(Math.round(rng.float(90000, 180000))),
    cascadeArmMin: msToTicks(Math.round(rng.float(60000, 180000))),
    cascadeArmMax: msToTicks(Math.round(rng.float(180000, 420000))),
  };
}

export const SPECS = Object.freeze({ natural, dense, wild });

// Build the per-episode config function for a spec. Episode i draws from its own
// PRNG stream seeded off (corpusSeed, i), so episodes are independent and any one
// of them can be re-cut alone without replaying the corpus.
export function configFactory(specName, corpusSeed) {
  const spec = SPECS[specName];
  if (!spec) throw new Error(`unknown corpus spec: ${specName} (have ${Object.keys(SPECS)})`);
  return (episodeSeed, i) => spec(new Rng((corpusSeed ^ (i * 0x9e3779b1)) | 0));
}

// Episode seeds for a corpus: deterministic, distinct, and derived from one root
// so a manifest only ever has to store the root.
export function episodeSeeds(corpusSeed, count) {
  const rng = new Rng(corpusSeed);
  const seeds = new Set();
  while (seeds.size < count) seeds.add(rng.int(0xffffffff) | 0);
  return [...seeds];
}
