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

// The drop entrance's fall, presentation-side — the sim pins a dropper to its
// landing spot (state.js advanceEntranceDrop) and this lifts the drawing above
// the stage, exactly the hiccup-pop arrangement. Parked (aPhase 0) = held at the
// full lift, clipped above the stage top; airborne = a quadratic ease-in, so it
// lands at full speed. Lift is a function of state, so sync() can evaluate it at
// the previous tick too and interpolate — a 20 Hz fall drawn stepwise would judder.
function dropLift(e, cfg) {
  if (e.mode !== MODE.ENTERING || !e.flying) return 0;
  // 1.5 cells clears the stage top even for a scaled-up sprite (sizes.js can
  // grow the drawing ~30px past its cell).
  const liftMax = e.y + cfg.cell * 1.5;
  if (e.aPhase === 1) {
    const t = 1 - e.aCount / cfg.dropTicks;
    return liftMax * (1 - t * t);
  }
  if (e.aPhase === 2) {
    // The rebound: a small parabolic hop while the sim carries the ground
    // position along the bounce heading.
    const t = 1 - e.aCount / cfg.dropBounceTicks;
    return cfg.dropBounceRise * 4 * t * (1 - t);
  }
  return liftMax; // parked above the stage, clipped
}

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
function makeView(entity, scale = 1) {
  const el = document.createElement('div');
  el.className = 'panda_wrapper';
  el.innerHTML =
    '<div class="panda_inner_wrapper">' +
    `<div class="panda_sprite">${entity.hasHat ? SPRITE_HAT : SPRITE_BARE}</div>` +
    '</div>';
  // A scaled panda scales about its feet (the art stands on row ~81 of the 100px
  // cell), so every size shares one ground plane. Scale-1 pandas keep the
  // default origin — their rider sway pivot stays exactly as shipped.
  if (scale !== 1) el.style.transformOrigin = '50px 81px';
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
  // id -> visual scale (render/sizes.js). Presentation only — the host draws a
  // fresh map whenever it builds a world; an id missing here renders at 1.
  let scales = new Map();

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
    if (e.mode === MODE.ENTERING && e.flying) return 0; // dropping: carried, not walking
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
    if (e.mode === MODE.ENTERING && e.flying && e.aPhase === 1) {
      // A dropper tumbles ~2 turns on the way down, same trick as the pop above.
      const k = 1 - e.aCount / cfg.dropTicks;
      return wrapDir(e.dir + Math.round(k * 16));
    }
    if (e.mode === MODE.ENTERING && e.flying && e.aPhase === 2) {
      // …and one lazy turn through the rebound. The fall's two full turns end at
      // the spawn facing, so this continues from it without a snap.
      const k = 1 - e.aCount / cfg.dropBounceTicks;
      return wrapDir(e.dir + Math.round(k * 8));
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
        view = makeView(e, scales.get(e.id) ?? 1);
        views.set(e.id, view);
        stage.appendChild(view.el);
      }

      const over = overrides?.get(e.id);
      const prevE = prevById?.get(e.id);
      const pos = interp(prevE, e, alpha);
      let x = pos.x;
      let y = pos.y - hiccupLift(e, cfg)
        - (prevE ? lerp(dropLift(prevE, cfg), dropLift(e, cfg), alpha) : dropLift(e, cfg));
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
        // Each storey of the tower is as tall as the panda standing (or sitting)
        // in it, so the seat height sums the SCALES of everyone below — with a
        // uniform troupe this is exactly the old `level * per`.
        const per = cfg.riderRise - seatRise(base.dir);
        let drop = per * (scales.get(base.id) ?? 1);
        for (let l = 1; l < level; l++) {
          const rid = state.stack.riders[l - 1];
          drop += per * (rid == null ? 1 : (scales.get(rid) ?? 1));
        }
        y += flying ? drop * Math.min(1, state.stack.flight / cfg.mountHopTicks) : drop;
        // Riders must draw over the base they sit on; their own (smaller) y would
        // sort them behind it.
        if (riding) depth = basePos.y + level;
      }
      if (riding) rotate = drawRider(view, e, e.dir, riderSway(state.tick, e.stackLevel, cfg), cfg);
      else hideRider(view);

      // transform + depth
      const s = scales.get(e.id) ?? 1;
      let transform = `translate(${x}px, ${y}px)`;
      if (rotate) transform += ` rotate(${rotate}deg)`;
      if (s !== 1) transform += ` scale(${s})`;
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

  // Install this world's size map (render/sizes.js). Called before the first
  // sync of a build — views are created lazily after it, so each wrapper gets
  // its transform-origin from the scale it will wear.
  function setScales(next) {
    scales = next ?? new Map();
  }

  return { sync, clear, views, setScales };
}
