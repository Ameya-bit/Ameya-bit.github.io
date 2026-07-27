// The 8 compass headings — the sim's movement and facing basis.
//
// Ported verbatim from pandas.js's DIRS order (up, then clockwise). Index 0..7
// is the canonical `dir` on every entity; the presentation layer maps it back to
// sprite rows. Keeping this as integer indices (not the original strings) is what
// lets movement, facing, and collision stay pure integer math.

export const DIRS = [
  'up', 'upright', 'right', 'downright', 'down', 'downleft', 'left', 'upleft',
];

// Unit step per heading — matches the original wanderStep(): a diagonal moves one
// STEP on each axis (not normalised), exactly as pandas.js did.
export const DX = [0, 1, 1, 1, 0, -1, -1, -1];
export const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

export const DIR_COUNT = 8;

// Normalised unit vectors per heading (diagonals scaled by 1/√2). The original's
// AXES — used where a fixed *resultant* speed matters regardless of diagonal
// (the tumbler skid and the zoomies dash advance by a set magnitude along these).
// Contrast DX/DY, which move a full STEP on each axis (a faster diagonal), used
// by wander strides and stepCell. Math.SQRT1_2 is a numeric constant, not a
// transcendental call.
const R2 = Math.SQRT1_2;
export const AX = [0, R2, 1, R2, 0, -R2, -1, -R2];
export const AY = [-1, -R2, 0, R2, 1, R2, 0, -R2];

// Wrap any integer to 0..7.
export const wrapDir = (i) => ((i % 8) + 8) % 8;

// The opposite heading (turn around) — the wander "bounce" when fully blocked.
export const opposite = (i) => wrapDir(i + 4);

// String name for a heading index (presentation + the original hit-direction
// vocabulary used by the knock logic).
export const dirName = (i) => DIRS[wrapDir(i)];

// Index for a heading name.
export const dirIndex = (name) => DIRS.indexOf(name);

// Heading with a deadzone — the original pandas.js `heading(dx, dy, t)`. Returns
// a DIRS index, or -1 when the vector sits inside the ±`tol` deadzone on both axes
// (i.e. "no clear direction, keep the current facing"). Unlike eightWay this can
// decline to pick, which the hat panda's gaze/fetch facing relies on. The vertical
// component names first, then horizontal, so the concatenation lands on a DIRS
// member (`up`+`left` = `upleft`, etc.).
export function headingDir(dx, dy, tol = 26) {
  const v = dy < -tol ? 'up' : dy > tol ? 'down' : '';
  const h = dx < -tol ? 'left' : dx > tol ? 'right' : '';
  const name = v + h;
  return name === '' ? -1 : DIRS.indexOf(name);
}

// Snap a (dx, dy) vector to the nearest of the 8 headings, returning its index.
// Used by collision to point a knocked panda away from whatever struck it. A zero
// vector falls back to `up` (0), matching how the original degenerate cases
// resolve to a default facing.
export function eightWay(dx, dy) {
  if (dx === 0 && dy === 0) return 0;
  // Octant by comparing |dx| and |dy| with a diagonal deadzone: a component
  // counts as "present" when it is at least ~40% of the dominant one, so near-
  // axis contacts read as cardinal and near-45° contacts read as diagonal —
  // the same buckets the original's 2x2 corner overlaps produced.
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const thresh = 0.4;
  const useX = ax >= ay * thresh;
  const useY = ay >= ax * thresh;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const ux = useX ? sx : 0;
  const uy = useY ? sy : 0;
  // Map the (ux, uy) in {-1,0,1}^2 (excluding 0,0) to a DIRS index.
  return VEC_TO_DIR.get(`${ux},${uy}`);
}

const VEC_TO_DIR = new Map([
  ['0,-1', 0], ['1,-1', 1], ['1,0', 2], ['1,1', 3],
  ['0,1', 4], ['-1,1', 5], ['-1,0', 6], ['-1,-1', 7],
]);
