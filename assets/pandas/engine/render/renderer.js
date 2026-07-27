// The renderer — engine state onto the DOM, once per frame.
//
// The cut line of design/panda-engine-map.md §10: the sim decides *what is true*
// (position, facing, animation, mode); this decides *what that looks like*. It is
// strictly one-way — nothing measured or computed here is ever written back into
// state, so the browser's sim stays bit-identical to Node's.
//
// Two ticks are held at a time and drawn between them: the engine runs at a fixed
// 20 Hz, the display at whatever the monitor does, so every frame interpolates the
// previous tick toward the current one by `alpha`. Cel cycling keeps the original's
// free-running 140 ms clock, except where the sim owns the progress (the dive-roll,
// the mount hop, the hiccup pop), where the cel is read off state instead.

import { MODE, ANIM } from '../state.js';
import { wrapDir } from '../dirs.js';
import { riderSway, PHASE } from '../stack.js';
import { hiccupLift } from '../anomalies.js';
import { CELL, FRAME_MS, ANIM_FRAMES, FACING, celAt } from './cels.js';
import { SPRITE_HAT, SPRITE_BARE, SIT, sitFace, seatRise } from './art.js';

// Beyond this a position change is a teleport (a knock snap, a hop landing, a
// topple drop), not motion — interpolating across it would smear the panda over
// the gap, so the new position is taken whole.
const JUMP_PX = 60;

const lerp = (a, b, t) => a + (b - a) * t;

export function interp(prev, cur, alpha) {
  if (!prev) return { x: cur.x, y: cur.y };
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  if (dx * dx + dy * dy > JUMP_PX * JUMP_PX) return { x: cur.x, y: cur.y };
  return { x: lerp(prev.x, cur.x, alpha), y: lerp(prev.y, cur.y, alpha) };
}

// One panda's DOM: a positioned wrapper, an inner element carrying the facing
// flip, and the sprite sheet it slides around behind a 100px window. The seated
// drawing is created lazily, the first time this panda rides a tower.
function makeView(entity) {
  const el = document.createElement('div');
  el.className = 'panda_wrapper';
  el.innerHTML =
    '<div class="panda_inner_wrapper">' +
    `<div class="panda_sprite">${entity.hasHat ? SPRITE_HAT : SPRITE_BARE}</div>` +
    '</div>';
  return {
    el,
    inner: el.firstChild,
    sprite: el.firstChild.firstChild,
    sit: null,
    anim: -1,
    frame: 0,
    frameAcc: 0,
    // Last values written to the DOM — every write is guarded by these, so a
    // steady panda costs one transform per frame and nothing else.
    celKey: '',
    facingKey: '',
    sitKey: '',
    classKey: '',
    transform: '',
    zIndex: -1,
  };
}

// `cfg` is read off the state handed to `sync` every frame rather than captured
// once: a resize re-frames the world into a new config object, and the renderer
// must never be left drawing against the stage it used to be.
export function makeRenderer(stage) {
  const views = new Map();

  // ---- per-frame cel bookkeeping ----

  // Advance (or hold) a view's cel cycle and return the sprite column to draw.
  // `forced` lets a caller pin the column when the sim owns the progress.
  function celColumn(view, anim, dtMs, forced) {
    if (view.anim !== anim) {
      view.anim = anim;
      view.frame = 0;
      view.frameAcc = 0;
    }
    if (forced != null) return forced;
    if (ANIM_FRAMES[anim].length > 1) {
      view.frameAcc += dtMs;
      while (view.frameAcc >= FRAME_MS) {
        view.frameAcc -= FRAME_MS;
        view.frame += 1;
      }
    }
    return celAt(anim, view.frame);
  }

  // The column the sim is dictating, or null to let the cel clock run.
  //   dive-roll   — 5 cels across its 5 ticks, so the tumble matches the travel
  //   mount hop   — a frozen stance while it is in the air (it is being thrown)
  //   hiccup pop  — likewise: the pop is the motion, not a gait
  function forcedColumn(e, state, cfg) {
    if (e.mode === MODE.ROLLING) {
      const total = cfg.rollCels * cfg.rollFrameTicks;
      const i = Math.min(cfg.rollCels - 1, Math.max(0, total - e.aCount));
      return ANIM_FRAMES[ANIM.ROLL][i];
    }
    if (e.mode === MODE.MOUNTING && state.stack.phase === PHASE.FLIGHT) return 0;
    if (e.mode === MODE.HICCUP && hiccupLift(e, cfg) > 0) return 0;
    return null;
  }

  // ---- the drawn facing ----
  // Almost always the sim's own `dir`. Two flourishes spin it without the sim
  // caring: a hiccup pop and a mount hop both tumble ~2 turns in the air (the
  // hop's tumble IS in state; the pop's is ours, since the sim just holds still).
  function facingOf(e, cfg) {
    if (e.mode === MODE.HICCUP) {
      const lift = hiccupLift(e, cfg);
      if (lift > 0) {
        const k = 1 - e.aTimer / cfg.hiccupHopTicks;
        return wrapDir(e.dir + Math.round(k * 16));
      }
    }
    return wrapDir(e.dir);
  }

  // ---- the seated rider ----

  function drawRider(view, e, dirIndex, sway, cfg) {
    const { row, flip } = sitFace(dirIndex);
    const key = row + (flip ? 'F' : '');
    if (!view.sit) {
      view.sit = document.createElement('div');
      view.sit.className = 'sit';
      view.el.appendChild(view.sit);
    }
    view.sit.style.display = '';
    if (view.sitKey !== key) {
      view.sit.innerHTML = SIT[row].svg;
      view.sit.classList.toggle('flip', flip);
      view.sitKey = key;
    }
    return sway * cfg.sitTiltDeg;
  }

  function hideRider(view) {
    if (view.sit && view.sit.style.display !== 'none') {
      view.sit.style.display = 'none';
      view.sitKey = '';
    }
  }

  // ---- the frame ----

  // `overrides` is the presentation layer's one channel into the picture (the gaze
  // flourish, the hat skit): per-entity `{ dir, hatless }`, never written to state.
  function sync(prev, state, alpha, dtMs, overrides = null) {
    const cfg = state.cfg;
    const prevById = prev ? new Map(prev.entities.map((e) => [e.id, e])) : null;
    const base =
      state.stack.baseId >= 0 ? state.entities.find((q) => q.id === state.stack.baseId) : null;
    const basePos = base ? interp(prevById?.get(base.id), base, alpha) : null;

    for (const e of state.entities) {
      let view = views.get(e.id);
      if (!view) {
        view = makeView(e);
        views.set(e.id, view);
        stage.appendChild(view.el);
      }

      const over = overrides?.get(e.id);
      const pos = interp(prevById?.get(e.id), e, alpha);
      let x = pos.x;
      let y = pos.y - hiccupLift(e, cfg);
      let rotate = 0;
      let depth = pos.y;

      // A tower member sits on the *drawn* head below it, not the engine's flat
      // 62px stand-in: the seated art is shorter than the walking art, and by a
      // different amount per facing. The sim keeps one number (art data has no
      // business in sim state); the correction lives here, and is eased in across
      // the hop so a climber never jumps at the moment it lands.
      const riding = e.mode === MODE.RIDING;
      const flying = e.mode === MODE.MOUNTING && state.stack.phase === PHASE.FLIGHT;
      if ((riding || flying) && base) {
        const level = riding ? e.stackLevel : state.stack.mountIdx + 1;
        const drop = level * (cfg.riderRise - seatRise(base.dir));
        y += flying ? drop * Math.min(1, state.stack.flight / cfg.mountHopTicks) : drop;
        // Riders must draw over the base they sit on; their own (smaller) y would
        // sort them behind it.
        if (riding) depth = basePos.y + level;
      }
      if (riding) rotate = drawRider(view, e, e.dir, riderSway(state.tick, e.stackLevel, cfg), cfg);
      else hideRider(view);

      // transform + depth
      const transform = rotate
        ? `translate(${x}px, ${y}px) rotate(${rotate}deg)`
        : `translate(${x}px, ${y}px)`;
      if (transform !== view.transform) {
        view.el.style.transform = transform;
        view.transform = transform;
      }
      const z = e.flying ? 9999 : Math.round(depth);
      if (z !== view.zIndex) {
        view.el.style.zIndex = z;
        view.zIndex = z;
      }

      // facing + cel
      const face = FACING[over?.dir ?? facingOf(e, cfg)];
      if (view.facingKey !== face.name) {
        view.inner.className = `panda_inner_wrapper facing_${face.name}`;
        view.facingKey = face.name;
      }
      const column = celColumn(view, e.anim, dtMs, forcedColumn(e, state, cfg));
      const celKey = `${column}:${face.rowIndex}`;
      if (view.celKey !== celKey) {
        view.sprite.style.marginLeft = `-${column * CELL}px`;
        view.sprite.style.marginTop = `-${face.rowIndex * CELL}px`;
        view.celKey = celKey;
      }

      // state classes — cosmetic only now (the engine owns what `.stop` used to
      // imply: whether the visual position snaps to the logical one or eases).
      const cls =
        (riding ? ' riding' : '') +
        (e.flying ? ' flying' : '') +
        (e.hasHat && e.mode === MODE.OBSERVING && e.anim === ANIM.IDLE ? ' observing' : '') +
        (over?.hatless ? ' hatless' : '');
      if (cls !== view.classKey) {
        view.el.className = `panda_wrapper${cls}`;
        view.classKey = cls;
      }
    }
  }

  // Drop every panda (a resize rebuilds the world from a fresh seed).
  function clear() {
    for (const view of views.values()) view.el.remove();
    views.clear();
  }

  return { sync, clear, views };
}
