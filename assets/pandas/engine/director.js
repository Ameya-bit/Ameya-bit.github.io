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

export function emitIncident(state, subjectId, tier, ttlTicks) {
  state.incidents.push({
    subject: subjectId,
    tier,
    born: state.tick,
    expires: state.tick + ttlTicks,
  });
}

export function pruneIncidents(state) {
  if (state.incidents.some((inc) => inc.expires <= state.tick)) {
    state.incidents = state.incidents.filter((inc) => inc.expires > state.tick);
  }
}

// Eligible for an anomaly: an ordinary roamer on its feet — not the watcher, not
// the oblivious one, not already busy (only WANDER qualifies), and not a stack
// part (solid/riding/flying/entering, all false until later milestones).
function eligible(e) {
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
export function runDirector(state, cfg, rng) {
  const d = state.director;
  if (state.tick < d.nextAt) return;
  d.nextAt = state.tick + rng.intBetween(cfg.anomGapMin, cfg.anomGapMax);

  const candidates = state.entities.filter(eligible);
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
