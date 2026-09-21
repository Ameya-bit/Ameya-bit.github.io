// The hat panda walks the home page's road.
//
// One figure, no engine, no sim. It has two places to be:
//
//   THE HERO   standing large in the stage box at the top of the page.
//   THE ROAD   small, on the timeline's spine. Its place on the spine is a
//              linear read of how far the page has been scrolled, so it reaches
//              the end of the road exactly when the reader does, and sits down.
//
// and one way between them: A JUMP. When the reader scrolls past the jump line
// the panda leaps from the hero to the head of the road in one timed arc; when
// they come back above it, it leaps home. The jump runs on a clock, not on the
// scroll position, so it always finishes — stop scrolling mid-leap, or keep
// scrolling through it, and it lands either way. (It was scroll-scrubbed once:
// the panda could be parked halfway, standing on the intro paragraph.)
//
// The legs run on the engine's own cel clock (FRAME_MS), not on distance
// covered: tied to distance, a fast scroll made them a blur.
//
// The drawing is the engine's own sprite sheet (render/art.js is a pure string
// module: no DOM, no state), so this is the same panda, hat and all.
//
// Reduced motion: the panda is parked in the hero and never moves. The era
// nodes still fill as they come well inside the screen.

import { SPRITE_HAT, looseHatSvg } from '../pandas/engine/render/art.js';
import { ROW, FRAME_MS } from '../pandas/engine/render/cels.js';

const CELL = 48;              // the sheet is drawn at one sprite unit per CSS px
// (the walker's size on the road is CSS's call: --road-marker-scale, whole numbers)
const WALK = [0, 1, 2, 1];    // contact, dip, contact, dip
const COL_IDLE = 1;           // legs together: a settled stand
const COL_LEAP = 0;           // the contact stride, legs apart: reads as a leap in the air
const COL_REST = 9;           // a get-up cel, front view: the panda sitting, hat off
const ANCHOR = 0.42;          // where on the screen the walker starts down the road
const END_MARGIN_PX = 24;     // arrive just before the page runs out
const IDLE_MS = 160;          // no scroll for this long: stop walking
const REST_MS = 520;          // idle this long at the end of the road: sit down

const JUMP_MS = 620;          // the whole leap, hero to road or back
const JUMP_LINE_PX = 48;      // scroll this far and it jumps...
const JUMP_BACK_PX = 16;      // ...and come back above this and it jumps home (the gap stops flapping)
const LANDING_CLEAR_PX = 170; // never jump to a landing spot this close to the screen's bottom edge
const ARC_FRACTION = 0.22;    // the leap's height, as a share of the distance covered

const root = document.querySelector('.road');
const stage = root && root.querySelector('.road-stage');
const eras = root && root.querySelector('.road-eras');
const end = root && root.querySelector('.road-end');
if (root && stage && eras && end) start();

function start() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const walker = document.createElement('div');
  walker.className = 'road-walker is-parked';
  walker.setAttribute('aria-hidden', 'true');
  walker.innerHTML = `<div class="road-sheet-flip"><div class="road-sheet">${SPRITE_HAT}</div></div>`;
  const sheet = walker.querySelector('.road-sheet');

  const hat = document.createElement('div');
  hat.className = 'road-hat';
  hat.setAttribute('aria-hidden', 'true');
  hat.hidden = true;
  hat.innerHTML = looseHatSvg();

  stage.replaceChildren();   // the no-script fallback image comes out
  root.append(walker, hat);

  const eraEls = [...root.querySelectorAll('.road-era')];
  let geo = null;            // measured layout, in the root's coordinate space
  let lastY = window.scrollY;
  let heading = 'down';
  let scrolling = false;
  let onRoad = false;        // where the panda is headed: the road, or the hero
  let jump = 0;              // 0 = in the hero, 1 = on the road, between = in the air
  let jumpFrame = 0;
  let jumpClock = 0;
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
    const spine = rel(root.querySelector('.road-spine'));
    const rootTop = r.top + window.scrollY;
    const vh = window.innerHeight;
    const marker = parseFloat(getComputedStyle(root).getPropertyValue('--road-marker-scale')) || 1;
    // jumpLine: the scroll at which the panda leaves the hero — a nudge of
    // scroll, or later if the head of the road would still be hidden under the
    // fixed foot. s0: where the road starts to move under it. s1Wish: where it
    // would like to reach the end (capped against the page's real length at
    // render time, because late fonts and images change the document's height
    // without resizing anything this module observes).
    const jumpLine = Math.max(JUMP_LINE_PX, rootTop + spine.y - (vh - LANDING_CLEAR_PX));
    geo = {
      marker,
      hero: { cx: s.x + s.w / 2, cy: s.y + s.h / 2, scale: s.w / CELL },
      spineX: spine.x,
      spineTop: spine.y,
      spineBottom: spine.y + spine.h,
      jumpLine,
      s0: Math.max(rootTop + spine.y - ANCHOR * vh, jumpLine + 1),
      s1Wish: rootTop + spine.y + spine.h - ANCHOR * vh,
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

  function render() {
    if (!geo) return;
    const y = window.scrollY;
    const u = clamp01((y - geo.s0) / (endScroll() - geo.s0));
    const roadY = lerp(geo.spineTop, geo.spineBottom, u);

    // Both ends of the leap are live: the road end moves as the page scrolls,
    // so a jump taken while scrolling still lands on the panda's real place.
    const e = ease(jump);
    const inAir = jump > 0 && jump < 1;
    const span = Math.hypot(geo.spineX - geo.hero.cx, roadY - geo.hero.cy);
    const arc = inAir ? Math.sin(Math.PI * jump) * span * ARC_FRACTION : 0;
    const scale = lerp(geo.hero.scale, geo.marker, e);
    const size = CELL * scale;
    // at rest on the road it sits on whole pixels, so the sprite's edges stay square
    const snap = jump === 1 ? Math.round : (v) => v;
    const px = snap(lerp(geo.hero.cx, geo.spineX, e) - size / 2);
    const py = snap(lerp(geo.hero.cy, roadY, e) - arc - size / 2);
    walker.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;

    const feetY = py + size / 2;
    eraEls.forEach((el, i) => el.classList.toggle('is-passed', jump === 1 && feetY >= geo.nodes[i] - 1));
    walker.classList.toggle('is-parked', jump === 0);

    if (resting && jump === 1) {
      showCel(COL_REST, 'down', false);
      hat.hidden = false;
      hat.style.transform =
        `translate(${px - 24 * geo.marker}px, ${py + (CELL - 19) * geo.marker}px) scale(${geo.marker})`;
      return;
    }
    hat.hidden = true;

    if (inAir) {
      // leaping down-left to the road, or up-right back to the hero
      if (onRoad) showCel(COL_LEAP, 'dDown', true);
      else showCel(COL_LEAP, 'dUp', false);
      return;
    }
    if (jump === 0 || !scrolling) {
      showCel(COL_IDLE, 'down', false);
      return;
    }
    const col = WALK[Math.floor(performance.now() / FRAME_MS) % WALK.length];
    showCel(col, heading === 'down' ? 'down' : 'up', false);
  }

  // The leap's clock. Runs until it lands, whatever the scroll is doing.
  function stepJump(now) {
    const dt = now - jumpClock;
    jumpClock = now;
    const dir = onRoad ? 1 : -1;
    jump = clamp01(jump + (dir * dt) / JUMP_MS);
    render();
    const landed = onRoad ? jump === 1 : jump === 0;
    jumpFrame = landed ? 0 : requestAnimationFrame(stepJump);
    if (landed) armRest();
  }

  function aim() {
    const y = window.scrollY;
    const want = onRoad ? y > geo.jumpLine - (JUMP_LINE_PX - JUMP_BACK_PX) : y > geo.jumpLine;
    if (want === onRoad) return;
    onRoad = want;
    if (!jumpFrame) {
      jumpClock = performance.now();
      jumpFrame = requestAnimationFrame(stepJump);
    }
  }

  function armRest() {
    clearTimeout(restTimer);
    if (geo && jump === 1 && window.scrollY >= endScroll()) {
      restTimer = setTimeout(() => { resting = true; render(); }, REST_MS);
    }
  }

  function onScroll() {
    const y = window.scrollY;
    if (y !== lastY) heading = y > lastY ? 'down' : 'up';
    lastY = y;
    resting = false;
    scrolling = true;
    clearTimeout(idleTimer);
    clearTimeout(restTimer);
    idleTimer = setTimeout(() => { scrolling = false; render(); armRest(); }, IDLE_MS);
    aim();
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  }

  function markPassedStatic() {
    // no walker to pass them, so a node fills once it is well inside the screen
    // (three-quarters down: the last node never climbs as high as the anchor)
    const line = window.innerHeight * 0.75;
    eraEls.forEach((el) => el.classList.toggle('is-passed', el.getBoundingClientRect().top + 12 <= line));
  }

  function relayout() {
    measure();
    if (reduced) {
      const size = CELL * geo.hero.scale;
      walker.style.transform =
        `translate(${geo.hero.cx - size / 2}px, ${geo.hero.cy - size / 2}px) scale(${geo.hero.scale})`;
      showCel(COL_IDLE, 'down', false);
      markPassedStatic();
      return;
    }
    // A page opened part-way down starts with the panda already on the road:
    // a leap nobody asked for, across a screen nobody is looking at, is noise.
    if (!jumpFrame && jump === 0 && window.scrollY > geo.jumpLine) { onRoad = true; jump = 1; }
    render();
  }

  new ResizeObserver(relayout).observe(root);
  window.addEventListener('resize', relayout);
  window.addEventListener('load', relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  window.addEventListener('scroll', reduced ? markPassedStatic : onScroll, { passive: true });
  relayout();

  // for the console, and for measuring the thing without watching it
  window.__walk = {
    get geo() { return geo && { ...geo, s1: endScroll() }; },
    get resting() { return resting; },
    get jump() { return jump; },
    walker,
  };
}
