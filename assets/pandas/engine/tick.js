// The fixed-tick clock — the spine of the determinism refactor.
//
// The original pandas.js ran on wall-clock time: rAF, setTimeout chains, and
// constants denominated in milliseconds (FRAME_MS, HAT_MOVE_MS, ...) or pixels
// per millisecond (the ~0.17px/ms zoomies dash). That is inherently
// nondeterministic — frame pacing and timer coalescing vary per machine and run.
//
// The engine instead advances in fixed integer ticks at a constant rate. Sim
// state is a pure function of tick count; nothing in engine logic reads the
// wall clock. The *renderer* interpolates between the last two ticks for smooth
// motion, but that is a presentation concern and never feeds back into state.

// Simulation rate. 20 Hz matches the original 20 Hz collision-read cadence.
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ; // 50 ms per tick

// The hat panda's discrete action interface runs at 10 Hz (agreed in the spec):
// one decision every TICKS_PER_ACTION engine ticks. Between decisions the last
// action is held.
export const ACTION_HZ = 10;
export const TICKS_PER_ACTION = TICK_HZ / ACTION_HZ; // 2

// ---- unit conversions from the old ms/px-per-ms constants ----
// Feel drift is expected and is gated on Ameya's preview judgment plus the
// side-by-side trace comparison (see design/panda-policy-net.md, Phase A). These
// helpers give the mechanical first pass; individual durations get hand-tuned
// against the map's constant inventory afterwards.

// Milliseconds -> whole ticks, rounded to nearest, clamped to at least 1 so a
// positive duration never collapses to a zero-length (instantaneous) phase.
export const msToTicks = (ms) => Math.max(1, Math.round(ms / TICK_MS));

// Milliseconds -> ticks without the floor clamp, for durations where 0 is a
// legitimate value (e.g. an optional delay that may be disabled).
export const msToTicksRaw = (ms) => Math.round(ms / TICK_MS);

// Pixels-per-millisecond speed -> pixels advanced per tick.
export const pxPerMsToPerTick = (pxPerMs) => pxPerMs * TICK_MS;

// Ticks -> milliseconds, for reporting/plumbing back to human-readable values.
export const ticksToMs = (ticks) => ticks * TICK_MS;
