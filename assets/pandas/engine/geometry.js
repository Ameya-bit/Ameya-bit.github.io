// Pure geometry — bounds, the hero-card fence, and the position clamp.
//
// The original tied these to live DOM layout (getBoundingClientRect,
// stage.clientWidth). Here they are pure functions of config: the host passes
// `width`, `height`, and the `forbid` rectangle in as state, and the engine
// never touches the DOM.

import { DX, DY } from './dirs.js';
import { hypot } from './mathx.js';

// Card-corner inset used by the watcher's fence routing: a 100px wrapper stands
// fully clear of the fence when parked this far off a card corner (original CLEAR).
const CLEAR = 120;

// Does a panda's ~52px body (its 100px wrapper inset by `foot` on each side)
// overlap the fenced hero-card rectangle? `forbid` is {l,t,r,b} or null.
export function inForbid(forbid, foot, cell, x, y) {
  if (!forbid) return false;
  return (
    x + cell - foot > forbid.l &&
    x + foot < forbid.r &&
    y + cell - foot > forbid.t &&
    y + foot < forbid.b
  );
}

// Is (x, y) a legal top-left for a wrapper — inside the stage edges and off the
// fence? Matches the original inBounds().
export function inBounds(cfg, x, y) {
  return (
    x > cfg.boundLower &&
    x < cfg.width - cfg.boundUpper &&
    y > cfg.boundLower &&
    y < cfg.height - cfg.boundUpper &&
    !inForbid(cfg.forbid, cfg.foot, cfg.cell, x, y)
  );
}

// The original applyPos: each axis moves independently, and — faithfully — the
// x move commits before the y check sees it (the y fence test uses the possibly-
// updated x). Returns the new {x, y}; unchanged coordinates mean that axis was
// blocked by an edge or the fence.
export function applyPos(cfg, curX, curY, candX, candY) {
  let x = curX;
  let y = curY;
  const { boundLower, boundUpper, width, height, forbid, foot, cell } = cfg;
  if (candX > boundLower && candX < width - boundUpper && !inForbid(forbid, foot, cell, candX, y)) {
    x = candX;
  }
  if (candY > boundLower && candY < height - boundUpper && !inForbid(forbid, foot, cell, x, candY)) {
    y = candY;
  }
  return { x, y };
}

// The landing of one full wander stride (±STEP per axis) along heading `dir`,
// clamped by the edges and the fence — the pure form of the mutating strideLogical
// in anomalies.js. Unchanged coordinates mean that axis was blocked. Used by both
// the hat's policy (to measure a prospective step) and the engine (to apply it),
// so the two never disagree.
export function strideTo(cfg, lx, ly, dir) {
  return applyPos(cfg, lx, ly, lx + DX[dir] * cfg.step, ly + DY[dir] * cfg.step);
}

// Does the straight segment (x1,y1)->(x2,y2) graze the fenced hero card? Samples
// the line every ~20px (the original crossesFence). No fence -> never crosses.
export function crossesFence(cfg, x1, y1, x2, y2) {
  if (!cfg.forbid) return false;
  const n = Math.max(1, Math.ceil(hypot(x2 - x1, y2 - y1) / 20));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (inForbid(cfg.forbid, cfg.foot, cfg.cell, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) {
      return true;
    }
  }
  return false;
}

// A waypoint that routes around the card when the straight path grazes it: the
// card corner (inset by CLEAR) that minimises total detour distance, preferring
// corners reachable by a clear straight line (the original detourCorner).
export function detourCorner(cfg, x1, y1, x2, y2) {
  const f = cfg.forbid;
  const corners = [
    [f.l - CLEAR, f.t - CLEAR], [f.r + CLEAR, f.t - CLEAR],
    [f.l - CLEAR, f.b + CLEAR], [f.r + CLEAR, f.b + CLEAR],
  ];
  const score = (c) => hypot(c[0] - x1, c[1] - y1) + hypot(x2 - c[0], y2 - c[1]);
  const clear = corners.filter((c) => !crossesFence(cfg, x1, y1, c[0], c[1]));
  const pool = clear.length ? clear : corners;
  return pool.reduce((a, b) => (score(b) < score(a) ? b : a));
}
