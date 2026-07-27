// The cel tables — which sprite column/row a given (anim, dir) draws.
//
// Presentation only: the sim says "this panda is falling and facing downleft"
// (`anim` + `dir` integers); this module says which of the 13 columns and 5 rows
// of the sprite sheet that is. Ported verbatim from pandas.js's ANIM / ROW /
// DIR_SPRITE, so the cel a panda shows is the cel it always showed.

import { DIRS } from '../dirs.js';

// The sprite sheet: 13 columns x 5 rows of 100px cells.
export const CELL = 100;
export const SHEET_COLS = 13;

// One cel every 140 ms, the original's free-running animate() cadence.
export const FRAME_MS = 140;

// Cel cycles per animation, indexed by the engine's ANIM enum.
//   idle  = f1, the legs-together mid-stride dip (a settled pose, not a contact stride)
//   roll  = the fall tumble WITHOUT settling to fallen(7), so he pops straight back up
export const ANIM_FRAMES = [
  [0, 1, 2, 1], // WALK
  [0], // STOP
  [1], // IDLE
  [3, 4, 5, 6, 5, 7], // FALL
  [7], // FALLEN
  [7, 8, 9, 10, 11, 12], // STAND_UP
  [3, 4, 5, 6, 5], // ROLL
];

// The five drawn facings (sprite rows). The three left-facing headings reuse a
// right-facing row and are mirrored in CSS (`.facing_left` et al).
export const ROW = { up: 0, dUp: 1, side: 2, dDown: 3, down: 4 };
export const ROW_KEYS = Object.keys(ROW);

// heading name -> which row is drawn for it
export const DIR_SPRITE = {
  up: 'up', upright: 'dUp', right: 'side', downright: 'dDown',
  down: 'down', downleft: 'dDown', left: 'side', upleft: 'dUp',
};

// heading index -> { row, flip }: the drawn row, and whether it is mirrored.
export const FACING = DIRS.map((name) => ({
  name,
  row: DIR_SPRITE[name],
  rowIndex: ROW[DIR_SPRITE[name]],
  flip: name.includes('left'),
}));

// Whether an animation is a fixed pose (one cel) rather than a cycle — used by
// the renderer to skip the frame clock entirely.
export const isStatic = (anim) => ANIM_FRAMES[anim].length === 1;

// The cel column for a free-running animation at frame index `i`.
export function celAt(anim, i) {
  const frames = ANIM_FRAMES[anim];
  return frames[i % frames.length];
}

// Note: some animations' progress is owned by the SIM (the dive-roll's 5 cels
// span exactly its 5 ticks), so the renderer pins those columns from state rather
// than free-running them — see `forcedColumn` in renderer.js.
