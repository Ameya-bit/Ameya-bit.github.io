// The reduced-motion tableau — what someone who has asked for no animation gets.
//
// Not a scatter of pandas standing still: the frozen *story*. One panda is down, a
// three-high tower is mid-parade, the watcher is planted at inspecting distance
// facing the fallen one, and the rest of the troupe stands about, none of them
// piled on anything else. Nothing is scheduled and nothing ticks — the host builds
// this once, renders one frame, and stops.
//
// It is built as a normal engine state, so the ordinary renderer draws it with no
// special cases: same sprites, same seats, same depth sorting.

import { Rng } from '../rng.js';
import { MODE, ANIM, KNOCK, clearSpot } from '../state.js';
import { AX, AY, headingDir, dirIndex } from '../dirs.js';
import { inBounds } from '../geometry.js';
import { PHASE } from '../stack.js';

// Facings that show us a front: a random heading would parade the tower's back.
const FACE_THE_VIEWER = ['down', 'downleft', 'downright'];

export function buildTableau(state, cfg) {
  const rng = new Rng(state.rng);
  const entities = state.entities.map((e) => ({ ...e }));
  const hat = entities.find((e) => e.hasHat);
  const rest = entities.filter((e) => !e.hasHat);
  const placed = [];

  const spot = () => {
    const p = clearSpot(rng, cfg, placed, cfg.tableauGap);
    placed.push(p);
    return p;
  };

  const pose = (e, x, y, anim, dir) => {
    e.x = Math.round(x);
    e.y = Math.round(y);
    e.lx = e.x;
    e.ly = e.y;
    e.anim = anim;
    e.dir = dir;
    e.mode = MODE.WANDER;
    e.knockPhase = KNOCK.NONE;
    e.solid = false;
    e.entering = false;
    e.flying = false;
    e.riding = false;
    e.stackLevel = 0;
    return e;
  };

  // 1. The fallen one.
  const fallen = rest[0];
  const f = spot();
  pose(fallen, f.x, f.y, ANIM.FALLEN, rng.int(8));

  // 2. The watcher, on the first standoff axis that keeps them both on stage.
  let axis = 0;
  for (let i = 0; i < 8; i++) {
    if (inBounds(cfg, f.x + AX[i] * cfg.inspectNear, f.y + AY[i] * cfg.inspectNear)) {
      axis = i;
      break;
    }
  }
  const hx = f.x + AX[axis] * cfg.inspectNear;
  const hy = f.y + AY[axis] * cfg.inspectNear;
  placed.push({ x: hx, y: hy });
  pose(hat, hx, hy, ANIM.IDLE, Math.max(0, headingDir(f.x - hx, f.y - hy, 8)));
  hat.mode = MODE.OBSERVING;

  // 3. The three-high tower, mid-parade and facing us.
  const tower = rest.slice(1, 4);
  const stack = { ...state.stack, riders: [], mounters: [] };
  if (tower.length === 3) {
    const s = spot();
    const facing = dirIndex(FACE_THE_VIEWER[rng.int(FACE_THE_VIEWER.length)]);
    const [base, ...riders] = tower;
    pose(base, s.x, s.y, ANIM.WALK, facing);
    base.mode = MODE.STACK_BASE;
    base.solid = true;
    riders.forEach((r, i) => {
      const level = i + 1;
      pose(r, s.x, s.y - level * cfg.riderRise, ANIM.IDLE, facing);
      r.mode = MODE.RIDING;
      r.riding = true;
      r.stackLevel = level;
      placed.push({ x: r.x, y: r.y });
    });
    stack.baseId = base.id;
    stack.riders = riders.map((r) => r.id);
    stack.phase = PHASE.PARADE;
    stack.baseDir = facing;
  }

  // 4. Everyone else, standing about.
  for (const e of rest.slice(tower.length === 3 ? 4 : 1)) {
    const p = spot();
    pose(e, p.x, p.y, ANIM.STOP, rng.int(8));
  }

  return { ...state, entities, stack, incidents: [], rng: rng.state };
}
