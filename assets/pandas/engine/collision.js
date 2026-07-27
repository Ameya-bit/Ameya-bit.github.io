// Collision — model-space, deterministic. Replaces the original's
// getBoundingClientRect / hit-corner DOM reads (map §6, §10).
//
// Each panda carries a 44x54 hit area centered in its 100px cell, split into four
// 22x27 corner quadrants — except while it is `stopped`, where the original's CSS
// shortened the box to 46px from the top (`.panda_wrapper.stop .hit_area`). Its two
// corner rows then sit 8px and 4px lower, so a grounded, skidding, dashing or
// parading panda cedes 8px of reach upward and gains 4px downward: the asymmetry
// falls out of comparing corner top-lefts rather than box edges, exactly as the
// original's DOM reads did. Two corners "touch" when their top-lefts are within
// `collideTol` (20px) on both axes — the exact proximity test the original ran on
// the DOM corners. Which of a panda's corners are touched resolves to the knock
// direction via the same precedence ladder pandas.js used (later rules override
// earlier, so a two-corner contact reads as a cardinal shove).
//
// Ghost rules preserved: entering / flying (mid-arc) / riding pandas don't
// collide; a `solid` panda (a stack base) knocks non-solids without being knocked,
// and two solids pass through each other. Knocked-panda and cascade-claim
// exclusions live in the caller (engine.step), which owns recovery.

import { dirIndex } from './dirs.js';

const LABELS = ['upleft', 'upright', 'downleft', 'downright'];

// Corner top-left offsets from an entity's (x, y), given a box height and the
// margin above it. The wrapper is flex-centered on the 100px cell and centres the
// box's *margin* box, so the margin pushes the box down by its full height rather
// than half of it — with the original's 8/46 that puts the bottom edge exactly
// where the standing box's is, and only the top edge moves.
function cornerOffsets(cfg, boxH, marginTop = 0) {
  const ox = (cfg.cell - cfg.bodyW) / 2;
  const oy = (cfg.cell - (boxH + marginTop)) / 2 + marginTop;
  const hw = cfg.bodyW / 2;
  const hh = boxH / 2;
  return [
    [ox, oy], // upleft
    [ox + hw, oy], // upright
    [ox, oy + hh], // downleft
    [ox + hw, oy + hh], // downright
  ];
}

const isGhost = (e) => e.entering || e.flying || e.riding;

// Resolve a set of touched corner labels to a single knock direction index,
// mirroring the original's precedence ladder (map §6, lines 970-979).
function resolveHitDir(touched, defaultFallDir) {
  let dir = -1;
  const has = (l) => touched.has(l);
  if (has('upleft')) dir = dirIndex('upleft');
  if (has('downleft')) dir = dirIndex('downleft');
  if (has('upright')) dir = dirIndex('upright');
  if (has('downright')) dir = dirIndex('downright');
  if (has('upleft') && has('downleft')) dir = dirIndex('left');
  if (has('upright') && has('downright')) dir = dirIndex('right');
  if (has('upleft') && has('upright')) dir = dirIndex('up');
  if (has('downleft') && has('downright')) dir = dirIndex('down');
  if (has('upleft') && has('upright') && has('downleft') && has('downright')) dir = defaultFallDir;
  return dir;
}

// Detect all collisions this tick. Returns one {id, hit} per panda that took a
// contact (hit = a heading index), with no knocked/lock filtering — the caller
// decides which land. Solid pandas never appear in the result (they aren't
// knockable) but still deliver hits to others.
export function detectCollisions(entities, cfg) {
  const standing = cornerOffsets(cfg, cfg.bodyH);
  const stopped = cornerOffsets(cfg, cfg.stopBodyH, cfg.stopBodyMargin);
  const tol = cfg.collideTol;
  const touched = new Map(); // id -> Set<label>

  // Precompute absolute corner coords once per entity, from whichever box it wears.
  const corners = entities.map((e) => {
    const off = e.stopped ? stopped : standing;
    return off.map(([dx, dy]) => [e.x + dx, e.y + dy]);
  });

  for (let i = 0; i < entities.length; i++) {
    const a = entities[i];
    if (isGhost(a)) continue;
    for (let j = i + 1; j < entities.length; j++) {
      const b = entities[j];
      if (isGhost(b)) continue;
      if (a.solid && b.solid) continue;
      for (let ci = 0; ci < 4; ci++) {
        const [acx, acy] = corners[i][ci];
        for (let cj = 0; cj < 4; cj++) {
          const [bcx, bcy] = corners[j][cj];
          if (Math.abs(acx - bcx) < tol && Math.abs(acy - bcy) < tol) {
            if (!a.solid) addTouch(touched, a.id, LABELS[ci]);
            if (!b.solid) addTouch(touched, b.id, LABELS[cj]);
          }
        }
      }
    }
  }

  const byId = new Map(entities.map((e) => [e.id, e]));
  const hits = [];
  for (const [id, labels] of touched) {
    const dir = resolveHitDir(labels, byId.get(id).defaultFallDir);
    if (dir >= 0) hits.push({ id, hit: dir });
  }
  return hits;
}

function addTouch(map, id, label) {
  let s = map.get(id);
  if (!s) map.set(id, (s = new Set()));
  s.add(label);
}
