// Transcendental math for the engine — pinned, not borrowed.
//
// Elementary transcendentals are NOT guaranteed bit-identical across JS engines:
// the spec explicitly permits implementation-defined results for sin/cos/exp/pow.
// This module started as a thin pass-through to `Math`, on the assumption that
// Node and Chrome (the same V8 lineage) would agree — which is all the Phase-A
// Node-vs-browser gate needs.
//
// **That assumption was wrong, and the gate caught it (2026-07-27).** Node 25 and
// Chrome disagree on `Math.sin` by one ULP; 32 seeds x 10k ticks surfaced it at
// seed -626627309, tick 5189 — a stack rider's x differing by 1e-13 through the
// wobble, from which the two runs never reconverge. So `sin`/`cos` are computed
// here in plain arithmetic: +, -, *, / and Math.round, each of which IEEE-754
// pins to a single correctly-rounded result. Any conforming engine — Node, any
// browser, a future WASM trainer — now produces identical bits.
//
// `sqrt` stays native: IEEE-754 requires it to be correctly rounded, so it is
// already exact everywhere. `exp`/`pow`/`atan2` are deliberately NOT exported —
// nothing in the sim needs them, and re-introducing an unpinned one would quietly
// reopen the hole. Use `sq(x)` rather than `x ** 2`: exponentiation is specified
// in terms of Math.pow, and carries the same implementation-defined licence.
//
// The engine treats all of these as pure functions of their inputs — no state, no
// time. The determinism lint keeps raw `Math.sin` (and `**`) out of engine code so
// this stays the single chokepoint.

export const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

const QUARTER_PI = 0.7853981633974483;

// Taylor coefficients about 0. Each is one correctly-rounded division, evaluated
// at module load. Both series are only ever evaluated on |y| <= PI/4, where the
// truncation error is ~1e-14 — at the noise floor of double precision, so these
// track the native functions to within an ULP or two while being reproducible.
const S3 = -1 / 6;
const S5 = 1 / 120;
const S7 = -1 / 5040;
const S9 = 1 / 362880;
const S11 = -1 / 39916800;
const S13 = 1 / 6227020800;

const C2 = -1 / 2;
const C4 = 1 / 24;
const C6 = -1 / 720;
const C8 = 1 / 40320;
const C10 = -1 / 3628800;
const C12 = 1 / 479001600;

// The two series, valid (and tight) on |y| <= PI/4.
function sinCore(y) {
  const y2 = y * y;
  return y * (1 + y2 * (S3 + y2 * (S5 + y2 * (S7 + y2 * (S9 + y2 * (S11 + y2 * S13))))));
}

function cosCore(y) {
  const y2 = y * y;
  return 1 + y2 * (C2 + y2 * (C4 + y2 * (C6 + y2 * (C8 + y2 * (C10 + y2 * C12)))));
}

// Reduce onto [-PI, PI]. Plain arithmetic, hence reproducible; over the arguments
// the sim actually passes (a tick count against the wobble period) the reduction's
// own error is far below anything visible.
const reduce = (x) => x - TWO_PI * Math.round(x / TWO_PI);

export function sin(x) {
  if (!Number.isFinite(x)) return NaN;
  let y = reduce(x);
  // Fold onto [-PI/2, PI/2]: sin(PI - y) = sin(y).
  if (y > HALF_PI) y = PI - y;
  else if (y < -HALF_PI) y = -PI - y;
  // …and past PI/4, switch series rather than push one past its good range.
  if (y > QUARTER_PI) return cosCore(HALF_PI - y);
  if (y < -QUARTER_PI) return -cosCore(HALF_PI + y);
  return sinCore(y);
}

export function cos(x) {
  if (!Number.isFinite(x)) return NaN;
  let y = reduce(x);
  if (y < 0) y = -y; // cos is even
  let sign = 1;
  if (y > HALF_PI) {
    y = PI - y; // cos(PI - y) = -cos(y)
    sign = -1;
  }
  return sign * (y > QUARTER_PI ? sinCore(HALF_PI - y) : cosCore(y));
}

export const sqrt = Math.sqrt;
export const abs = Math.abs;
export const floor = Math.floor;
export const round = Math.round;
export const min = Math.min;
export const max = Math.max;

// Square. One multiplication — exact — where `x ** 2` is Math.pow and therefore
// implementation-defined. The distinction matters because the distance
// comparisons that use it run millions of times per rollout.
export const sq = (x) => x * x;

// 2-arg Euclidean distance. Defined as sqrt(x*x + y*y) rather than delegating to
// `Math.hypot`: hypot carries extra overflow/underflow guards that make it both
// slower and implementation-defined, and the sim only ever measures on-screen
// pixel distances, well inside float range.
export const hypot = (x, y) => sqrt(x * x + y * y);

// Clamp v to [lo, hi]. Ubiquitous in movement/boundary code; kept here so the
// engine has a single import surface for math helpers.
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// CSS's default `ease` timing function — cubic-bezier(0.25, 0.1, 0.25, 1). The
// original's glide was `transition: transform 2s`, whose default curve this is,
// so the shape of every stride in the shipped hero depends on getting it right:
// a brisk start (initial slope 0.4x average), a long settle, zero velocity at the
// end. An exponential filter has none of that shape — it holds a constant lag and
// has to decelerate through zero to reverse, which reads as sliding on ice.
//
// Progress p (elapsed / duration) is the curve's *x*; the returned eased fraction
// is its *y*, so x must be inverted first. With x1 = x2 = 0.25 the x polynomial is
// t^3 - 0.75t^2 + 0.75t, whose derivative bottoms out at 0.5625 — comfortably away
// from zero — so plain Newton from t = p converges to float precision in a few
// steps and needs no bisection guard. The iteration count is FIXED (no early exit)
// and every operation is +-*/ on doubles, which IEEE-754 specifies exactly: the
// result is bit-identical in Node and in the browser, like everything else here.
const EASE_ITERS = 6;
const AX = 1, BX = -0.75, CX = 0.75; // x(t) = ((AX*t + BX)*t + CX)*t
const AY = -1.7, BY = 2.4, CY = 0.3; // y(t) = ((AY*t + BY)*t + CY)*t

export function cssEase(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let t = p;
  for (let i = 0; i < EASE_ITERS; i++) {
    const err = ((AX * t + BX) * t + CX) * t - p;
    const slope = (3 * AX * t + 2 * BX) * t + CX;
    t -= err / slope;
  }
  return ((AY * t + BY) * t + CY) * t;
}
