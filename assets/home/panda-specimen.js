// The colophon's panda specimens: one small stage per move, playing that move
// on a loop with the real sprite sheet, hat and cel timings.
//
// Each figure carries its script as JSON (written by tools/home/build.py from
// tools/home/animations.toml). A script is a list of actors; an actor is a
// list of steps run in order and looped. A step:
//
//   cel    "walk" | "stop" | "idle" | "fall" | "fallen" | "standUp" | "roll"
//          | "sit" | a column number.  Cycles play at their frame rate;
//          single cels hold.
//   row    "down" | "dDown" | "side" | "dUp" | "up"      (default: keep)
//   flip   mirror, for the left-facing headings          (default: keep)
//   ms     the step's length
//   dx dy  movement over the step, in sprite units (48 = one cell)
//   ease   "glide" (ma5a's 2 s ease-out, one per stride) | "sharp" (the
//          reverted 0.5 s snap) | "linear"
//   arc    a parabola lift over the step, in sprite units
//   spin   cycle through all eight facings, one every 55 ms
//   hat    "on" (default) | "off" | "ground" (loose, at the feet)
//   rider  true: draw the seated rider cel instead of the sheet
//   at     [x, y] absolute placement for this step (else continue)
//   hide   true: draw nothing but the loose hat (a hat on its own)
//   blink  true: the lids over the eyes (the idle cel, facing down, only)
//
// This is a player, not the engine: the moves that need the sim (the hat
// panda's decisions, the director's timing) are re-enacted here with the
// engine's own constants, and say so in their caption.

import { SPRITE_HAT, SPRITE_BARE, looseHatSvg, SIT } from '../pandas/engine/render/art.js';
import { ROW, ANIM_FRAMES, FRAME_MS } from '../pandas/engine/render/cels.js';
import { blinkSvg } from './panda-blink.js';

const CELL = 48;
const CYCLES = {
  walk: { cols: ANIM_FRAMES[0], ms: FRAME_MS },
  stop: { cols: [0], ms: FRAME_MS },
  idle: { cols: [1], ms: FRAME_MS },
  fall: { cols: ANIM_FRAMES[3], ms: FRAME_MS, hold: true },
  fallen: { cols: [7], ms: FRAME_MS },
  standUp: { cols: ANIM_FRAMES[5], ms: FRAME_MS, hold: true },
  roll: { cols: ANIM_FRAMES[6], ms: 58, hold: true },
  sit: { cols: [9], ms: FRAME_MS },
};
// the eight headings in turn, as spin3d steps through them
const SPIN = [
  ['down', false], ['dDown', false], ['side', false], ['dUp', false],
  ['up', false], ['dUp', true], ['side', true], ['dDown', true],
];
const SPIN_MS = 55;
const EASE_MS = { glide: 2000, sharp: 500 };
const glide = (t) => 1 - Math.pow(1 - t, 3);

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeActor(stage, scale) {
  const el = document.createElement('div');
  el.className = 'specimen-panda';
  el.innerHTML =
    `<div class="specimen-flip"><div class="specimen-sheet is-hat">${SPRITE_HAT}</div>` +
    `<div class="specimen-sheet is-bare" hidden>${SPRITE_BARE}</div>` +
    `<div class="specimen-sit" hidden></div>` +
    `<div class="specimen-blink" hidden>${blinkSvg()}</div></div>`;
  const hat = document.createElement('div');
  hat.className = 'specimen-hat';
  hat.hidden = true;
  hat.innerHTML = looseHatSvg();
  stage.append(el, hat);
  return {
    el, hat, scale,
    flipEl: el.firstElementChild,
    sheets: { on: el.querySelector('.is-hat'), off: el.querySelector('.is-bare') },
    sitEl: el.querySelector('.specimen-sit'),
    lids: el.querySelector('.specimen-blink'),
    x: 0, y: 0, row: 'down', flip: false,
  };
}

function draw(a, col, row, flip, hatMode, rider, x, y, lift, hide, blink) {
  const s = a.scale;
  a.el.hidden = hide;
  a.el.style.transform = `translate(${Math.round(x * s)}px, ${Math.round((y - lift) * s)}px) scale(${s})`;
  a.flipEl.classList.toggle('is-flipped', flip);
  const onHat = hatMode === 'on';
  a.sheets.on.hidden = rider || !onHat;
  a.sheets.off.hidden = rider || onHat;
  a.sitEl.hidden = !rider;
  a.lids.hidden = !blink;
  if (rider) {
    if (a.sitRow !== row) { a.sitEl.innerHTML = SIT[row].svg; a.sitRow = row; }
  } else {
    const sheet = onHat ? a.sheets.on : a.sheets.off;
    sheet.style.transform = `translate(${-col * CELL}px, ${-ROW[row] * CELL}px)`;
  }
  a.hat.hidden = hatMode !== 'ground';
  if (!a.hat.hidden) a.hat.style.transform = `translate(${Math.round((x - 20) * s)}px, ${Math.round((y + 30) * s)}px) scale(${s})`;
}

function runActor(a, steps) {
  const total = steps.reduce((n, st) => n + (st.ms ?? 0), 0) || 1;
  let sx = 0, sy = 0, x0 = 0, y0 = 0;
  // resolve the per-step starting positions once
  const starts = steps.map((st) => {
    if (st.at) { sx = st.at[0]; sy = st.at[1]; }
    const start = [sx, sy];
    sx += st.dx ?? 0; sy += st.dy ?? 0;
    return start;
  });
  const loopDx = sx, loopDy = sy;
  x0 = starts[0][0]; y0 = starts[0][1];

  return function at(elapsed) {
    let t = elapsed % total;
    let i = 0;
    while (i < steps.length - 1 && t >= (steps[i].ms ?? 0)) { t -= steps[i].ms ?? 0; i++; }
    const st = steps[i];
    const ms = st.ms || 1;
    const p = Math.min(1, t / ms);
    let frac = p;
    if (st.ease !== 'linear') {
      // one ease-out curve per stride; the position advances stride by stride
      const curve = EASE_MS[st.ease ?? 'glide'];
      const strides = Math.max(1, Math.round(ms / curve));
      const len = ms / strides;
      const k = Math.min(strides - 1, Math.floor(t / len));
      const q = Math.min(1, (t - k * len) / Math.min(len, curve));
      frac = (k + glide(q)) / strides;
    }
    const x = starts[i][0] + (st.dx ?? 0) * frac;
    const y = starts[i][1] + (st.dy ?? 0) * frac;
    const lift = st.arc ? Math.sin(Math.PI * p) * st.arc : 0;

    let row = st.row ?? a.row; let flip = st.flip ?? a.flip;
    a.row = row; a.flip = flip;
    let col = 1;
    if (st.spin) { const [r, f] = SPIN[Math.floor(t / SPIN_MS) % SPIN.length]; row = r; flip = f; col = 0; }
    else if (typeof st.cel === 'number') col = st.cel;
    else {
      const c = CYCLES[st.cel ?? 'idle'];
      const k = Math.floor(t / c.ms);
      col = c.hold ? c.cols[Math.min(k, c.cols.length - 1)] : c.cols[k % c.cols.length];
    }
    draw(a, col, row, flip, st.hat ?? 'on', !!st.rider, x, y, lift, !!st.hide, !!st.blink);
  };
}

function mount(fig) {
  const demo = JSON.parse(fig.dataset.demo);
  const stage = fig.querySelector('.specimen-stage');
  // 2x on whole pixels where the stage has room; 1x on a phone
  const scale = stage.getBoundingClientRect().width < 480 ? 1 : 2;
  stage.style.height = `${(demo.h ?? 1.5) * CELL * scale}px`;
  const actors = demo.actors.map((steps) => runActor(makeActor(stage, scale), steps));
  if (reduced) { actors.forEach((f) => f(0)); return; }
  let start = 0, raf = 0, visible = false;
  const frame = (now) => { if (!start) start = now; actors.forEach((f) => f(now - start)); raf = visible ? requestAnimationFrame(frame) : 0; };
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  }, { rootMargin: '80px' }).observe(fig);
}

document.querySelectorAll('.panda-specimen[data-demo]').forEach(mount);
