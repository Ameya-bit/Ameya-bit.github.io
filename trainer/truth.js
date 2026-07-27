// Ground truth — the hidden half of every recorded tick.
//
// B3 of design/panda-policy-net.md. The observation encoder is deliberately blind:
// it records the drawn picture and nothing else. This records everything it refused
// — every anomaly's kind, sub-phase and timers, the director's clock, the stack
// machine, the cascade's arming flag and its claims, plus the rules expert's own
// attention — so that Phase G can ask a probe "is the panda in slot 3 a sleeper,
// and how much nap is left?" and have a right answer to score against.
//
// Nothing here ever reaches a policy. It is labels, not features. (It is also the
// oracle's input in Phase C, which is why the true positions and cadences are in
// here alongside the FSM state: the privileged upper bound reads exactly this.)
//
// ## Two passes, because the interesting labels are about the future
//
// "Kind" and "phase" are readable off one tick. **Time-remaining is not** — and it
// is the tier the whole anticipation economy rests on ("will the nap outlast my
// walk?"). Deriving it from the FSM's constants would mean re-implementing
// anomalies.js in a second place and still getting it wrong: a zoomies ends early
// when it finds a wall, a spinner draws its stagger count only when the spin ends.
//
// So the truth is built in two passes over the *same* episode, which determinism
// makes free: pass one (`scanEpisode`) walks every tick and records only where each
// panda's behaviour changed — a compact timeline of spans, a few hundred numbers.
// Pass two re-runs the episode and emits full rows, looking `age` / `ttl` /
// `nextMode` up in that timeline. Exact by construction, no duplicated arithmetic,
// and pass two re-checks each panda's mode against the span it lands in, so a
// mismatch is an exception rather than a quietly poisoned label.

import { runEpisode, hatOf, DEFAULT_ROLLOUT } from './rollout.js';
import { MODE_NAME } from '../assets/pandas/engine/state.js';
import { ANOMALY_KINDS } from '../assets/pandas/engine/anomalies.js';
import { topIncident } from '../assets/pandas/engine/watcher.js';
import { OBS_FIELDS, OBS_WIDTH } from '../assets/pandas/engine/policy/obs.js';

export const TRUTH_VERSION = 1;

// The record schemas, as ordered field lists. B4 writes these into the corpus
// manifest and lays the columns out in this order; a unit test asserts the records
// carry exactly these keys, so the manifest cannot drift from the data.
export const GLOBAL_FIELDS = Object.freeze([
  'tick',
  // tier 1 — the anomaly director
  'nextAnomalyIn', 'lastKind', 'incidents', 'topTier', 'topSubject',
  // tier 2 — the stack machine
  'stackBase', 'stackPhase', 'stackRiders', 'stackFormsIn',
  // tier 3 — the cascade machine
  'cascadeArmed', 'cascadeActive', 'cascadeArmsIn', 'cascadeIgnitesIn',
  'cascadeFelled', 'cascadeTarget', 'cascadeClaims', 'cascadePending',
  // the rules expert's attention — a label, never an input
  'expertSubject', 'expertIncident', 'expertStandoff', 'expertRelocating',
]);

export const ENTITY_FIELDS = Object.freeze([
  'id', 'mode', 'anim', 'dir',
  // true position + the hidden gait
  'x', 'y', 'lx', 'ly', 'moveSpeed', 'moveTimer',
  // the anomaly FSM's scratch — kind is `mode`, this is where it is inside it
  'aPhase', 'aTimer', 'aCount', 'aHeading', 'aLie', 'aStep',
  // the knock FSM
  'knockPhase', 'knockTimer', 'knockLie',
  // roles + set-piece flags
  'oblivious', 'solid', 'flying', 'riding', 'entering', 'stackLevel',
  'cascadeFall', 'claimed',
  // the oblivious one's patch (-1, -1 for everyone else)
  'homeX', 'homeY',
  // backfilled from the timeline — see the header
  'age', 'ttl', 'nextMode',
]);

// The observation↔truth join, one row per observation token. `slot` is the token
// index and so is redundant in a rectangular shard — it is written anyway, because
// a schema that is exactly the record is a schema that cannot drift from it.
export const SLOT_FIELDS = Object.freeze(['slot', 'id', 'heldFor', 'visible']);

// Label vocabularies, for the manifest and for anything that has to print a class.
export const TRUTH_LABELS = Object.freeze({
  mode: MODE_NAME,
  anomalyKind: ANOMALY_KINDS,
});

const VISIBLE_AT = OBS_FIELDS.find((f) => f.name === 'visible').at;
const bit = (v) => (v ? 1 : 0);

// ---- pass one: the behaviour timeline ----

// Walk the episode a tick at a time and keep only the transitions: for each entity,
// the maximal runs of constant `mode`, plus the ticks a cascade ignited. Everything
// `truthAt` needs about the future is in here, and it is small enough to hold for
// any episode length (a 10-minute episode yields a few hundred spans).
export function scanEpisode({ seed, config = {}, ticks }) {
  const spans = new Map(); // id -> [{ from, to, mode }], `to` exclusive, -1 = open
  const ignitions = [];
  let wasActive = false;

  runEpisode({
    seed,
    config,
    ticks,
    stride: 1,
    sink: {
      sample(state) {
        for (const e of state.entities) {
          let list = spans.get(e.id);
          if (!list) {
            // The first span reaches back to spawn: the episode began at tick 0,
            // even though the first state we see is tick 1.
            list = [{ from: 0, to: -1, mode: e.mode }];
            spans.set(e.id, list);
            continue;
          }
          const open = list[list.length - 1];
          if (open.mode === e.mode) continue;
          open.to = state.tick;
          list.push({ from: state.tick, to: -1, mode: e.mode });
        }
        if (state.cascade.active && !wasActive) ignitions.push(state.tick);
        wasActive = state.cascade.active;
      },
    },
  });

  return { seed, ticks, spans, ignitions };
}

// The span covering `tick`, by binary search. Spans are contiguous and sorted, so
// this is exact and order-independent (unlike a cursor, it does not care whether
// the caller samples every tick or every hundredth).
function spanAt(timeline, id, tick) {
  const list = timeline.spans.get(id);
  if (!list) return null;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].from <= tick) lo = mid;
    else hi = mid - 1;
  }
  const span = list[lo];
  return span.from <= tick ? { span, next: list[lo + 1] ?? null } : null;
}

// Ticks until the next cascade ignition at or after `tick`; -1 if the episode ends
// first. This is the plan's negative control: arming has no observable signature at
// all, so a probe that "finds" it has found leakage, not a belief.
function ignitesIn(timeline, tick) {
  for (const t of timeline.ignitions) if (t >= tick) return t - tick;
  return -1;
}

// ---- pass two: the per-tick record ----

export function globalTruth(state, timeline) {
  const hat = hatOf(state);
  const top = hat ? topIncident(state, hat) : null;
  const s = state.stack;
  const c = state.cascade;
  return {
    tick: state.tick,
    nextAnomalyIn: state.director.nextAt - state.tick,
    lastKind: state.director.last,
    incidents: state.incidents.length,
    topTier: top ? top.tier : 0,
    topSubject: top ? top.subject : -1,
    stackBase: s.baseId,
    stackPhase: s.baseId >= 0 ? s.phase : -1,
    stackRiders: s.riders.length,
    stackFormsIn: s.baseId >= 0 ? -1 : s.nextAt - state.tick,
    cascadeArmed: bit(c.armed),
    cascadeActive: bit(c.active),
    cascadeArmsIn: c.armed ? -1 : c.nextArmAt - state.tick,
    cascadeIgnitesIn: ignitesIn(timeline, state.tick),
    cascadeFelled: c.felled,
    cascadeTarget: c.target,
    cascadeClaims: c.lock.length,
    cascadePending: c.pending.length,
    expertSubject: hat ? hat.subject : -1,
    expertIncident: hat ? hat.incSubject : -1,
    expertStandoff: hat ? hat.td : 0,
    expertRelocating: hat ? bit(hat.relocating) : 0,
  };
}

export function entityTruth(state, e, timeline) {
  const found = spanAt(timeline, e.id, state.tick);
  if (!found) throw new Error(`truth: no timeline span for panda ${e.id} at tick ${state.tick}`);
  const { span, next } = found;
  if (span.mode !== e.mode) {
    // The timeline was built from a different run than the one being recorded —
    // a config or seed mismatch. Labels would be silently wrong, so refuse.
    throw new Error(
      `truth: timeline says panda ${e.id} is ${MODE_NAME[span.mode]} at tick ${state.tick}, ` +
      `episode says ${MODE_NAME[e.mode]}`,
    );
  }
  return {
    id: e.id,
    mode: e.mode,
    anim: e.anim,
    dir: e.dir,
    x: e.x,
    y: e.y,
    lx: e.lx,
    ly: e.ly,
    moveSpeed: e.moveSpeed,
    moveTimer: e.moveTimer,
    aPhase: e.aPhase,
    aTimer: e.aTimer,
    aCount: e.aCount,
    aHeading: e.aHeading,
    aLie: e.aLie,
    aStep: e.aStep,
    knockPhase: e.knockPhase,
    knockTimer: e.knockTimer,
    knockLie: e.knockLie,
    oblivious: bit(e.oblivious),
    solid: bit(e.solid),
    flying: bit(e.flying),
    riding: bit(e.riding),
    entering: bit(e.entering),
    stackLevel: e.stackLevel,
    cascadeFall: bit(e.cascadeFall),
    claimed: bit(state.cascade.lock.indexOf(e.id) >= 0),
    homeX: e.home ? e.home[0] : -1,
    homeY: e.home ? e.home[1] : -1,
    age: state.tick - span.from,
    ttl: span.to < 0 ? -1 : span.to - state.tick,
    nextMode: next ? next.mode : -1,
  };
}

// One tick of truth, aligned to the observation that was taken at the same tick.
// `slots` is the observer's slot memory: recording which panda each token addressed
// is what lets a Phase-G probe read "token 3 believes X" against "panda 7 is X".
// Without it the join is guesswork, which is what "aligned for future activation
// capture" means in the phase plan.
export function truthAt(state, timeline, { slots = null, frame = null } = {}) {
  return {
    global: globalTruth(state, timeline),
    entities: state.entities.map((e) => entityTruth(state, e, timeline)),
    slots: slots
      ? slots.id.map((id, i) => ({
        slot: i,
        id,
        heldFor: id < 0 ? -1 : state.tick - slots.seen[i],
        visible: frame ? bit(frame[(1 + i) * OBS_WIDTH + VISIBLE_AT]) : 0,
      }))
      : [],
  };
}

// ---- the aligned recorder ----

// Both passes, one call: scan the episode for its timeline, then re-run it emitting
// a row per recorded tick. A row is
//
//   { tick, action, obs, truth }
//
// where `action` is the 17-way action the engine actually applied (the exact BC
// target — read, never re-derived), `obs` is the encoder's frame, and `truth` is
// everything above. B4 turns rows into shards; a test or a probe can just collect
// them.
//
// ⚠️ `obs` is the observer's reused buffer and `truth.entities` is rebuilt per row,
// but the buffer is not: copy `obs` if you keep the row.
export function recordEpisode({ seed, config = {}, observer, onRow, ...opts }) {
  // The timeline has to cover the warmup as well: a nap that began during it is
  // still running when recording starts, and its `age` counts from where it began.
  const { ticks, warmup } = { ...DEFAULT_ROLLOUT, ...opts };
  const timeline = scanEpisode({ seed, config, ticks: ticks + warmup });
  const mem = observer ? observer.init() : null;

  const summary = runEpisode({
    seed,
    config,
    ...opts,
    sink: {
      sample(state) {
        const frame = observer ? observer.observe(state, mem) : null;
        onRow({
          tick: state.tick,
          action: hatOf(state).action,
          obs: frame,
          truth: truthAt(state, timeline, { slots: mem, frame }),
        });
      },
    },
  });

  return { ...summary, timeline };
}
