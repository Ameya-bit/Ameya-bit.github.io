import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIERS, CERT, makeBattery, measurePair, measureArm, runBattery, certifyReport,
  identityPair, durationPair, unknowablePair,
} from '../twins.js';
import {
  QUIET, makeStage, addHat, addRoamer, runScenario, siteTracker, frameAt, frameDiff,
} from '../scenario.js';
import { policyByName } from '../policies.js';
import { hatOf } from '../rollout.js';
import { MODE, ANIM } from '../../assets/pandas/engine/state.js';
import { makeObserver } from '../../assets/pandas/engine/policy/obs.js';
import { ACTION, stepAction } from '../../assets/pandas/engine/actions.js';

const PAIRS = 6;
const TIER_NAMES = Object.keys(TIERS);

// ---- the stage ----

test('a constructed stage has all three directors asleep', () => {
  // The clocks are pushed past the end of time rather than the machinery bypassed,
  // so a scenario is a state `step` treats like any other. If a director ever fired
  // here, the twin would be carrying an event nobody asked for.
  const { engine, state } = makeStage();
  addHat(state, 400, 400, 2);
  addRoamer(state, 700, 400);
  const end = runScenario({ engine, state, ticks: 600, policy: { init: () => () => ACTION.HOLD } });
  assert.equal(end.incidents.length, 0);
  assert.equal(end.stack.baseId, -1);
  assert.equal(end.cascade.armed, false);
  assert.equal(end.cascade.active, false);
});

test('a parked roamer never moves and never draws from the sim PRNG', () => {
  // Both halves matter: a wandering extra would drift the two arms apart, and a
  // drawing one would drift their PRNG streams apart even if it stood still.
  const { engine, state } = makeStage();
  addHat(state, 400, 400, 2);
  const r = addRoamer(state, 700, 400);
  assert.equal(r.moveTimer, QUIET);
  const before = state.rng;
  const end = runScenario({ engine, state, ticks: 400, freezeUntil: 400, policy: { init: () => () => ACTION.HOLD } });
  assert.equal(end.rng, before);
  assert.equal(end.entities[1].x, 700);
  assert.equal(end.entities[1].y, 400);
});

test('frozen means the hand is held, not the eyes shut', () => {
  // The policy is consulted on every decision tick of the lead-in — so a policy
  // with memory has seen the whole history by its cue — and moves on none of them.
  const { engine, state } = makeStage();
  const hat = addHat(state, 400, 400, 2);
  addRoamer(state, 900, 400);
  const startX = hat.x;
  let consulted = 0;
  const walker = { init: () => () => { consulted += 1; return stepAction(2); } };
  const during = [];
  const end = runScenario({
    engine,
    state,
    ticks: 120,
    freezeUntil: 80,
    policy: walker,
    onTick: (s, t) => { if (t <= 80) during.push(hatOf(s).x); },
  });
  assert.equal(consulted, 60, 'the policy should be consulted on every decision tick');
  assert.ok(during.every((x) => x === startX), 'the hat moved during the lead-in');
  assert.ok(hatOf(end).x > startX, 'the hat never moved after the freeze lifted');
});

// ---- the identity claim the whole battery rests on ----

for (const tier of TIER_NAMES) {
  test(`${tier}: every pair's two arms encode to identical bytes at the decision tick`, () => {
    const observer = makeObserver();
    for (const p of makeBattery(tier, PAIRS)) {
      const a = frameAt({ build: () => p.arm('hot'), decideAt: p.decideAt });
      const b = frameAt({ build: () => p.arm('cold'), decideAt: p.decideAt });
      const diff = frameDiff(a, b, observer.layout);
      assert.equal(diff, null, `${p.id}: ${diff && `${diff.field} on token ${diff.token}: ${diff.a} vs ${diff.b}`}`);
    }
  });
}

test('the frame check would catch a break, and names the field that moved', () => {
  // The certificate is only worth its check. Move one arm's subject a single pixel
  // and the diff must find it — otherwise "the twins are twins" is decoration.
  const p = identityPair(0);
  const observer = makeObserver();
  const a = frameAt({ build: () => p.arm('hot'), decideAt: p.decideAt });
  const nudged = frameAt({
    build: () => {
      const built = p.arm('cold');
      const subject = built.state.entities[1];
      subject.x += 1;
      subject.lx += 1;
      subject.gtx += 1;
      return built;
    },
    decideAt: p.decideAt,
  });
  const diff = frameDiff(a, nudged, observer.layout);
  assert.notEqual(diff, null, 'a displaced twin went unnoticed');
  assert.equal(diff.token, 1);
  assert.ok(['relX', 'relY', 'dist'].includes(diff.field), `unexpected field ${diff.field}`);
});

test('a broken twin fails loudly rather than reporting a serene zero', () => {
  const p = identityPair(0);
  const broken = { ...p, arm: (which) => {
    const built = p.arm(which);
    if (which === 'cold') {
      // The logical position and the glide's target move with the drawn one —
      // nudging `x` alone would be quietly undone by the next tick's ease.
      const e = built.state.entities[1];
      e.x += 40;
      e.lx += 40;
      e.gtx += 40;
    }
    return built;
  } };
  assert.throws(
    () => measurePair(broken, policyByName('oracle')),
    /the twins are not twins/,
  );
});

// ---- what each tier is actually testing ----

test('identity: the subject lies on the same pixel in both arms, by different routes', () => {
  const p = identityPair(3);
  const sub = (which) => {
    const { engine, state, script } = p.arm(which);
    const end = runScenario({
      engine, state, script, ticks: p.decideAt, freezeUntil: p.decideAt,
      policy: { init: () => () => ACTION.HOLD },
    });
    return end.entities[1];
  };
  const hot = sub('hot');
  const cold = sub('cold');
  // Same picture…
  assert.equal(hot.x, cold.x);
  assert.equal(hot.y, cold.y);
  assert.equal(hot.anim, ANIM.FALLEN);
  assert.equal(cold.anim, ANIM.FALLEN);
  assert.equal(hot.dir, cold.dir);
  // …different worlds. The knock slid its victim `impact` px into place; the
  // sleeper lay down where it stood, and only one of them is a paying incident.
  assert.equal(hot.mode, MODE.SLEEPER);
  assert.equal(cold.mode, MODE.KNOCKED);
  assert.equal(Math.abs(cold.slideVx) + Math.abs(cold.slideVy), 85);
});

test('identity: only the sleeper arm posts an incident — ordinary knocks pay nothing', () => {
  const p = identityPair(0);
  const incidents = (which) => {
    const { engine, state, script } = p.arm(which);
    const end = runScenario({
      engine, state, script, ticks: p.decideAt, freezeUntil: p.decideAt,
      policy: { init: () => () => ACTION.HOLD },
    });
    return end.incidents.length;
  };
  assert.equal(incidents('hot'), 1);
  assert.equal(incidents('cold'), 0);
});

test('duration: both arms are napping, and only the clock separates them', () => {
  const p = durationPair(1);
  const sub = (which) => {
    const { engine, state, script } = p.arm(which);
    const end = runScenario({
      engine, state, script, ticks: p.decideAt, freezeUntil: p.decideAt,
      policy: { init: () => () => ACTION.HOLD },
    });
    return { e: end.entities[1], inc: end.incidents[0], tick: end.tick };
  };
  const hot = sub('hot');
  const cold = sub('cold');
  assert.equal(hot.e.mode, MODE.SLEEPER);
  assert.equal(cold.e.mode, MODE.SLEEPER);
  assert.equal(hot.e.anim, cold.e.anim);
  // The hidden difference, in the two quantities the anticipation economy is made
  // of: how long it has left, and how late he already is.
  assert.equal(cold.e.aTimer, 30);
  assert.ok(hot.e.aTimer > 300, `fresh nap had ${hot.e.aTimer} ticks left`);
  assert.ok(hot.tick - hot.inc.born < 30);
  assert.ok(cold.tick - cold.inc.born > 250);
});

test('unknowable: the armed arm really does erupt, and the unarmed one never does', () => {
  // Without this the negative control degenerates into two identical worlds, where
  // a zero means nothing at all.
  const p = unknowablePair(0);
  const hot = measureArm(p, 'hot', policyByName('oracle'));
  const cold = measureArm(p, 'cold', policyByName('oracle'));
  assert.equal(hot.ignited, true);
  assert.equal(cold.ignited, false);
});

// ---- the verdicts ----

test('the oracle tells the twins apart on both knowable tiers', () => {
  for (const tier of ['identity', 'duration']) {
    const r = runBattery({ tier, policy: policyByName('oracle'), name: 'oracle', pairs: PAIRS });
    assert.ok(
      r.discrimination >= CERT.discriminate,
      `oracle scored ${r.discrimination.toFixed(2)} on ${tier}`,
    );
    assert.ok(r.hotApproach > r.coldApproach);
  }
});

test('the memoryless twin cannot tell the flagship pair apart — and goes to both', () => {
  const r = runBattery({ tier: 'identity', policy: policyByName('reactiveObs'), name: 'reactiveObs', pairs: PAIRS });
  assert.ok(Math.abs(r.discrimination) <= CERT.blind, `d = ${r.discrimination}`);
  // The distinction that matters: it is blind because it walks to *both*, not
  // because it is too timid to walk anywhere. A zero from a policy that never
  // moves would be the same number about a different failure.
  assert.ok(r.hotApproach > 0.5 && r.coldApproach > 0.5,
    `hot ${r.hotApproach} cold ${r.coldApproach}`);
  assert.equal(r.diverged, 0, 'a memoryless policy behaved differently on identical frames');
});

test('the conservative ceiling passes the identity tier and fails the duration one', () => {
  // The split that makes the battery worth having: `reactiveTruth` keeps the feed
  // (so it knows *which*) and loses every temporal quantity (so it cannot know
  // *how long*). That is exactly the boundary between the two knowable tiers.
  const id = runBattery({ tier: 'identity', policy: policyByName('reactiveTruth'), pairs: PAIRS });
  const dur = runBattery({ tier: 'duration', policy: policyByName('reactiveTruth'), pairs: PAIRS });
  assert.ok(id.discrimination >= CERT.discriminate, `identity d = ${id.discrimination}`);
  assert.ok(Math.abs(dur.discrimination) <= CERT.blind, `duration d = ${dur.discrimination}`);
});

test('nobody moves a muscle differently on the unknowable tier', () => {
  for (const name of ['oracle', 'reactiveTruth', 'reactiveObs', 'expert']) {
    const r = runBattery({ tier: 'unknowable', policy: policyByName(name), name, pairs: PAIRS });
    assert.equal(r.diverged, 0, `${name} behaved differently on an unobservable difference`);
    assert.equal(r.discrimination, 0);
  }
});

test('exit check 3 passes, and every tier reports a verdict for every named arm', () => {
  const rep = certifyReport({ pairs: PAIRS });
  assert.equal(rep.ok, true);
  assert.equal(rep.tiers.length, TIER_NAMES.length);
  for (const t of rep.tiers) {
    assert.ok(t.arms.length >= 3);
    for (const a of t.arms) {
      assert.ok(a.role, `${t.tier}/${a.name} has no role`);
      assert.equal(a.ok, true, `${t.tier}/${a.name} failed`);
    }
  }
});

// ---- the instrument itself ----

test('a scenario is a pure function of its build — same arm, same numbers', () => {
  const p = identityPair(2);
  const a = measureArm(p, 'hot', policyByName('oracle'));
  const b = measureArm(p, 'hot', policyByName('oracle'));
  assert.deepEqual(a.actions, b.actions);
  assert.equal(a.approach, b.approach);
  assert.equal(a.attend, b.attend);
});

test('approach is 0 for a policy that never leaves and 1 for one that arrives', () => {
  const p = identityPair(0);
  const parked = measureArm(p, 'hot', policyByName('still'));
  const walked = measureArm(p, 'hot', policyByName('oracle'));
  assert.equal(parked.approach, 0);
  assert.equal(parked.minDist, parked.startDist);
  assert.equal(walked.approach, 1);
  assert.ok(walked.attend > 0, 'he arrived but was never paid for standing there');
});

test('the site tracker only counts ticks inside its window', () => {
  const track = siteTracker({ x: 0, y: 0 }, { from: 10, to: 20, viewRadius: 100 });
  const at = (x) => ({ entities: [{ hasHat: true, x, y: 0 }] });
  track.tick(at(500), 5); // before
  for (let t = 10; t <= 20; t++) track.tick(at(50), t);
  track.tick(at(500), 25); // after
  const r = track.report();
  assert.equal(r.ticks, 11);
  assert.equal(r.inRadius, 11);
  assert.equal(r.startDist, 50);
});
