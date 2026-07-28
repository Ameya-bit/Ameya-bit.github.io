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
// already exact everywhere. `pow`/`atan2` are deliberately NOT exported — nothing
// in the sim needs them, and re-introducing an unpinned one would quietly reopen
// the hole. Use `sq(x)` rather than `x ** 2`: exponentiation is specified in terms
// of Math.pow, and carries the same implementation-defined licence.
//
// **`exp` was added in Phase D, pinned the same way.** The policy net's attention
// softmax needs it, and a policy is not a bystander to determinism: its action goes
// straight into `step`, so an engine that computed `exp` one ULP differently would
// diverge the whole episode exactly as `Math.sin` did. Same treatment, therefore —
// argument reduction in plain arithmetic, a Taylor core, and an exactly-built table
// of powers of two — rather than an exemption for the one module that wanted it.
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

// ---- exp ----
//
// exp(x) = 2^k * exp(r), with k = round(x / ln2) so |r| <= ln2/2 ~ 0.347, where a
// short Taylor series is tight. Three details make it reproducible:
//
//  1. **ln2 is carried in two halves.** `x - k*LN2` would round k*LN2 once, and that
//     rounding is multiplied by k; splitting ln2 into a head with trailing zero bits
//     plus a small tail keeps the reduction faithful across the whole range.
//  2. **2^k is a table, built by exact doubling and halving from 1.0.** Every entry
//     is a power of two, so every step is exact — including the subnormals below
//     2^-1022, which are still exactly representable. No `Math.pow` anywhere.
//  3. **The series runs a fixed number of terms.** No convergence test, so no
//     data-dependent branch that could resolve differently under a different FPU
//     rounding mode. 13 terms is past double precision on |r| <= 0.347.
const LN2_HI = 0.6931471803691238; // ln2 with its low 20 bits cleared…
const LN2_LO = 1.9082149292705877e-10; // …and the rest
const INV_LN2 = 1.4426950408889634;

const POW2_MIN = -1074; // the smallest subnormal, 2^-1074
const POW2_MAX = 1023;
const POW2 = (() => {
  const t = new Float64Array(POW2_MAX - POW2_MIN + 1);
  const zero = -POW2_MIN;
  t[zero] = 1;
  for (let k = 1; k <= POW2_MAX; k++) t[zero + k] = t[zero + k - 1] * 2;
  for (let k = -1; k >= POW2_MIN; k--) t[zero + k] = t[zero + k + 1] / 2;
  return t;
})();

// exp(r) - 1 is not what we want here (no need for expm1's accuracy near 0), so the
// plain series is evaluated by Horner from the smallest term up.
const E2 = 1 / 2;
const E3 = 1 / 6;
const E4 = 1 / 24;
const E5 = 1 / 120;
const E6 = 1 / 720;
const E7 = 1 / 5040;
const E8 = 1 / 40320;
const E9 = 1 / 362880;
const E10 = 1 / 3628800;
const E11 = 1 / 39916800;
const E12 = 1 / 479001600;
const E13 = 1 / 6227020800;

function expCore(r) {
  return 1 + r * (1 + r * (E2 + r * (E3 + r * (E4 + r * (E5 + r * (E6 + r * (E7 + r
    * (E8 + r * (E9 + r * (E10 + r * (E11 + r * (E12 + r * E13)))))))))))); // eslint-disable-line
}

export function exp(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  const k = Math.round(x * INV_LN2);
  if (k > POW2_MAX) return Infinity;
  // Below the table the result is zero. Measured against `Math.exp` this is exact
  // everywhere except the last handful of subnormals — `exp(-745)` returns 0 where
  // Math.exp returns 5e-324 — because the reduction picks k = -1075, one below the
  // smallest power of two. Stated rather than chased: the only caller is a softmax
  // whose inputs are shifted to <= 0, where 1e-324 and 0 are the same answer.
  if (k < POW2_MIN) return 0;
  const r = (x - k * LN2_HI) - k * LN2_LO;
  return POW2[k - POW2_MIN] * expCore(r);
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
