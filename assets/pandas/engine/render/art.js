// The art builders — baked pixel/path data (art-data.js) turned into SVG markup.
//
// Everything here is a pure string function of the baked data, evaluated once at
// module load and then reused: five sprite blocks (with and without the worn
// hat), five seated-rider drawings, one loose hat. No DOM, no state, no sim.
//
// Ported from pandas.js's decode / hatArt / spriteBlock / sitSvg. The output is
// byte-identical markup — the same drawing, just built somewhere else.

import { PANDA_SVG, DECODE_REF, HAT_PIXELS, HAT_FIT, SIT_CELS } from './art-data.js';
import { CELL, ROW_KEYS, DIR_SPRITE } from './cels.js';
import { DIRS } from '../dirs.js';

// ---- the walk/fall sprite sheet ----

// The sprite rows ship run-length encoded (one character per `h -2`-style path
// command) to keep the file small; expand back to real path data.
const decode = (s) => s.split('').map((c) => (DECODE_REF[c] === undefined ? c : DECODE_REF[c])).join('');

// ---- the straw hat ----

const HAT_W = 28;
const HAT_H = 14;
const SPRITE_FRAME_W = 48; // the sprite's own units: 13 cels of 48 across a 624-wide viewBox

const rect = (x, y, f, w = 1, h = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;

// The hat sits steady on the head: the per-frame bob comes entirely from the seat
// (HAT_FIT) moving the whole drawing, never from shearing it.
const hatArt = (dir) => {
  let out = '';
  const px = HAT_PIXELS[dir];
  for (const k in px) {
    const i = k.indexOf(',');
    out += rect(+k.slice(0, i), +k.slice(i + 1), px[k]);
  }
  return out;
};

// The worn hat, composited into the walk/stop cels (columns 0,1,2) of a row.
// Fall and stand-up cels stay bare — by then it is on the ground.
const hatGroup = (dir) =>
  [0, 1, 2]
    .map((f) => {
      const s = HAT_FIT[dir][f];
      return `<g class="wornhat" transform="translate(${f * SPRITE_FRAME_W + s.x}, ${s.y})">${hatArt(dir)}</g>`;
    })
    .join('');

// One panda's whole sprite sheet: the five rows stacked, each 20% tall.
export const spriteBlock = (hasHat) =>
  ROW_KEYS
    .map(
      (dir) =>
        `<svg x="0px" y="0px" width="100%" height="20%" viewBox="0 0 624 48">` +
        `${decode(PANDA_SVG[dir])}${hasHat ? hatGroup(dir) : ''}</svg>`,
    )
    .join('');

// Both variants are built once at load — every panda shares the same two strings.
export const SPRITE_HAT = spriteBlock(true);
export const SPRITE_BARE = spriteBlock(false);

// The knocked-off hat lying on the ground, rebuilt standalone from the pixels.
export const looseHatSvg = () =>
  `<svg viewBox="0 0 ${HAT_W} ${HAT_H}" width="60" height="30" aria-hidden="true">${hatArt('down')}</svg>`;

// ---- the seated rider (tier 2) ----

// The seated cels are drawn on a 48x48 grid, scaled up to the 100px cell.
const S_UNIT = CELL / SPRITE_FRAME_W;

// Occupied rows of a pixel map — the drawing's real height, which is what a seat
// must rise by for the rider above to land on this one's head.
function measureSit(map) {
  let top = Infinity;
  let bot = -Infinity;
  for (const k in map) {
    const y = +k.slice(k.indexOf(',') + 1);
    if (y < top) top = y;
    if (y > bot) bot = y;
  }
  return top === Infinity ? { top: 0, bot: 0 } : { top, bot };
}

// 1.05-wide rects (a hair of overlap) so neighbouring pixels never hairline-crack
// when the SVG is scaled — the original's trick, kept.
function sitSvg(map) {
  let out =
    '<svg viewBox="0 0 48 48" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"' +
    ' shape-rendering="crispEdges" aria-hidden="true">';
  for (const k in map) {
    const i = k.indexOf(',');
    out += rect(k.slice(0, i), k.slice(i + 1), map[k], 1.05, 1.05);
  }
  return `${out}</svg>`;
}

// Per drawn facing: its markup and its measured seat height in stage pixels.
export const SIT = Object.fromEntries(
  ROW_KEYS.map((dir) => {
    const b = measureSit(SIT_CELS[dir]);
    return [dir, { svg: sitSvg(SIT_CELS[dir]), rise: (b.bot - b.top) * S_UNIT }];
  }),
);

// A heading index -> which seated drawing to use, and whether to mirror it.
export const sitFace = (dirIndex) => {
  const name = DIRS[dirIndex] ?? 'down';
  return { row: DIR_SPRITE[name] ?? 'down', flip: name.includes('left') };
};

// The seat rise for a heading — how far above the base a rider's feet sit. The
// engine carries one flat `cfg.riderRise` (art data has no business in sim
// state); the renderer refines it per facing from the drawing itself.
export const seatRise = (dirIndex) => SIT[sitFace(dirIndex).row].rise;
