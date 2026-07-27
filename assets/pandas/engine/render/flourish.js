// The hand-authored character beats — the two things the sim deliberately leaves
// out (design/panda-policy-net.md: "Decisions learned; look hand-made").
//
//   1. The gaze flourish. While he is planted and settled, his facing drifts —
//      mostly onto his subject, sometimes onto a bystander beside it, occasionally
//      off to the side. Purely a drawn facing: it is handed to the renderer as an
//      override and never written into state, so a policy's world is unchanged by
//      where he happens to be looking.
//
//   2. The hat-drop and fetch skit. Knock him over and the straw hat comes off,
//      lands nearby, and he goes and gets it — the beat that says the line was
//      crossed and he is climbing back over it. The *walk* is real (he has to get
//      there), so rather than smuggle a second movement system into the sim, the
//      skit drives the same 17-way action seam a trained policy will: it returns
//      one action per tick while it owns him, and null the rest of the time.
//
// Both are pure presentation in the sense that matters: `step()` is untouched, and
// a headless rollout (Node, the trainer) never runs this file at all.

import { MODE, ANIM } from '../state.js';
import { DIRS, headingDir } from '../dirs.js';
import { ACTION, stepAction } from '../actions.js';
import { watchedTarget } from '../watcher.js';
import { TICKS_PER_ACTION } from '../tick.js';
import { HAT_FIT } from './art-data.js';
import { CELL, DIR_SPRITE } from './cels.js';
import { looseHatSvg } from './art.js';

// ---- gaze ----
const GAZE_MIN_MS = 1800; // hold each gaze target ~2–4s before shifting
const GAZE_MAX_MS = 4200;
const GAZE_SUBJECT_P = 0.55; // …mostly the subject itself
const GAZE_BYSTANDER_P = 0.8; // …then whoever is nearest it
const GAZE_OFFSET = 60; // …else a glance to the side of it (px)
const GAZE_DEADZONE = 8; // the original's tight facing tolerance for a look

// ---- the hat skit ----
const SPRITE_UNIT = CELL / 48; // the sprite's own grid -> stage px
const TOSS_SPREAD = 70; // how far sideways the hat can land
const TOSS_FORWARD_MIN = 24; // …and how far in front of him
const TOSS_FORWARD_SPREAD = 26;
const TOSS_SPIN_DEG = 34; // the calm drop, not a launch
// Where he plants himself, relative to the hat's element, to pick it up: the
// wrapper's top-left goes up and left of the hat so his body lands over it.
export const FETCH_GRAB_X = 32;
export const FETCH_GRAB_Y = 50;
const FETCH_STRIDE_DECISIONS = 3; // the sprint back (300 ms) — quicker than his amble
const FETCH_MAX_STRIDES = 30; // never chase forever
const FETCH_PAUSE_DECISIONS = 8; // the beat where he stands over it (~750 ms)
const HAT_EDGE_PAD = 6; // keep the dropped hat on stage

const rand = (n) => Math.random() * n;

export function makeFlourish(stage) {
  // gaze
  let gazeHold = 0; // ms left on the current gaze target
  let gazeAt = null; // {x, y} in logical space, or null to look at the subject
  let gazeDir = -1; // the facing it resolves to

  // the skit
  let hatState = 'worn'; // worn -> dropped -> fetching -> pausing -> worn
  let hatEl = null;
  let hatRest = null; // {x, y} where it lies
  let strideTimer = 0;
  let strides = 0;
  let pause = 0;
  let wasKnocked = false;

  const overrides = new Map();

  const hatOf = (state) => state.entities.find((e) => e.hasHat) ?? null;

  // ---- the hat on the ground ----

  function dropHat(hat, cfg) {
    // It leaves from where it was worn: the seat of the hat in his current facing,
    // in the sprite's own 48-unit grid, scaled onto the stage.
    const seat = HAT_FIT[DIR_SPRITE[DIRS[hat.dir]] ?? 'down'][0];
    const hx = hat.x + Math.round(seat.x * SPRITE_UNIT);
    const hy = hat.y + Math.round(seat.y * SPRITE_UNIT);
    const rx = Math.max(HAT_EDGE_PAD, Math.min(cfg.width - 54, hx + rand(TOSS_SPREAD) - TOSS_SPREAD / 2));
    const ry = Math.max(HAT_EDGE_PAD, Math.min(cfg.height - 24, hy + TOSS_FORWARD_MIN + rand(TOSS_FORWARD_SPREAD)));

    hatEl = document.createElement('div');
    hatEl.className = 'hat_loose';
    hatEl.innerHTML = looseHatSvg();
    hatEl.style.left = `${hx}px`;
    hatEl.style.top = `${hy}px`;
    hatEl.style.zIndex = String(Math.round(ry));
    stage.appendChild(hatEl);
    // Two frames of settle time before the transition target is set, or the
    // browser collapses it into the initial layout and the hat teleports.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (hatEl) hatEl.style.transform = `translate(${rx - hx}px, ${ry - hy}px) rotate(${TOSS_SPIN_DEG}deg)`;
      }),
    );
    hatRest = { x: rx, y: ry };
    hatState = 'dropped';
  }

  function clearHat() {
    if (!hatEl) return;
    const el = hatEl;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
    hatEl = null;
    hatRest = null;
  }

  // ---- the seam: one action per tick while the skit owns him ----

  // Returns an action integer to override the rules expert with, or null to let it
  // drive. `state` is the tick about to be stepped, so the action lands on the tick
  // after it — hence the `+ 1` in the decision test. While the skit owns him the
  // expert does not run at all, so he cannot dodge mid-fetch: he is preoccupied,
  // which is the joke, and is what the original did too.
  function action(state) {
    const hat = hatOf(state);
    if (!hat) return null;

    // Knocked: the hat comes off on the way down, once per knock.
    if (hat.mode === MODE.KNOCKED) {
      if (!wasKnocked && hatState === 'worn') dropHat(hat, state.cfg);
      wasKnocked = true;
      return null; // he is on the floor; the engine ignores actions anyway
    }
    const justUp = wasKnocked;
    wasKnocked = false;

    if (hatState === 'worn' || !hatRest) return null;

    // Back on his feet with the hat still on the ground → go and get it.
    if (justUp || hatState === 'dropped') {
      hatState = 'fetching';
      strideTimer = 0;
      strides = 0;
    }

    // Everything below is paced in decision ticks; between them he just glides.
    if ((state.tick + 1) % TICKS_PER_ACTION !== 0) return ACTION.HOLD;

    if (hatState === 'pausing') {
      if (--pause > 0) return ACTION.HOLD;
      clearHat();
      hatState = 'worn';
      return null;
    }

    // fetching: stride toward it at the sprint cadence, HOLD in between.
    const dx = hatRest.x - FETCH_GRAB_X - hat.lx;
    const dy = hatRest.y - FETCH_GRAB_Y - hat.ly;
    const dir = headingDir(dx, dy);
    if (dir < 0 || strides > FETCH_MAX_STRIDES) {
      hatState = 'pausing';
      pause = FETCH_PAUSE_DECISIONS;
      return ACTION.HOLD;
    }
    if (--strideTimer > 0) return ACTION.HOLD;
    strideTimer = FETCH_STRIDE_DECISIONS;
    strides += 1;
    return stepAction(dir);
  }

  // ---- per-frame render overrides ----

  function pickGaze(state, hat, subject) {
    const r = Math.random();
    if (r < GAZE_SUBJECT_P) return null; // look right at it
    if (r < GAZE_BYSTANDER_P) {
      let best = null;
      let bd = Infinity;
      for (const q of state.entities) {
        if (q.hasHat || q.id === subject.id || q.entering) continue;
        const d = (q.lx - subject.lx) ** 2 + (q.ly - subject.ly) ** 2;
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
      if (best) return { x: best.lx, y: best.ly };
    }
    return {
      x: subject.lx + (Math.random() * 2 - 1) * GAZE_OFFSET,
      y: subject.ly + (Math.random() * 2 - 1) * GAZE_OFFSET,
    };
  }

  // Build this frame's per-entity overrides: the drawn facing while he is planted,
  // and whether he is currently bare-headed.
  function sync(state, dtMs) {
    overrides.clear();
    const hat = hatOf(state);
    if (!hat) return overrides;

    // The gaze only runs while he is settled — planted, nothing bearing down. The
    // moment he is walking, rolling or down, his facing is the sim's again.
    const planted = hat.mode === MODE.OBSERVING && hat.anim === ANIM.IDLE && hatState === 'worn';
    if (!planted) {
      gazeHold = 0;
      gazeAt = null;
      gazeDir = -1;
    } else {
      const subject = watchedTarget(state, hat);
      gazeHold -= dtMs;
      if (gazeHold <= 0) {
        gazeHold = GAZE_MIN_MS + rand(GAZE_MAX_MS - GAZE_MIN_MS);
        gazeAt = subject ? pickGaze(state, hat, subject) : null;
      }
      const look = gazeAt ?? (subject ? { x: subject.lx, y: subject.ly } : null);
      if (look) {
        const d = headingDir(look.x - hat.lx, look.y - hat.ly, GAZE_DEADZONE);
        if (d >= 0) gazeDir = d;
      }
    }

    const over = {};
    if (gazeDir >= 0 && planted) over.dir = gazeDir;
    if (hatState !== 'worn') over.hatless = true;
    if (over.dir !== undefined || over.hatless) overrides.set(hat.id, over);
    return overrides;
  }

  function destroy() {
    clearHat();
    hatState = 'worn';
  }

  return {
    action,
    sync,
    destroy,
    // The dev preview's readout (and a hook for a future "knock his hat off" button).
    get skit() {
      return hatState;
    },
    // Where the hat is lying, or null when he is wearing it.
    get hatRest() {
      return hatRest ? { ...hatRest } : null;
    },
  };
}
