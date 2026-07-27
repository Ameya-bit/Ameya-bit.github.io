// Transcendental math for the engine — routed through one module so it is swappable.
//
// Why wrap `Math.sin` at all: elementary transcendentals are NOT guaranteed
// bit-identical across JS engines (the spec permits implementation-defined
// results for sin/cos/exp/pow/etc.). On the same V8 (Node + Chrome) they agree,
// which is all the Phase-A golden traces (Node vs Chrome) require. But cross-
// browser determinism (Firefox/Safari) or a future WASM trainer may need a
// pinned polynomial implementation. Funnelling every engine call through here
// gives us exactly one place to swap in such an implementation later without
// touching sim logic. The determinism lint bans raw `Math.sin` etc. in engine
// code precisely so this stays the single chokepoint.
//
// The engine treats these as pure functions of their inputs — no state, no time.

export const sin = Math.sin;
export const cos = Math.cos;
export const exp = Math.exp;
export const pow = Math.pow;
export const atan2 = Math.atan2;
export const sqrt = Math.sqrt;
export const abs = Math.abs;
export const floor = Math.floor;
export const round = Math.round;
export const min = Math.min;
export const max = Math.max;
export const PI = Math.PI;

// 2-arg Euclidean distance. Defined as sqrt(x*x + y*y) rather than delegating to
// `Math.hypot`: hypot carries extra overflow/underflow guards that make it both
// slower and more prone to cross-engine variance than the plain form, and the
// sim only ever uses it for on-screen pixel distances well inside float range.
export const hypot = (x, y) => sqrt(x * x + y * y);

// Clamp v to [lo, hi]. Ubiquitous in movement/boundary code; kept here so the
// engine has a single import surface for math helpers.
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
