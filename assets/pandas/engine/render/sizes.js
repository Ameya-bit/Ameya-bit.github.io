// Troupe size variance — presentation only, drawn once per visit.
//
// The sim never sees these numbers: collision keeps the uniform 44x54 body,
// encode() is untouched, and the Phase-B freeze cannot notice (sizes live
// entirely in the render layer, like the gaze flourish). The honest cost: a big
// panda's sprite can overlap a neighbour by a few px before the uniform hit box
// calls the contact — the 20px collideTol already reads that loose, and the
// slapstick covers the rest.
//
// Distribution: normal about `sizeMean`, clamped to [sizeMin, sizeMax]. The hat
// panda is always 1 — the observer is the reference body every other size reads
// against. If no roamer clears `sizeBig`, the largest is promoted to it, so
// every troupe gets its big one ("most medium, a couple big") without
// hand-tuning the draw.

import { Rng } from '../rng.js';

// XORed onto the visit seed so this stream never replays the sim's own spawn
// draws (same generator, same seed, different purpose).
const STREAM = 0x5a5e5;

// Box-Muller on the seeded generator. Transcendentals are fine here — this is
// the render layer; nothing feeds a trace.
function gaussian(rng) {
  const u = 1 - rng.next(); // (0, 1] — never log(0)
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// id -> scale for one visit. Deterministic in (seed, entity order, cfg).
export function drawScales(seed, entities, cfg) {
  const scales = new Map();
  const sd = cfg.sizeSd ?? 0;
  const rng = new Rng((seed ^ STREAM) | 0);
  let largestId = -1;
  let largest = -Infinity;
  for (const e of entities) {
    if (e.hasHat || !sd) {
      scales.set(e.id, 1);
      continue;
    }
    const raw = cfg.sizeMean + gaussian(rng) * sd;
    const s = Math.round(Math.min(cfg.sizeMax, Math.max(cfg.sizeMin, raw)) * 1000) / 1000;
    scales.set(e.id, s);
    if (s > largest) {
      largest = s;
      largestId = e.id;
    }
  }
  if (sd && largestId >= 0 && largest < cfg.sizeBig) scales.set(largestId, cfg.sizeBig);
  return scales;
}
