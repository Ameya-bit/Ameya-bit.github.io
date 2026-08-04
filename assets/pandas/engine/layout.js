// Host-side layout helper — NOT engine core.
//
// The engine takes an explicit `pandaCount`; this decides that count from the
// viewport so density (pandas per unit of free area) stays roughly constant
// across screen sizes. A laptop gets fewer pandas, a wide monitor more, and the
// collision/liveliness feel holds steady instead of being sparse on big screens
// and cramped on small ones.
//
// This pairs with the trainer: Phase B randomises density across corpora, so a
// policy trained over a density range generalises to whatever viewport a visitor
// brings. Viewport-scaling here and density-randomisation there are the same knob.

export const DEFAULT_DENSITY = Object.freeze({
  // Locked to Ameya's preview pick (2026-07-26): 15 pandas at 2560x1343 with the
  // hero-card fence ≈ 217k px² of free space per panda — a calm-but-alive field.
  areaPerPanda: 217000,
  min: 6,
  max: 28,
});

// Free (walkable) area = stage minus the fence (one rect or an array of rects;
// array rects are assumed disjoint — the hero's text blocks never overlap).
export function freeArea(width, height, forbid) {
  const stage = width * height;
  if (!forbid) return stage;
  const rects = Array.isArray(forbid) ? forbid : [forbid];
  const fenced = rects.reduce(
    (sum, f) => sum + Math.max(0, f.r - f.l) * Math.max(0, f.b - f.t),
    0,
  );
  return Math.max(0, stage - fenced);
}

// Panda count for a viewport, holding ~constant density within [min, max].
export function pandaCountForViewport(width, height, forbid, opts = {}) {
  const { areaPerPanda, min, max } = { ...DEFAULT_DENSITY, ...opts };
  const raw = Math.round(freeArea(width, height, forbid) / areaPerPanda);
  return Math.max(min, Math.min(max, raw));
}
