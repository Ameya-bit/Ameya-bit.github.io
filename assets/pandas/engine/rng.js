// Seeded PRNG for the panda sim — the whole point is determinism.
//
// The engine must produce byte-identical trajectories in Node (golden traces,
// trainer) and the browser (shipped site). `Math.random()` is banned inside the
// engine (see tools/lint-determinism.js); every draw goes through here, and the
// generator's entire state is a single uint32 that lives *inside* sim state and
// is threaded through `step(state, actions) -> state`. That makes a rollout a
// pure function of (initial seed, action stream), and lets any tick be
// snapshotted, serialised, and replayed exactly.
//
// Algorithm: mulberry32 — a fast, well-distributed 32-bit generator. Integer ops
// only (Math.imul, shifts, xor), so it is bit-identical across every JS engine.

const INC = 0x6d2b79f5;

// The pure primitive: advance the generator by one step.
// `state` is a uint32; returns the next state and a float in [0, 1).
// This is what makes the RNG serialisable — no hidden closure state.
export function mulberry32Next(state) {
  let a = (state + INC) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: a | 0, value };
}

// Ergonomic wrapper for use *inside* a single `step()` call: construct it from
// the integer seed in sim state, draw as many values as the tick needs, then
// write `.state` back into the new sim state. Purity is preserved at the tick
// boundary — the input integer fully determines every draw and the output
// integer — while the call site stays readable.
//
// The helper methods mirror the semantics of the constants the original
// pandas.js used, so ported behaviour draws the same *distributions*:
//   rand(n)         -> ceil1(n)   : integer in [1, n]
//   pick(arr)       -> pick(arr)  : uniform element
//   Math.random()*k -> float(0,k) / next()
export class Rng {
  constructor(state) {
    // Normalise to a uint32 seed. Accept any integer; reject non-finite input
    // loudly rather than silently seeding from NaN (which would desync a trace).
    if (!Number.isFinite(state)) {
      throw new RangeError(`Rng seed must be a finite number, got ${state}`);
    }
    this.state = state | 0;
  }

  // Float in [0, 1).
  next() {
    const r = mulberry32Next(this.state);
    this.state = r.state;
    return r.value;
  }

  // Integer in [0, n) — like `Math.floor(Math.random() * n)`.
  int(n) {
    return Math.floor(this.next() * n);
  }

  // Integer in [1, n] — matches the original `rand = n => Math.ceil(Math.random() * n)`.
  ceil1(n) {
    return Math.ceil(this.next() * n);
  }

  // Integer in [lo, hi] inclusive.
  intBetween(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  // Float in [lo, hi).
  float(lo, hi) {
    return lo + this.next() * (hi - lo);
  }

  // Uniform element — matches the original `pick = arr => arr[floor(random()*len)]`.
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // True with probability p — for the `Math.random() < P` idioms.
  chance(p) {
    return this.next() < p;
  }
}
