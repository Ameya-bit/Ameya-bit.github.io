// The art layer: the baked data is in sync with pandas.js, and the builders turn
// it into the same drawing the site has always shown.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SPRITE_HAT, SPRITE_BARE, SIT, sitFace, seatRise, looseHatSvg } from '../render/art.js';
import { HAT_PIXELS, SIT_CELS, PANDA_SVG } from '../render/art-data.js';
import { ANIM_FRAMES, FACING, celAt, ROW_KEYS } from '../render/cels.js';
import { interp } from '../render/renderer.js';
import { dirIndex } from '../dirs.js';

const engineDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('the baked art is still identical to the art in pandas.js', () => {
  // Fails loudly if someone hand-edits render/art-data.js or edits the hat in
  // pandas.js without re-baking: `node tools/bake-art.js`.
  execFileSync(process.execPath, [join(engineDir, 'tools', 'bake-art.js'), '--check']);
});

test('every drawn facing has sprite data, hat pixels and a seated cel', () => {
  for (const row of ROW_KEYS) {
    assert.ok(PANDA_SVG[row].length > 100, `${row} sprite row`);
    assert.ok(Object.keys(HAT_PIXELS[row]).length > 50, `${row} hat pixels`);
    assert.ok(Object.keys(SIT_CELS[row]).length > 100, `${row} seated cel`);
  }
});

test('the sprite block is five rows, and only the hat variant wears a hat', () => {
  assert.equal((SPRITE_BARE.match(/<svg /g) || []).length, 5);
  assert.equal((SPRITE_BARE.match(/class="wornhat"/g) || []).length, 0);
  // The hat is composited into the three walk/stop cels of each of the five rows;
  // fall and stand-up cels stay bare — by then it is on the ground.
  assert.equal((SPRITE_HAT.match(/class="wornhat"/g) || []).length, 15);
  assert.match(looseHatSvg(), /^<svg viewBox="0 0 28 14"/);
});

test('seat heights come from the drawing, and beat the flat engine stand-in', () => {
  // The seated art is shorter than the walking art (cfg.riderRise = 62) and by a
  // different amount per facing — which is exactly why the renderer refines it.
  for (const row of ROW_KEYS) {
    assert.ok(SIT[row].rise > 40 && SIT[row].rise < 62, `${row} rise ${SIT[row].rise}`);
  }
  assert.notEqual(SIT.up.rise, SIT.dUp.rise);
  assert.equal(seatRise(dirIndex('left')), SIT.side.rise);
});

test('left-facing headings mirror a drawn row rather than needing their own', () => {
  assert.deepEqual(sitFace(dirIndex('right')), { row: 'side', flip: false });
  assert.deepEqual(sitFace(dirIndex('left')), { row: 'side', flip: true });
  assert.deepEqual(sitFace(dirIndex('downleft')), { row: 'dDown', flip: true });
  assert.equal(FACING[dirIndex('upleft')].flip, true);
  assert.equal(FACING[dirIndex('upright')].rowIndex, FACING[dirIndex('upleft')].rowIndex);
});

test('cel cycles wrap, and the roll never settles to the face-down cel', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => celAt(0, i)), [0, 1, 2, 1, 0]);
  assert.ok(!ANIM_FRAMES[6].includes(7), 'the dive-roll pops straight back up');
});

test('interpolation eases ordinary motion but takes a teleport whole', () => {
  assert.deepEqual(interp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
  // A knock snap / hop landing / topple drop must not smear across the gap.
  assert.deepEqual(interp({ x: 0, y: 0 }, { x: 400, y: 0 }, 0.5), { x: 400, y: 0 });
  // First frame of a panda's life: nothing to come from.
  assert.deepEqual(interp(null, { x: 7, y: 8 }, 0.5), { x: 7, y: 8 });
});
