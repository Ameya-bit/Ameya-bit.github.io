// Scoring a policy over a set of episodes — the instrument Phase C reads.
//
// C1 of design/panda-policy-net.md. `game.js` says what one episode is worth;
// this runs a policy across many and reports the distribution, because a single
// episode of this sim is mostly luck: whether a cascade fired, whether the tower
// formed near him, how crowded the draw was.
//
//   node evaluate.js                                  # every policy, natural, 24 episodes
//   node evaluate.js --policy expert --episodes 64
//   node evaluate.js --spec dense --ticks 6000
//   node evaluate.js --policy expert --json           # the full report, machine-readable
//   node evaluate.js --rules viewRadius=240,knockPenalty=40   # turn a knob and re-read
//
// ## The eval set is the eval corpus
//
// The seeds and configs come from `corpus.js` at the same root `cut.js` uses, so
// `--spec natural --seed 20260727` scores exactly the episodes of the committed
// `eval-natural` corpus, in order. That is not a coincidence to be maintained — it
// means a score here and a row in that corpus are the same world, so anything
// learned from the shards can be checked against a score without re-deriving which
// episode was which.
//
// ## Read the diagnostics, not the score
//
// The total is one number, and Phase C's exit is not about a number being big — it
// is about a *gap* between information sets being big. Coverage, arrival age and
// knocks/min are what a rules change is judged on; the score is downstream of them.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { runEpisode, DEFAULT_ROLLOUT } from './rollout.js';
import { scoreSink, makeRules, DEFAULT_RULES, GAME_VERSION } from './game.js';
import {
  policyByName, POLICIES, YARDSTICKS, EXPLOITS, REWARD_EXPLOITS, ACTION_EXPLOITS,
} from './policies.js';
import { configFactory, episodeSeeds, SPECS } from './corpus.js';
import { certifyReport, printCertificate } from './twins.js';

export const DEFAULT_EVAL = Object.freeze({
  spec: 'natural',
  corpusSeed: 20260727, // = cut.js's DEFAULT_CUT.corpusSeed. See the header.
  episodes: 24,
  ticks: DEFAULT_ROLLOUT.ticks,
});

// One episode, one policy, one report.
export function scoreEpisode({ seed, config = {}, ticks, policy = null, rules = {} }) {
  const sink = scoreSink(rules);
  // stride 1 is not a default here, it is a requirement: pay is per tick and the
  // knock edge is one tick wide. `scoreSink.begin` refuses anything else.
  runEpisode({ seed, config, ticks, stride: 1, sink, policy, rules: sink.rules });
  return sink.report({ seed });
}

// ---- aggregation ----

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) * (x - m))) / (xs.length - 1));
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// Read one field out of every episode report and describe its spread. The standard
// error is reported alongside the standard deviation because the question Phase C
// asks is always "is this policy above that one", and at 24 episodes of a sim this
// noisy the sd alone reads as if nothing is ever distinguishable.
function spread(reports, pick) {
  const xs = reports.map(pick);
  return {
    mean: mean(xs),
    sd: sd(xs),
    se: reports.length ? sd(xs) / Math.sqrt(reports.length) : 0,
    median: median(xs),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

export function evaluatePolicy({
  policy,
  name = 'policy',
  spec = DEFAULT_EVAL.spec,
  corpusSeed = DEFAULT_EVAL.corpusSeed,
  episodes = DEFAULT_EVAL.episodes,
  ticks = DEFAULT_EVAL.ticks,
  rules = {},
} = {}) {
  if (!SPECS[spec]) throw new Error(`unknown corpus spec: ${spec}`);
  const configFor = configFactory(spec, corpusSeed);
  const seeds = episodeSeeds(corpusSeed, episodes);
  const resolved = makeRules(rules);

  const reports = seeds.map((seed, i) =>
    scoreEpisode({ seed, config: configFor(seed, i), ticks, policy, rules: resolved }));

  return {
    name,
    spec,
    corpusSeed,
    episodes,
    ticks,
    version: GAME_VERSION,
    rules: resolved,
    scorePerMin: spread(reports, (x) => x.scorePerMin),
    view: spread(reports, (x) => x.components.view),
    cost: spread(reports, (x) => -(x.components.step + x.components.roll + x.components.knock)),
    coverage: spread(reports, (x) => x.attention.coverage),
    tickCoverage: spread(reports, (x) => x.attention.tickCoverage),
    arrivalAge: spread(reports, (x) => x.attention.meanArrivalAge),
    knocksPerMin: spread(reports, (x) => x.hat.knocksPerMin),
    groundedFrac: spread(reports, (x) => x.hat.groundedFrac),
    offered: spread(reports, (x) => x.attention.offered),
    reports,
  };
}

// ---- the gate (C2) ----

// Phase C's first two exit checks, computed rather than eyeballed.
//
// The memory gap is reported **twice**, because there are two defensible reactive
// ceilings and they do not agree:
//
//   full — `reactiveObs`, one observation frame with no feed and no memory. This is
//     the plan's memoryless twin, word for word ("train a deliberately memoryless
//     twin… the gap between them is the exact quantity of score only a world model
//     can claim"), and **the gate returns its verdict on this one.**
//   conservative — `reactiveTruth`, which sees everything true about the current
//     tick and nothing temporal. Reported as a **diagnostic, with no verdict**: it
//     is the duration tier's own price tag, and it is not a bound on anything.
//
// ⚠️ **Why the conservative reading lost its threshold (C5, and it is not a
// relaxation).** Through C4 it carried a verdict on the argument that `reactiveTruth`
// strictly dominates any memoryless observer, so the gap above it must be a lower
// bound on the memory gap. That argument is about *information sets*; it says
// nothing about achieved **scores** unless the planner underneath is optimal, and it
// is not. C5 measured the consequence twice over: on `wild` the clockless arm
// out-scores the oracle outright (a gap of **−19%**, and a lower bound on a
// non-negative quantity cannot be negative), and on `natural` one unprincipled
// planner knob — whether it declines a negative-EV trip or takes it anyway — walks
// the number from 17% to 6% while the full gap holds between 77% and 95% across
// every variant and all three specs. So the conservative gap is dominated by how
// well the shared planner happens to play, not by what the arms are allowed to know.
// The full gap is the robust measurement and it is also the one the plan asked for.
// C4's separate point still stands and is why the diagnostic is worth printing:
// `reactiveTruth` is handed *identity* free by the incident feed, so what it prices
// is the duration tier alone.
//
// The exploit check is the plan's wording made arithmetic: where does each bot sit
// on the line from the reactive ceiling (0) to the oracle (1)?
//
// ⚠️ **That line is the right ruler for only one of the two exploit families**, which
// C4 learned the hard way. The plan's wording — "much nearer the reactive ceiling
// than the oracle" — assumes a bot that wins *without knowing anything*, which is
// what a reward exploit is: `camper` and `cowerer` are ignorant by construction, and
// a high climb from one means the ledger pays for something other than watching.
// An **action** exploit is the opposite animal. `speeder` and `roller` are the
// privileged oracle with one brake taken off, so their information is the oracle's
// and a climb near 1 is what they score *when the exploit is closed*. Measured
// against the reactive ceiling, a working limiter reads as a 100% failure.
//
// So each family is scored against the thing it would have to beat to be a problem:
//
//   reward exploits — `climb` off the reactive ceiling, ≤ `exploitCeiling`. Did an
//     ignorant bot get near the oracle's score?
//   action exploits — `excess` over the **oracle itself**, ≤ `exploitExcess`. Did
//     taking a brake off beat the identical policy that left it on? This is a
//     regression test on `limitAction` (engine hat.js) and nothing else, and the
//     tolerance is roughly one standard error at 24 episodes rather than a judgement.
export const GATE = Object.freeze({
  gapThreshold: 0.30, // D3's initial proposal: the gap must be ≥30% of the oracle
  exploitCeiling: 0.25, // "much nearer the reactive ceiling than the oracle"
  exploitExcess: 0.10, // an unbraked twin may not out-score the oracle it copies
});

export function gapReport(results) {
  const by = Object.fromEntries(results.map((r) => [r.name, r.scorePerMin.mean]));
  const oracle = by.oracle;
  const conservative = by.reactiveTruth;
  const full = by.reactiveObs;
  const frac = (ceiling) => (oracle - ceiling) / Math.abs(oracle);
  const climb = (v, ceiling) => (v - ceiling) / (oracle - ceiling);
  return {
    oracle,
    // No `ok`, deliberately — see the header. A caller that wants a verdict on the
    // memory gap has exactly one place to get it, and it is `full`.
    conservative: { ceiling: conservative, gap: oracle - conservative, frac: frac(conservative) },
    full: {
      ceiling: full,
      gap: oracle - full,
      frac: frac(full),
      ok: frac(full) >= GATE.gapThreshold,
    },
    exploits: results
      .filter((r) => REWARD_EXPLOITS.includes(r.name))
      .map((r) => ({
        name: r.name,
        score: r.scorePerMin.mean,
        climb: climb(r.scorePerMin.mean, full),
        ok: climb(r.scorePerMin.mean, full) <= GATE.exploitCeiling,
      })),
    // The unbraked twins, against the braked policy they are a copy of. See GATE.
    unbraked: results
      .filter((r) => ACTION_EXPLOITS.includes(r.name))
      .map((r) => ({
        name: r.name,
        score: r.scorePerMin.mean,
        excess: (r.scorePerMin.mean - oracle) / Math.abs(oracle),
        ok: (r.scorePerMin.mean - oracle) / Math.abs(oracle) <= GATE.exploitExcess,
      })),
  };
}

function printGap(g) {
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  const verdict = (ok) => (ok ? 'PASS' : 'FAIL');
  console.log('\nthe memory gap — Phase C exit check 1');
  console.log(`  oracle                       ${fx(g.oracle, 8)} /min`);
  console.log(`  reactive ceiling, obs        ${fx(g.full.ceiling, 8)}   (the plan's memoryless twin)`);
  console.log(
    `  gap, full                    ${fx(g.full.gap, 8)} = ${pct(g.full.frac).padStart(4)} of oracle` +
    `   vs ${pct(GATE.gapThreshold)}: ${verdict(g.full.ok)}`,
  );
  console.log('\n  diagnostic — reactiveTruth (the feed kept, every clock stripped). NOT a bound:');
  console.log('  it prices the duration tier alone, and goes negative on wild. See C5.');
  console.log(
    `  reactive ceiling, truth      ${fx(g.conservative.ceiling, 8)}` +
    `   gap ${fx(g.conservative.gap, 6)} = ${pct(g.conservative.frac).padStart(4)} of oracle`,
  );
  console.log(`\n  exit check 1: ${verdict(g.full.ok)}`);
  console.log('\nthe exploit bots — Phase C exit check 2');
  console.log(`  reward exploits: 0 = at the reactive ceiling, 1 = at the oracle; under ${pct(GATE.exploitCeiling)}`);
  for (const e of g.exploits) {
    console.log(`  ${e.name.padEnd(14)} ${fx(e.score, 8)}   ${pct(e.climb).padStart(6)}   ${verdict(e.ok)}`);
  }
  console.log(`  action exploits: the oracle with one brake off, vs the oracle; under ${pct(GATE.exploitExcess)}`);
  for (const e of g.unbraked) {
    console.log(`  ${e.name.padEnd(14)} ${fx(e.score, 8)}   ${pct(e.excess).padStart(6)}   ${verdict(e.ok)}`);
  }
  console.log(`\n  exit check 2: ${verdict([...g.exploits, ...g.unbraked].every((e) => e.ok))}`);
}

// ---- the CLI ----

const fx = (v, w = 8, d = 1) => v.toFixed(d).padStart(w);

function printTable(rows) {
  const head = [
    'policy'.padEnd(9), 'score/min'.padStart(10), '±se'.padStart(7),
    'view'.padStart(9), 'cost'.padStart(9),
    'cover'.padStart(7), 'tick-cov'.padStart(9),
    'late'.padStart(7), 'knock/m'.padStart(8), 'down%'.padStart(7),
  ].join(' ');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    console.log([
      r.name.padEnd(9),
      fx(r.scorePerMin.mean, 10),
      fx(r.scorePerMin.se, 7),
      fx(r.view.mean, 9, 0),
      fx(r.cost.mean, 9, 0),
      fx(r.coverage.mean * 100, 7),
      fx(r.tickCoverage.mean * 100, 9),
      fx(r.arrivalAge.mean, 7, 0),
      fx(r.knocksPerMin.mean, 8, 2),
      fx(r.groundedFrac.mean * 100, 7),
    ].join(' '));
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'json' || key === 'gate') { args[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    args[key] = value;
  }
  return args;
}

// `--rules viewRadius=240,knockPenalty=40` — the phase's actual working loop, so
// it has to be one flag rather than an edit-and-rerun. Unknown keys throw: a
// silently ignored knob is a wasted experiment.
export function parseRules(spec) {
  if (!spec) return {};
  const out = {};
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=');
    if (!(k in DEFAULT_RULES)) {
      throw new Error(`unknown rule: ${k} (have ${Object.keys(DEFAULT_RULES).join(', ')})`);
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`rule ${k} needs a number, got ${v}`);
    out[k] = n;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // `--gate` is the phase's headline run: the three yardsticks, the exploit bots,
  // and the incumbent to read them against.
  const gateSet = [...YARDSTICKS, 'expert', ...EXPLOITS];
  const names = args.gate ? gateSet : args.policy ? args.policy.split(',') : Object.keys(POLICIES);
  const opts = {
    spec: args.spec ?? DEFAULT_EVAL.spec,
    corpusSeed: args.seed === undefined ? DEFAULT_EVAL.corpusSeed : Number(args.seed),
    episodes: args.episodes === undefined ? DEFAULT_EVAL.episodes : Number(args.episodes),
    ticks: args.ticks === undefined ? DEFAULT_EVAL.ticks : Number(args.ticks),
    rules: parseRules(args.rules),
  };

  const results = names.map((name) => {
    const started = process.hrtime.bigint();
    const r = evaluatePolicy({ ...opts, policy: policyByName(name), name });
    r.seconds = Number(process.hrtime.bigint() - started) / 1e9;
    return r;
  });

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const [first] = results;
  console.log(
    `${opts.spec} × ${opts.episodes} episodes × ${opts.ticks} ticks ` +
    `(seed ${opts.corpusSeed}, game v${GAME_VERSION})`,
  );
  const changed = Object.entries(first.rules).filter(([k, v]) => DEFAULT_RULES[k] !== v);
  if (changed.length) console.log(`rules: ${changed.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log('');
  printTable(results);
  console.log('');
  console.log(
    'cover = incidents he showed up to; tick-cov = share of live incident-ticks in range;\n' +
    'late  = mean incident age on arrival, ticks (20/s).',
  );
  if (args.gate) {
    printGap(gapReport(results));
    // Exit check 3 lives in twins.js and is run from here so that `--gate` is the
    // whole gate rather than two of its three parts. It costs a fraction of a
    // second — the batteries are a few hundred ticks of a bare stage, not episodes.
    printCertificate(certifyReport({ rules: makeRules(opts.rules) }));
  }
  console.log(`\n${results.map((r) => `${r.name} ${r.seconds.toFixed(1)}s`).join('  ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
