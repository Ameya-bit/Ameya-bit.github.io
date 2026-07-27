// The tier-1 director + the incident queue.
//
// The director is the one scheduler that owns the anomaly rate: every ANOM_GAP it
// picks an eligible roamer and a kind (never the same kind twice running) and sets
// it going. Variety over frequency — the calm baseline stays calm; the chaos comes
// from many *kinds* of rare event.
//
// The incident queue records what's happening for the hat-panda watcher's
// attention (added in a later milestone). For now anomalies post to it and expired
// entries are pruned; nothing consumes it yet.

import { MODE } from './state.js';
import { ANOMALY_KINDS, startAnomaly } from './anomalies.js';

export function initDirector(cfg) {
  return { nextAt: cfg.anomKick, last: -1 }; // first anomaly after the kick delay
}

// Post an incident for the watcher's attention. `subjectId` is an entity id, or
// POINT_SUBJECT for a fixed spot on the stage (the tier-3 cascade origin), in which
// case (px, py) carries that spot. `(subject, born)` is the pair the watcher uses to
// re-find the incident it is holding across ticks, so it must stay stable.
export function emitIncident(state, subjectId, tier, ttlTicks, px = 0, py = 0) {
  state.incidents.push({
    subject: subjectId,
    tier,
    born: state.tick,
    expires: state.tick + ttlTicks,
    px,
    py,
  });
}

export function pruneIncidents(state) {
  if (state.incidents.some((inc) => inc.expires <= state.tick)) {
    state.incidents = state.incidents.filter((inc) => inc.expires > state.tick);
  }
}

// A free ordinary roamer: on its feet, not the watcher, not the oblivious one, not
// already busy (only WANDER qualifies), and not part of a set piece (solid base /
// rider / mid-flight climber / still walking in). Both directors recruit from this
// same pool — the tier-1 anomaly and the tier-2 stack (stack.js).
export function isFreeRoamer(e) {
  return (
    e.mode === MODE.WANDER &&
    !e.hasHat &&
    !e.oblivious &&
    !e.solid &&
    !e.riding &&
    !e.flying &&
    !e.entering
  );
}

// Advance the director. If it's time, start one anomaly. Mutates the entity it
// chooses (a fresh clone this tick) and pushes an incident onto `state`.
//
// Draw-order note (applies to all three directors — tier 2 in stack.js and tier 3 in
// cascade.js follow the same shape): the reschedule gap is drawn FIRST, before the
// kind/candidate picks. The original drew it last (`next()` at the end of
// `director()`), so the specific values land differently. That is deliberate and
// harmless: the draws are independent and uniform, the count per firing is identical,
// so every distribution is preserved — and there is no cross-implementation trace to
// match, because the original was nondeterministic by construction. Drawing first
// keeps the clock advance in one place and impossible to skip on an early return.
export function runDirector(state, cfg, rng) {
  const d = state.director;
  if (state.tick < d.nextAt) return;
  d.nextAt = state.tick + rng.intBetween(cfg.anomGapMin, cfg.anomGapMax);

  const candidates = state.entities.filter(isFreeRoamer);
  if (candidates.length === 0) return; // nobody free this cycle — skip it

  // Pick a kind (never last cycle's), then a candidate — same draw order as the
  // original director.
  const kinds = ANOMALY_KINDS.map((_, i) => i).filter((i) => i !== d.last);
  const kindIdx = rng.pick(kinds);
  const cand = rng.pick(candidates);

  const ttl = startAnomaly(cand, kindIdx, cfg, rng);
  d.last = kindIdx;
  emitIncident(state, cand.id, 1, ttl);
}
