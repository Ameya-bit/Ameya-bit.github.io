// The twin-episode battery — Phase C's third exit check.
//
// C3 of design/panda-policy-net.md. The first two checks are differences of
// *scores*: how much is a piece of information worth, averaged over the eval
// corpus. This one is a difference of *behaviour* on a matched pair, and it answers
// a question a score cannot:
//
//   Can this policy tell these two situations apart at all?
//
// The plan's own words: "matched episode pairs identical in every current
// observable, differing only in hidden history. A policy that approaches one and
// ignores the other has *behaviorally proven* the inference, no probes required.
// One battery per knowability tier."
//
// So there are three batteries, one per tier of the knowability spine, and each is
// a set of matched pairs built by `scenario.js`:
//
//   identity   (fully inferable)      a sleeper vs a panda that was just run over
//   duration   (statistically inf.)   a fresh nap vs one that is nearly over
//   unknowable (provably uninferable) a cascade armed vs not armed — the negative
//                                     control, where every policy must score zero
//
// ## What a pair is, mechanically
//
// Two arms, `hot` and `cold`, that agree on **every byte the observation encoder
// emits** at the decision tick — asserted per pair, per run, by re-running both
// arms with the hat held still and diffing the frames — and disagree on what is
// worth walking to. The hat is frozen through the lead-in but the policy is
// consulted throughout, so a policy with memory has seen the whole history by the
// time it is allowed to move. Then it is released for `windowTicks` and we measure
// how much of the distance to the site it closed.
//
//   discrimination = approach(hot) - approach(cold)     in [-1, 1]
//
// A policy that walks to both, or to neither, scores 0 — which is the honest
// verdict on a policy that cannot tell them apart, and is exactly what the
// memoryless arms are expected to produce.
//
// ## Two things this battery is careful NOT to claim
//
// **It is a controlled experiment, not an episode.** The stage is bare, the
// directors are asleep and the hat is frozen until his cue. That is the point — a
// certificate has to be decidable — but it means the numbers here are not
// comparable to `evaluate.js`'s and must never be quoted as scores.
//
// **The knock arm has no collider on stage.** A real contact knocks *both* bodies,
// and matching two arms through a mutual knock would mean matching two subjects
// instead of one. What is kept is the tell that actually carries the information:
// an ordinary knock **slides** its victim `impact` px away from the struck side
// across the fall cels, and a sleeper lies down where it stood. Those 17 ticks are
// the whole of the difference, they are on screen in both arms, and from the tick
// the fall ends the two worlds are the same picture.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { TICKS_PER_ACTION } from '../assets/pandas/engine/tick.js';
import { ANOMALY_KINDS, startAnomaly } from '../assets/pandas/engine/anomalies.js';
import { beginKnock } from '../assets/pandas/engine/state.js';
import { emitIncident } from '../assets/pandas/engine/director.js';
import { AX, AY, dirName } from '../assets/pandas/engine/dirs.js';
import { Rng } from '../assets/pandas/engine/rng.js';
import { makeObserver } from '../assets/pandas/engine/policy/obs.js';
import {
  STAGE, makeStage, addHat, addRoamer, runScenario, siteTracker, frameAt, frameDiff,
} from './scenario.js';
import { hatOf } from './rollout.js';
import { DEFAULT_RULES } from './game.js';
import { policyByName, POLICIES } from './policies.js';

const SLEEPER = ANOMALY_KINDS.indexOf('sleeper');
const STARER = ANOMALY_KINDS.indexOf('starer');

// ---- the certificate's thresholds ----

export const CERT = Object.freeze({
  // What counts as "approaches one and ignores the other". A policy walking the
  // whole way to the hot arm and not moving on the cold one scores 1; this asks for
  // a quarter of that, which at these distances is the difference between setting
  // off and not.
  discriminate: 0.25,
  // …and what counts as blind. Not zero: a policy can be nudged off by a tick of
  // stride-cadence phase without having learned anything. Anything under this is
  // noise, not knowledge.
  blind: 0.08,
});

// ---- geometry ----

const HAT = Object.freeze({ x: 570, y: 420 });
const CENTRE = Object.freeze({ x: STAGE.width / 2, y: STAGE.height / 2 });

// The subject's resting place for pair `i`: a bearing off the 8 sprite axes at one
// of three distances. Rounded to whole pixels, which is not cosmetic — the knocked
// twin reaches this spot by adding `impact / fallTicks` seventeen times, and only
// integers make that land on the pixel exactly.
function siteFor(i) {
  const bearing = i % 8;
  const dist = 300 + (i % 3) * 40;
  return {
    bearing,
    dist,
    x: Math.round(HAT.x + AX[bearing] * dist),
    y: Math.round(HAT.y + AY[bearing] * dist),
  };
}

// Which side the shove comes from. Always the side facing the middle of the stage,
// so the knocked twin's pre-slide position — 85px further that way — is never
// outside the walls, where `applyPos` would clamp it and the two arms would land on
// different pixels.
function shoveDir(site) {
  const dx = CENTRE.x - site.x;
  const dy = CENTRE.y - site.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 2 : 6) : (dy >= 0 ? 4 : 0);
}

// The slide `startKnock` would produce for a contact from `hit` — the same
// expression, kept here because a scenario has to place the body *before* the
// engine moves it, and re-deriving it is the only way to know where it will land.
function slideOf(hit, cfg) {
  const name = dirName(hit);
  return {
    vx: (name.includes('left') ? cfg.impact : 0) - (name.includes('right') ? cfg.impact : 0),
    vy: (name.includes('up') ? cfg.impact : 0) - (name.includes('down') ? cfg.impact : 0),
  };
}

// The first decision tick at or after `t`. The policy is only consulted on the 10 Hz
// clock, so a decision tick is the only place a frame comparison means anything.
const onClock = (t) => t + ((TICKS_PER_ACTION - (t % TICKS_PER_ACTION)) % TICKS_PER_ACTION);

// How long a fall plays for on this stage. Read off the config rather than written
// down: every decision tick in this file is "the tick the fall finishes", and a
// hardcoded 17 would go quietly wrong the day `fallTicks` moves.
const FALL_TICKS = makeStage().cfg.fallTicks;

// ---- tier 1: identity — the flagship ----

// A sleeper and a panda that was just run over, lying in the same cels on the same
// pixel with the same facing. One is a live tier-1 incident worth every point in
// the window; the other is worth nothing, because **ordinary knocks pay nothing**
// (game.js) — which is the rule that gives this certificate its teeth.
//
// The only difference on screen is a fall's worth of ticks old by the time the
// policy may move: the knocked one slid 85px into place, the sleeper lay down
// where it stood.
export function identityPair(i, opts = {}) {
  const lead = 60;
  const window = opts.window ?? 90;
  const nap = 400; // long enough that the sleeper is still down at the window's end
  const lie = 100; // …and so is the knocked one, so neither arm gives itself away

  const site = siteFor(i);
  const hit = shoveDir(site);

  const build = (arm) => () => {
    const { engine, state, cfg } = makeStage({}, 1000 + i);
    addHat(state, HAT.x, HAT.y, site.bearing);
    const slide = slideOf(hit, cfg);
    // The knocked twin starts where the shove found it; the sleeper starts where it
    // will still be lying. Both end the fall on `site`.
    const from = arm === 'hot'
      ? { x: site.x, y: site.y }
      : { x: site.x - slide.vx, y: site.y - slide.vy };
    addRoamer(state, from.x, from.y, { dir: hit });
    const rng = new Rng(0x5eed ^ i); // the scenario's own stream — never the sim's

    const script = (s, t) => {
      if (t !== lead) return;
      const subject = s.entities[1];
      if (arm === 'hot') {
        startAnomaly(subject, SLEEPER, cfg, rng);
        subject.aLie = nap; // pin the nap: a drawn one would differ between runs
        // …and re-derive the TTL from the pinned nap rather than keeping the one
        // `startAnomaly` returned, which was computed from the draw we discarded.
        emitIncident(s, subject.id, 1, cfg.fallTicks + nap + cfg.standTicks + cfg.aftermathLinger);
      } else {
        beginKnock(subject, cfg, rng, { faceDir: hit, slideVx: slide.vx, slideVy: slide.vy });
        subject.knockLie = lie;
      }
    };
    return { engine, state, script };
  };

  return pair({
    tier: 'identity',
    index: i,
    describe: `a sleeper vs a panda just run over, ${site.dist}px ${dirName(site.bearing)}`,
    hot: 'sleeper (pays)',
    cold: 'knocked (pays nothing)',
    decideAt: onClock(lead + FALL_TICKS),
    window,
    site,
    build,
  });
}

// ---- tier 2: duration — the statistically inferable tier ----

// Two sleepers in the same cels on the same pixel. One lay down a moment ago and
// has 400 ticks of nap left; the other has been down for fifteen seconds of sim
// time and has 30 — less than the walk takes, so the trip cannot pay. Nothing in the
// current frame separates them; the answer is how long it has been lying there.
//
// This is the tier C2 found toothless in the wild (`reactiveTruth`, which keeps the
// feed and loses every temporal quantity, scored within 5% of the oracle). The
// battery is the instrument that says *why*: not that the information is
// undecidable, but that the live distribution rarely forces the choice. Here it is
// forced, and the two arms separate.
export function durationPair(i, opts = {}) {
  const window = opts.window ?? 90;
  const lead = 300; // the stale sleeper has been down since the first tick
  const decideAt = onClock(lead + FALL_TICKS);
  const fresh = 400;
  const stale = 30; // …ticks left: under the travel time from anywhere on this stage

  const site = siteFor(i);
  // Both arms lie exactly here, so the facing has to be pinned by hand: nothing in
  // a nap sets it, and a mismatched facing is a mismatched one-hot.
  const facing = shoveDir(site);

  const build = (arm) => () => {
    const { engine, state, cfg } = makeStage({}, 2000 + i);
    addHat(state, HAT.x, HAT.y, site.bearing);
    addRoamer(state, site.x, site.y, { dir: facing });
    const rng = new Rng(0xbeef ^ i);

    // `aTimer` counts the nap down from the tick the fall ends, so the nap that
    // leaves `left` ticks on the clock at `decideAt` is a subtraction, not a guess.
    const napFor = (at, left) => left + decideAt - at - cfg.fallTicks;
    const at = arm === 'hot' ? lead : 1;
    const nap = arm === 'hot' ? fresh : napFor(1, stale);

    const script = (s, t) => {
      if (t !== at) return;
      const subject = s.entities[1];
      startAnomaly(subject, SLEEPER, cfg, rng);
      subject.aLie = nap;
      subject.dir = facing;
      emitIncident(s, subject.id, 1, cfg.fallTicks + nap + cfg.standTicks + cfg.aftermathLinger);
    };
    return { engine, state, script };
  };

  return pair({
    tier: 'duration',
    index: i,
    describe: `a fresh nap vs one with ${stale} ticks left, ${site.dist}px ${dirName(site.bearing)}`,
    hot: `fresh (${fresh} ticks left)`,
    cold: `stale (${stale} ticks left)`,
    decideAt,
    window,
    site,
    build,
  });
}

// ---- tier 3: unknowable — the negative control ----

// The cascade's arming clock has **zero observable signature**: while armed the sim
// behaves exactly as it does unarmed, right up until a collision escalates. So the
// two arms of this pair are the same world in every byte — the same starer to
// watch, the same pair of bodies across the stage — and differ only in a boolean
// that decides whether those distant bodies are about to go down like dominoes.
//
// Every policy must score zero here. A nonzero number is not a finding about the
// world; it is leakage, in the percept or in the harness, and the plan says so:
// "a probe that 'finds' it is finding leakage."
//
// The stakes are made real rather than notional: the armed arm carries a `forceAt`
// four ticks past the window, so the jackpot genuinely fires — and the battery
// checks that it did, so the control cannot quietly degrade into two identical
// worlds with nothing to distinguish.
export function unknowablePair(i, opts = {}) {
  const lead = 40;
  const window = opts.window ?? 90;
  const decideAt = onClock(lead + 20);
  const stare = 800;

  // Something to do, near the hat; and the cluster the cascade would erupt in, far
  // enough away that `forceIgnite`'s "farthest standing roamer from the watcher"
  // can only be one of them.
  const near = { x: Math.round(HAT.x + AX[i % 8] * 300), y: Math.round(HAT.y + AY[i % 8] * 300) };
  const far = {
    x: Math.round(HAT.x - AX[i % 8] * 480),
    y: Math.round(HAT.y - AY[i % 8] * 480),
  };
  const site = { ...far, bearing: (i + 4) % 8, dist: 480 };

  const build = (arm) => () => {
    const { engine, state, cfg } = makeStage({}, 3000 + i);
    addHat(state, HAT.x, HAT.y, i % 8);
    addRoamer(state, near.x, near.y, { dir: 0 });
    addRoamer(state, far.x, far.y, { dir: 0 });
    addRoamer(state, far.x + 90, far.y + 40, { dir: 0 });
    const rng = new Rng(0xfeed ^ i);

    const script = (s, t) => {
      if (t === 1) {
        const subject = s.entities[1];
        startAnomaly(subject, STARER, cfg, rng);
        subject.aTimer = stare; // pinned, so both arms hold the same clock
        emitIncident(s, subject.id, 1, stare + cfg.aftermathLinger);
        if (arm === 'hot') {
          s.cascade.armed = true;
          s.cascade.forceAt = decideAt + window + 4;
        }
      }
    };
    return { engine, state, script };
  };

  return pair({
    tier: 'unknowable',
    index: i,
    describe: 'a cascade armed vs not armed — no observable difference, by construction',
    hot: 'armed (erupts just after the window)',
    cold: 'never armed',
    decideAt,
    window,
    site,
    // Run past the window so the armed arm actually ignites: a negative control
    // whose two arms have the same future is not a control at all.
    tail: 8,
    premise: (hot, cold) => {
      if (!hot.ignited) throw new Error('unknowable: the armed arm never ignited — the two arms share a future');
      if (cold.ignited) throw new Error('unknowable: the unarmed arm ignited — something armed it');
    },
    build,
  });
}

// ---- a pair, and how one is measured ----

function pair(spec) {
  const ticks = spec.decideAt + spec.window + (spec.tail ?? 0);
  return {
    ...spec,
    id: `${spec.tier}#${spec.index}`,
    ticks,
    arm: (which) => spec.build(which)(),
  };
}

// Run one arm and report what the hat did about the site — plus the exact action he
// applied on every decision tick of the window. The trace is what makes the
// negative control sharp: two arms that agree on every observable byte must, for a
// deterministic policy, produce the same actions, and a single differing action is
// leakage no aggregate statistic would have caught.
export function measureArm(p, which, policy, rules = DEFAULT_RULES) {
  const { engine, state, script } = p.arm(which);
  const track = siteTracker(p.site, {
    from: p.decideAt,
    to: p.decideAt + p.window,
    viewRadius: rules.viewRadius,
  });
  const actions = [];
  const end = runScenario({
    engine,
    state,
    policy,
    rules,
    script,
    ticks: p.ticks,
    freezeUntil: p.decideAt - 1,
    onTick: (s, t) => {
      track.tick(s, t);
      if (t >= p.decideAt && t <= p.decideAt + p.window && t % TICKS_PER_ACTION === 0) {
        actions.push(hatOf(s).action);
      }
    },
  });
  return {
    ...track.report(),
    actions,
    // Did the tier-3 machinery actually fire? Only the unknowable pair cares, and
    // it cares a lot: a control whose two arms turn out to have the same future is
    // not a control.
    ignited: end.cascade.active || end.cascade.endAt >= 0,
  };
}

// The first decision tick at which the two arms' actions differ, or null if the
// policy behaved identically throughout the window.
function divergenceOf(p, hot, cold) {
  const n = Math.min(hot.actions.length, cold.actions.length);
  for (let i = 0; i < n; i++) {
    if (hot.actions[i] !== cold.actions[i]) return p.decideAt + i * TICKS_PER_ACTION;
  }
  return hot.actions.length === cold.actions.length ? null : p.decideAt + n * TICKS_PER_ACTION;
}

// The per-pair certificate. The frame identity is re-derived here, on every run,
// rather than assumed from the geometry: the claim the whole battery rests on is
// "these two are the same picture", and a claim nobody checks is a claim that is
// one refactor away from being false.
export function measurePair(p, policy, rules = DEFAULT_RULES) {
  const observer = makeObserver();
  const a = frameAt({ build: () => p.arm('hot'), decideAt: p.decideAt });
  const b = frameAt({ build: () => p.arm('cold'), decideAt: p.decideAt });
  const diff = frameDiff(a, b, observer.layout);
  if (diff) {
    throw new Error(
      `${p.id}: the twins are not twins — token ${diff.token} field ${diff.field} ` +
      `is ${diff.a} in the hot arm and ${diff.b} in the cold one`,
    );
  }
  const hot = measureArm(p, 'hot', policy, rules);
  const cold = measureArm(p, 'cold', policy, rules);
  // The pair's own premise — that the two arms really are two different worlds —
  // is checked before its verdict is believed. A twin that has quietly become one
  // world would report a serene zero from every policy.
  if (p.premise) p.premise(hot, cold);
  return {
    id: p.id,
    tier: p.tier,
    describe: p.describe,
    hot,
    cold,
    discrimination: hot.approach - cold.approach,
    attendGap: hot.attend - cold.attend,
    divergeAt: divergenceOf(p, hot, cold),
  };
}

// ---- the batteries ----

// What the certificate demands of each named arm:
//
//   discriminate  d >= CERT.discriminate — it tells the twins apart
//   blind         |d| <= CERT.blind — it does not
//   identical     stricter than blind: not one action differed, on any pair. Only
//                 the unknowable tier asks for this, and only it can: there the two
//                 arms agree on every observable byte for the whole window, so a
//                 deterministic policy has nothing to be different about.
export const TIERS = Object.freeze({
  identity: {
    make: identityPair,
    knowability: 'fully inferable',
    expect: { oracle: 'discriminate', reactiveTruth: 'discriminate', reactiveObs: 'blind' },
  },
  duration: {
    make: durationPair,
    knowability: 'statistically inferable',
    expect: { oracle: 'discriminate', reactiveTruth: 'blind', reactiveObs: 'blind' },
  },
  unknowable: {
    make: unknowablePair,
    knowability: 'provably uninferable',
    expect: { oracle: 'identical', reactiveTruth: 'identical', reactiveObs: 'identical' },
  },
});

export const DEFAULT_PAIRS = 12;

export function makeBattery(tier, pairs = DEFAULT_PAIRS, opts = {}) {
  const t = TIERS[tier];
  if (!t) throw new Error(`unknown tier: ${tier} (have ${Object.keys(TIERS).join(', ')})`);
  return Array.from({ length: pairs }, (_, i) => t.make(i, opts));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function runBattery({ tier, policy, name = 'policy', pairs = DEFAULT_PAIRS, rules = DEFAULT_RULES, opts = {} }) {
  const battery = makeBattery(tier, pairs, opts);
  const results = battery.map((p) => measurePair(p, policy, rules));
  const ds = results.map((r) => r.discrimination);
  return {
    tier,
    name,
    pairs: results.length,
    discrimination: mean(ds),
    // How often it went the right way at all — a mean of 0.3 could be one pair
    // going all the way or every pair going a third of it, and those are different
    // findings.
    decided: results.filter((r) => r.discrimination >= CERT.discriminate).length / results.length,
    hotApproach: mean(results.map((r) => r.hot.approach)),
    coldApproach: mean(results.map((r) => r.cold.approach)),
    // Pairs on which the policy's action stream differed between the arms at all.
    diverged: results.filter((r) => r.divergeAt !== null).length,
    min: Math.min(...ds),
    max: Math.max(...ds),
    results,
  };
}

function verdictFor(role, r) {
  if (role === 'discriminate') return r.discrimination >= CERT.discriminate;
  if (role === 'blind') return Math.abs(r.discrimination) <= CERT.blind;
  if (role === 'identical') return r.diverged === 0;
  return null;
}

// ---- exit check 3 ----

// The plan's wording: "the oracle passes the twin-episode battery; the reactive
// twin fails it." Made arithmetic, per tier, against the roles in `TIERS.expect`.
export function certifyReport({ pairs = DEFAULT_PAIRS, rules = DEFAULT_RULES, policies = null } = {}) {
  const tiers = Object.entries(TIERS).map(([tier, t]) => {
    const names = policies ?? Object.keys(t.expect);
    const arms = names.map((name) => {
      const r = runBattery({ tier, policy: policyByName(name), name, pairs, rules });
      const role = t.expect[name] ?? null;
      return { ...r, role, ok: verdictFor(role, r) };
    });
    return {
      tier,
      knowability: t.knowability,
      arms,
      ok: arms.every((a) => a.ok !== false),
    };
  });
  return { pairs, tiers, ok: tiers.every((t) => t.ok) };
}

// ---- the CLI ----

const fx = (v, w = 7, d = 2) => v.toFixed(d).padStart(w);

export function printCertificate(rep) {
  console.log(`\nthe twin-episode battery — Phase C exit check 3   (${rep.pairs} pairs per tier)`);
  console.log(
    `  d = approach(hot) - approach(cold), in closable-distance units.  ` +
    `discriminate: d >= ${CERT.discriminate.toFixed(2)}   blind: |d| <= ${CERT.blind.toFixed(2)}   ` +
    `identical: no action differed`,
  );
  for (const t of rep.tiers) {
    console.log(`\n  ${t.tier}  (${t.knowability})`);
    console.log(
      `    ${'policy'.padEnd(14)}${'d'.padStart(7)}${'hot'.padStart(7)}${'cold'.padStart(7)}` +
      `${'decided'.padStart(9)}${'split'.padStart(7)}   must          verdict`,
    );
    for (const a of t.arms) {
      console.log(
        `    ${a.name.padEnd(14)}${fx(a.discrimination)}${fx(a.hotApproach)}${fx(a.coldApproach)}` +
        `${fx(a.decided * 100, 8, 0)}%${`${a.diverged}/${a.pairs}`.padStart(7)}   ${(a.role ?? '—').padEnd(14)}` +
        `${a.ok === null ? '' : a.ok ? 'PASS' : 'FAIL'}`,
      );
    }
  }
  console.log(`\n  exit check 3: ${rep.ok ? 'PASS' : 'FAIL'}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'json' || key === 'verbose') { args[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    args[key] = value;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pairs = args.pairs === undefined ? DEFAULT_PAIRS : Number(args.pairs);
  const policies = args.policy ? args.policy.split(',') : null;

  if (args.tier) {
    const names = policies ?? Object.keys(POLICIES);
    const rows = names.map((name) =>
      runBattery({ tier: args.tier, policy: policyByName(name), name, pairs }));
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`\n${args.tier} — ${TIERS[args.tier].knowability}, ${pairs} pairs`);
    console.log(`  ${'policy'.padEnd(14)}${'d'.padStart(7)}${'hot'.padStart(7)}${'cold'.padStart(7)}${'min'.padStart(7)}${'max'.padStart(7)}${'split'.padStart(7)}`);
    for (const r of rows) {
      console.log(`  ${r.name.padEnd(14)}${fx(r.discrimination)}${fx(r.hotApproach)}${fx(r.coldApproach)}${fx(r.min)}${fx(r.max)}${`${r.diverged}/${r.pairs}`.padStart(7)}`);
    }
    if (args.verbose) {
      for (const r of rows) {
        console.log(`\n  ${r.name}`);
        for (const x of r.results) {
          console.log(
            `    ${x.id.padEnd(14)} d=${fx(x.discrimination)}  hot ${fx(x.hot.approach)}/${fx(x.hot.attend)}` +
            `  cold ${fx(x.cold.approach)}/${fx(x.cold.attend)}  split@${String(x.divergeAt ?? '—').padStart(4)}   ${x.describe}`,
          );
        }
      }
    }
    return;
  }

  const rep = certifyReport({ pairs, policies });
  if (args.json) { console.log(JSON.stringify(rep, null, 2)); return; }
  printCertificate(rep);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
