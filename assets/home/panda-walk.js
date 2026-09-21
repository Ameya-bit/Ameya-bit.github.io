// The hat panda walks the home page's road.
//
// One figure, driven entirely by scroll position — no engine, no sim, no clock
// of its own beyond an idle timer. At the top of the page it stands large in
// the hero's stage box. Over the first stretch of scroll it shrinks and steps
// down onto the timeline's spine; from there its place on the spine is a
// linear read of how far the page has been scrolled, so it reaches the end of
// the road exactly when the reader does, and sits down. Scrolling back up turns
// it around.
//
// The drawing is the engine's own sprite sheet (render/art.js is a pure string
// module: no DOM, no state), so this is the same panda, hat and all.
//
// Reduced motion: the panda is parked in the hero and never moves. The era
// nodes still fill as they scroll past the middle of the screen.

import { SPRITE_HAT, looseHatSvg } from '../pandas/engine/render/art.js';
import { ROW } from '../pandas/engine/render/cels.js';

const CELL = 48;              // the sheet is drawn at one sprite unit per CSS px
// (the walker's size on the road is CSS's call: --cv-marker-scale, whole numbers)
const WALK = [0, 1, 2, 1];    // contact, dip, contact, dip
const COL_IDLE = 1;           // legs together: a settled stand
const COL_REST = 9;           // a get-up cel, front view: the panda sitting, hat off
const STRIDE_PX = 9;          // distance per walk cel, in sprite units (so it scales with the panda)
const ANCHOR = 0.42;          // where on the screen the walker joins the road
const MIN_APPROACH_PX = 140;  // never finish the hero-to-road move in less scroll
const END_MARGIN_PX = 24;     // arrive just before the page runs out
const IDLE_MS = 160;          // no scroll for this long: stop walking
const REST_MS = 520;          // idle this long at the end of the road: sit down

const root = document.querySelector('.cv');
const stage = root && root.querySelector('.cv-stage');
const eras = root && root.querySelector('.cv-eras');
const end = root && root.querySelector('.cv-end');
if (root && stage && eras && end) start();

function start() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const walker = document.createElement('div');
  walker.className = 'cv-walker is-parked';
  walker.setAttribute('aria-hidden', 'true');
  walker.innerHTML = `<div class="cv-sheet-flip"><div class="cv-sheet">${SPRITE_HAT}</div></div>`;
  const sheet = walker.querySelector('.cv-sheet');

  const hat = document.createElement('div');
  hat.className = 'cv-hat';
  hat.setAttribute('aria-hidden', 'true');
  hat.hidden = true;
  hat.innerHTML = looseHatSvg();

  stage.replaceChildren();   // the no-script fallback image comes out
  root.append(walker, hat);

  const eraEls = [...root.querySelectorAll('.cv-era')];
  let geo = null;            // measured layout, in the root's coordinate space
  let lastY = window.scrollY;
  let lastPos = null;
  let travelled = 0;
  let heading = 'down';
  let idleTimer = 0;
  let restTimer = 0;
  let resting = false;
  let queued = false;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const ease = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  function measure() {
    const r = root.getBoundingClientRect();
    const rel = (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
    };
    const s = rel(stage);
    const spine = rel(root.querySelector('.cv-spine'));
    const rootTop = r.top + window.scrollY;
    const spineTop = spine.y;
    const spineBottom = spine.y + spine.h;
    const vh = window.innerHeight;
    // s0: the scroll at which the panda lands on the road. s1Wish: where it
    // would like to reach the end — capped against the page's real length at
    // render time (endScroll), because late-loading fonts and images change
    // the document's height without resizing anything this module observes.
    const s0 = Math.max(rootTop + spineTop - ANCHOR * vh, MIN_APPROACH_PX);
    const s1Wish = rootTop + spineBottom - ANCHOR * vh;
    const marker = parseFloat(getComputedStyle(root).getPropertyValue('--cv-marker-scale')) || 1;
    geo = {
      marker,
      hero: { x: s.x, y: s.y, scale: s.w / CELL },
      spineX: spine.x,
      spineTop,
      spineBottom,
      s0,
      s1Wish,
      nodes: eraEls.map((el) => rel(el).y + 12),
    };
  }

  function endScroll() {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    return Math.max(geo.s0 + 1, Math.min(geo.s1Wish, maxScroll - END_MARGIN_PX));
  }

  function showCel(col, rowName, flipped) {
    sheet.style.transform = `translate(${-col * CELL}px, ${-ROW[rowName] * CELL}px)`;
    walker.classList.toggle('is-flipped', flipped);
  }

  function render(moving) {
    if (!geo) return;
    const y = window.scrollY;
    const t = ease(clamp01(y / geo.s0));
    const u = clamp01((y - geo.s0) / (endScroll() - geo.s0));
    const roadY = lerp(geo.spineTop, geo.spineBottom, u);

    const scale = lerp(geo.hero.scale, geo.marker, t);
    // on the road the cell is centred on the spine; in the hero it fills the stage.
    // Once on the road it sits on whole pixels, so the sprite's edges stay square.
    const half = (CELL * geo.marker) / 2;
    const snap = t === 1 ? Math.round : (v) => v;
    const px = snap(lerp(geo.hero.x, geo.spineX - half, t));
    const py = snap(lerp(geo.hero.y, roadY - half, t));
    walker.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;

    const feetY = py + (CELL / 2) * scale;
    eraEls.forEach((el, i) => el.classList.toggle('is-passed', t === 1 && feetY >= geo.nodes[i] - 1));

    if (lastPos) travelled += Math.hypot(px - lastPos.x, py - lastPos.y) / scale;
    lastPos = { x: px, y: py };

    const parked = y <= 0;
    walker.classList.toggle('is-parked', parked);

    if (resting) {
      showCel(COL_REST, 'down', false);
      hat.hidden = false;
      hat.style.transform =
        `translate(${px - 24 * geo.marker}px, ${py + (CELL - 19) * geo.marker}px) scale(${geo.marker})`;
      return;
    }
    hat.hidden = true;

    if (!moving || parked) {
      showCel(COL_IDLE, 'down', false);
      return;
    }
    const col = WALK[Math.floor(travelled / STRIDE_PX) % WALK.length];
    const onRoad = t === 1;
    if (heading === 'down') showCel(col, onRoad ? 'down' : 'dDown', !onRoad); // down, or down-left
    else showCel(col, onRoad ? 'up' : 'dUp', false);                           // up, or up-right
  }

  function onScroll() {
    const y = window.scrollY;
    if (y !== lastY) heading = y > lastY ? 'down' : 'up';
    lastY = y;
    resting = false;
    clearTimeout(idleTimer);
    clearTimeout(restTimer);
    idleTimer = setTimeout(() => {
      render(false);
      if (geo && window.scrollY >= endScroll()) {
        restTimer = setTimeout(() => { resting = true; render(false); }, REST_MS);
      }
    }, IDLE_MS);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(true); });
  }

  function markPassedStatic() {
    // no walker to pass them, so a node fills once it is well inside the screen
    // (three-quarters down: the last node never gets as high as the anchor)
    const line = window.innerHeight * 0.75;
    eraEls.forEach((el) => el.classList.toggle('is-passed', el.getBoundingClientRect().top + 12 <= line));
  }

  function relayout() {
    measure();
    lastPos = null;
    if (reduced) {
      walker.style.transform =
        `translate(${geo.hero.x}px, ${geo.hero.y}px) scale(${geo.hero.scale})`;
      showCel(COL_IDLE, 'down', false);
      markPassedStatic();
      return;
    }
    render(false);
  }

  new ResizeObserver(relayout).observe(root);
  window.addEventListener('resize', relayout);
  window.addEventListener('load', relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  window.addEventListener('scroll', reduced ? markPassedStatic : onScroll, { passive: true });
  relayout();

  // for the console, and for measuring the thing without watching it
  window.__walk = { get geo() { return geo && { ...geo, s1: endScroll() }; }, get resting() { return resting; }, walker };
}
