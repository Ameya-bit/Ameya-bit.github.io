// A toy engine — NOT the panda sim. It exists only to exercise the golden-trace
// harness end to end against the real determinism primitives (Rng, mathx, tick)
// before the actual engine exists. A small field of seeded wanderers that turn,
// step, bounce off bounds, and carry a sin wobble — enough moving parts that a
// determinism break anywhere in the stack would change the digest.
//
// When the real engine lands it implements the same init/step/encode shape and
// this file can be deleted.

import { Rng } from '../rng.js';
import { sin, clamp } from '../mathx.js';
import { msToTicks } from '../tick.js';

const N = 8; // wanderers
const W = 900;
const H = 400;
const STEP = 5; // px per tick
const TURN_EVERY = msToTicks(900); // exercise the tick conversion

// 8 headings, integer-indexed like the sim's DIRS.
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

export function init(seed) {
  const rng = new Rng(seed);
  const ps = [];
  for (let i = 0; i < N; i++) {
    ps.push({
      x: rng.float(0, W),
      y: rng.float(0, H),
      dir: rng.int(8),
      nextTurn: rng.intBetween(1, TURN_EVERY),
    });
  }
  return { tick: 0, rng: rng.state, ps };
}

export function step(state) {
  const rng = new Rng(state.rng);
  const tick = state.tick + 1;
  const ps = state.ps.map((p, i) => {
    let { x, y, dir, nextTurn } = p;
    if (--nextTurn <= 0) {
      dir = (dir + rng.intBetween(-1, 1) + 8) % 8;
      nextTurn = TURN_EVERY;
    }
    x = clamp(x + DX[dir] * STEP, 0, W);
    y = clamp(y + DY[dir] * STEP + sin(tick * 0.1 + i) * 0.5, 0, H);
    return { x, y, dir, nextTurn };
  });
  return { tick, rng: rng.state, ps };
}

export function encode(state) {
  const out = [state.tick, state.rng];
  for (const p of state.ps) out.push(p.x, p.y, p.dir, p.nextTurn);
  return out;
}

export const demoEngine = { init, step, encode };
