// The blink: the one thing the standing panda does on its own.
//
// Cel 1 facing the reader has two ink eye patches, three rows tall on the
// left and two on the right. Closing them is eight face-white pixels laid over
// the sheet: the top row of each patch and the bottom of the left one, which
// leaves a one-pixel line on row 18 as the lid. Nothing else in the drawing
// changes, so the overlay can sit on top of the sheet instead of being a cel.
//
// The rhythm is a double blink, a long rest, a single, on the cel clock. It
// was chosen in the idle studio over breathing (a 48 px belly can only grow by
// whole pixels, so it never came out fluid), head bobs and glances: ma5a's own
// idles are one-pixel changes, and this is the smallest one that reads.

import { FRAME_MS } from '../pandas/engine/render/cels.js';

export const LID_PIXELS = [[18, 17], [19, 17], [20, 17], [26, 17], [27, 17], [28, 17], [18, 19], [19, 19]];
export const LID_FILL = '#fff';   // the sheet's own face white

// the loop, as [beats of FRAME_MS, eyes closed]: 6.86 s
export const BLINK_BEATS = [[19, false], [1, true], [1, false], [1, true], [26, false], [1, true]];
const LOOP_MS = BLINK_BEATS.reduce((n, [beats]) => n + beats, 0) * FRAME_MS;

export const blinkSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" shape-rendering="crispEdges">` +
  LID_PIXELS.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${LID_FILL}"/>`).join('') +
  '</svg>';

// Where the loop is at time t (ms, any monotonic clock): whether the eyes are
// closed, and how long until that changes. The state is a function of the
// clock, not of how many timers have fired, so a throttled background tab
// can delay a redraw but never shift the rhythm.
export function lidsAt(t) {
  let p = t % LOOP_MS;
  for (const [beats, closed] of BLINK_BEATS) {
    const d = beats * FRAME_MS;
    if (p < d) return { closed, next: d - p };
    p -= d;
  }
  return { closed: false, next: FRAME_MS };
}

// Runs the loop: onChange(closed) at every beat, and again when the tab comes
// back into view, until the returned stop() is called. Whether the lids are
// actually shown is the caller's call (only a panda standing and facing the
// reader has these eyes).
export function runBlink(onChange) {
  let timer = 0;
  const step = () => {
    const { closed, next } = lidsAt(performance.now());
    onChange(closed);
    timer = setTimeout(step, next + 1);
  };
  const onVisible = () => { if (!document.hidden) { clearTimeout(timer); step(); } };
  document.addEventListener('visibilitychange', onVisible);
  step();
  return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
}
