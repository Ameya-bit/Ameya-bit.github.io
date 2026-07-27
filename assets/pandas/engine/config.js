// Simulation config — every tunable in one place, defaults = today's live values.
//
// Change #4 of the Phase-A plan: anomaly distributions, kind mix, counts, and
// spawn placement become config so training corpora can randomise them while the
// live site keeps the shipped defaults. Timing values are in TICKS (converted
// from the original ms constants via tick.js); distances stay in pixels.
//
// `makeConfig(overrides)` deep-ish merges a partial override onto the defaults so
// callers can tweak one field without restating the rest.

import { msToTicks, pxPerMsToPerTick } from './tick.js';
import { cos, cssEase, PI } from './mathx.js';

export const DEFAULT_CONFIG = Object.freeze({
  // Stage — the host passes real pixel dimensions; these are headless/preview
  // defaults roughly matching the hero region.
  width: 1200,
  height: 520,

  // The hero-card fence: pandas route around this rectangle (stage-local px).
  // null = no fence (headless tests). The host recomputes it from layout.
  forbid: null,

  // Reduced-motion mode builds the static tableau instead of the live sim, with
  // nothing closer than `tableauGap` — the whole point of a composed still is that
  // nothing lands on anything else (render/tableau.js).
  reduced: false,
  tableauGap: 118,

  // Headcount. The live site picks 10 (wide) / 7 (mid) by viewport; the engine
  // takes it as config.
  pandaCount: 10,

  // Body + collision geometry (px). The hit box is the sprite's real bounds,
  // centered in the 100px cell; TOL is the original 20px proximity buffer.
  cell: 100,
  bodyW: 44,
  bodyH: 54,
  collideTol: 20,
  // A `.stop` panda's box is shorter from the top: the original's
  // `.panda_wrapper.stop .hit_area { margin-top: 8px; height: 46px }` inside a
  // flex-centered wrapper, so the 8px margin and the 46px box centre as one 54px
  // margin box — same bottom edge, top edge 8px lower. Since contacts compare corner
  // top-lefts, that costs 8px of reach upward and gains 4px downward (collision.js).
  // Anything grounded or driven tick-by-tick wears it (the entity's `stopped` flag)
  // — the one behaviour-dependent hit box in the sim.
  stopBodyH: 46,
  stopBodyMargin: 8,

  // Movement.
  step: 50, // one wander stride (px)
  foot: 24, // body inset from the 100px wrapper, for the fence test
  boundLower: -40, // stage edge clamp (matches applyPos)
  boundUpper: 60,

  // Roamer stride cadences (ticks) — the original MOVE_SPEEDS [850..1100] ms.
  moveSpeeds: [17, 18, 19, 20, 22],
  hatMove: msToTicks(540), // 11 — the watcher's calm stride

  // Turn-delta pool for each wander stride (mostly ±1, sometimes straight).
  turnOptions: [1, 1, -1, -1, 0],

  // ---- the entrance ----
  // The troupe walks on from off-stage rather than appearing: the hat panda alone
  // first (his solo beat), then the rest a couple at a time. Config-gated because
  // training corpora want both — most episodes opening mid-scene, some on the
  // walk-in, so the policy has seen the filling field it meets on a page load.
  entrance: true,
  entranceOff: 100, // start one wrapper-width off-stage, fully clipped
  entranceTargetIn: 110, // …and settle this far in before wandering
  entranceLead: msToTicks(1800), // 36 — the hat panda's head start
  entranceWaveGap: msToTicks(1050), // 21 — then a wave every so often
  entranceWaveSize: 2, // "a couple at a time"
  entranceTries: 40, // attempts to find an entry lane clear of the hero card

  // The glide. The original moved logically in 50px hops but rendered them through
  // `transition: transform 2s`, and — critically — collision read that lagging
  // *visual* position, which softens contacts (bodies glide past instead of
  // snapping into each other). Collision and rendering use the visual position;
  // wander/fence use the logical one.
  //
  // The engine owns the transition now, and owns it *literally*: the original set
  // the transform only when the logical position changed (`applyTransform` is
  // called from `applyPos`), so each stride RESTARTS the curve from wherever the
  // body had glided to. That restart is the whole feel of the walk — a stride
  // surges then settles, and a turn commits immediately instead of drifting on.
  // An exponential chase reproduces the average lag but none of that shape.
  glideTicks: msToTicks(2000), // 40 — the CSS transition's duration


  // The oblivious one — keeps to a patch, idles often.
  obliviousRadius: 110,
  obliviousIdleP: 0.45,
  obliviousIdleMin: msToTicks(2200), // 44
  obliviousIdleMax: msToTicks(5200), // 104

  // Knock / recovery (ticks + px).
  impact: 80, // knockback slide distance
  fallTicks: msToTicks(140 * 6), // 17 — fall plays through
  standTicks: msToTicks(140 * 6), // 17 — stand-up plays through
  // Lie time is 1000*(rand(4)+1) ms = one of {2000,3000,4000,5000} → ticks.
  lieTimesTicks: [40, 60, 80, 100],

  // ---- the director (tier-1 anomaly scheduler) ----
  anomKick: msToTicks(9000), // 180 — delay before the first anomaly
  anomGapMin: msToTicks(6000), // 120 — window between anomalies
  anomGapMax: msToTicks(11000), // 220
  aftermathLinger: msToTicks(2600), // 52 — incident TTL tail past behaviour end

  // ---- tier-1 anomaly parameters (ticks unless noted px) ----
  // sleeper — lies down deliberately for a nap.
  sleepMin: msToTicks(8000), // 160
  sleepMax: msToTicks(20000), // 400
  // tumbler — trips: a few facing-flip skids, then down.
  tripSkids: 4,
  tripEvery: msToTicks(60), // 1
  tripSlide: 46, // px total skid distance
  tripDownTicks: msToTicks(900), // 18
  // spinner — spins in place, then staggers a couple of steps.
  spinFlips: 22, // max(8, round(1200/55))
  spinEvery: msToTicks(55), // 1 — one facing-flip per tick
  staggerMin: 2,
  staggerMax: 3,
  staggerEvery: msToTicks(190), // 4
  // loop — retraces a closed octagon a few times.
  loopLapsMin: 2,
  loopLapsMax: 4,
  loopEvery: msToTicks(420), // 8
  // starer — faces the nearest edge and holds.
  stareMin: msToTicks(6000), // 120
  stareMax: msToTicks(12000), // 240
  // zoomies — bolts straight at ~3x until a wall (crash) or fuse.
  zoomEvery: msToTicks(60), // 1
  zoomIncr: 10, // px per dash tick (along a normalised axis)
  zoomFuseTicks: msToTicks(8000), // 160 — never found a wall, just stop
  zoomTumbleTicks: msToTicks(700), // 14 — crash-and-recover ground time
  // moonwalk — travels one heading while facing the opposite.
  moonStepsMin: 8,
  moonStepsMax: 16,
  moonEvery: msToTicks(460), // 9
  // hiccup — every two strides, a small pop straight up.
  hiccupMin: 4,
  hiccupMax: 7,
  hiccupStrideEvery: msToTicks(420), // 8
  hiccupHopTicks: msToTicks(300), // 6
  hiccupRise: 18, // px pop height (presentation)
  hiccupWanderP: 0.35, // chance of a re-facing between pops

  // ---- tier 2: the stack (M4) ----
  // A tower parading as one entity. The base is the only real actor (an unstoppable
  // `solid`); the riders are pinned ghosts above it, swaying harder the longer it
  // parades, until it topples into an ordinary three-way knock.
  stackKick: msToTicks(35000), // 700 — the first tower, once the field has settled
  stackGapMin: msToTicks(60000), // 1200 — one forms this often: a set piece, not a habit
  stackGapMax: msToTicks(120000), // 2400
  stackRiders2P: 0.45, // chance of a 3-high tower (2 riders); else 2-high
  mountWalkEvery: msToTicks(300), // 6 — the walk-up stride, brisk and purposeful
  mountMaxSteps: 24, // …or it just hops anyway; never stall the assembly
  mountNear: 68, // a mounter hops once this close to the base
  mountHopTicks: msToTicks(440), // 9 — the hop onto a head
  mountArcPeakMax: 150, // hop-arc height cap (px)
  mountArcPeakBase: 45, // …and its floor, before the distance term
  mountArcPeakPerPx: 0.3,
  stackIncidentTtl: msToTicks(60000), // 1200 — tier-2 attention: assembly + the whole parade
  paradeMin: msToTicks(18000), // 360 — how long it parades before the wobble maxes
  paradeMax: msToTicks(34000), // 680
  baseStep: 3, // the base's parade gait: small crisp steps (no glide) so riders track it
  baseTurnP: 0.06, // chance per tick the base drifts its heading
  toppleHitR: 76, // a zoomies within this of the base brings the tower down early
  // The seat rise: one body height (the art occupies rows 19-81 of the 100px cell),
  // so a rider's feet land on the head below. The presentation layer may refine this
  // per facing from the seated cels; the engine needs one number for the geometry.
  riderRise: 62,
  sitWobbleTicks: msToTicks(1600), // 32 — one full teeter; sway = sin(tick * 2pi/this)
  sitTravel: 6, // px of head-shift per rider at the teeter peak — accumulates up the tower
  // Presentation-only: the rider's tilt at that peak. The engine computes the sway
  // (it moves the seats, which IS state); only the visible rotation lives here, so the
  // renderer scales `riderSway()` by this rather than inventing its own wobble.
  sitTiltDeg: 6,

  // ---- tier 3: the cascade (M4) ----
  // The chain-reaction knockout. The director ARMS on a long jittered clock — that
  // clock is the whole of the cascade's rarity — and the next natural collision (or
  // a stack topple) IGNITES a greedy nearest-neighbour domino sweep.
  cascadeKick: msToTicks(40000), // 800 — the first arming
  cascadeArmMin: msToTicks(120000), // 2400 — re-arm every 2-5 min
  cascadeArmMax: msToTicks(300000), // 6000
  cascadeArmTimeout: msToTicks(40000), // 800 — armed this long with no collision → manufacture one
  chainRange: 350, // a front only reaches a neighbour within this; wider gaps end it
  cascadeHopMin: msToTicks(150), // 3 — stagger between a faller and the one it fells
  cascadeHopMax: msToTicks(230), // 5
  cascadeCoverMin: 0.7, // fraction of the field the steering fells — never all of it
  cascadeCoverMax: 0.9,
  cascadeDuration: msToTicks(14000), // 280 — machinery idles after this; re-ignition blocked
  cascadeIncidentTtl: msToTicks(9000), // 180 — the tier-3 pull to the origin of the carnage
  cascadeStageSlack: 1.6, // hold the arm if a seed is within inspectNear * this of the watcher

  // ---- the hat panda: the watcher (M3) ----
  // Cadence. The calm stride is `hatMove` (11); alert is quicker so the weave
  // keeps up with a threat (never zoomies-fast). Decisions run at 10 Hz (every
  // TICKS_PER_ACTION engine ticks); these are the interval between actual strides.
  hatAlert: msToTicks(380), // 8 — full-alert stride when danger is near

  // Attention / vantage.
  inspectNear: 140, // standoff while studying one subject up close
  ambientStandoff: 280, // relaxed distance kept when nothing is wrong
  standoffSlack: 1.7, // only relocate once the subject drifts past td * this
  dwellMin: msToTicks(8000), // 160 — hold one ambient subject this long
  dwellMax: msToTicks(18000), // 360
  stickyTicks: msToTicks(2500), // 50 — hold an incident before a same/lower one can steal focus
  // Re-align once the bearing drifts off a sprite axis: tight (22.5deg, the half-
  // angle between the 8 axes) up close, loose (40deg) when merely relaxing — the
  // relaxed tolerance kills the back-and-forth jitter at the far standoff.
  axisCos: cos((22.5 * PI) / 180),
  ambientAxisCos: cos((40 * PI) / 180),

  // Navigation among the troupe (the weave).
  avoidR: 85, // personal-space radius: pandas within this crowd a cell/vantage
  weaveCrowdW: 0.7, // crowd vs. progress trade-off while weaving toward a vantage
  weaveHoldBias: 0.12, // a forward step must beat standing still by this, else hold
  weaveStuck: 5, // boxed-in strides with no headway before re-vantage, then abandon
  axisCrowdW: 24000, // px^2 per unit of crowd when scoring vantage points
  crowdBump: 1.2, // if the troupe crowds our planted vantage past this, relocate

  // The reflex + the dive-roll (his one fast escape).
  hatDangerR: 130, // a closing panda within this puts him on alert
  hatRollR: 74, // two closing pandas within this trigger the roll
  hatPanicR: 50, // one closing panda this near is too close to step aside — roll
  hatSidestepR: 108, // a single slow drifter within this → calm sidestep, not a roll
  hatFastSpeed: pxPerMsToPerTick(0.12), // 6 px/tick — above this a threat is "fast" (zoomies/skid) → roll
  hatClosingMin: 0.15, // a panda counts as bearing down only past this heading-toward-him dot
  hatThreatLookahead: 60, // project a threat this far along its heading when scoring escapes
  hatStepCrowdW: 40, // px of clearance traded per unit of crowd when choosing a sidestep cell
  // The roll: 5 cels (fall tumble without settling), each one tick, ~92px of travel.
  rollCels: 5,
  rollFrameTicks: msToTicks(58), // 1 — per roll cel
  rollDist: 92, // total roll travel (~1.8 strides)
  rollCooldownTicks: msToTicks(2600), // 52 — the honest limiter between rolls
});

// Shallow merge is enough — config is a flat object of scalars/arrays.
export function makeConfig(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  // The glide curve, sampled once per config rather than per entity per tick: a
  // transition only ever advances in whole ticks, so `cssEase` has exactly
  // `glideTicks + 1` possible arguments. Same arithmetic, same values, no Newton
  // in the hot path — which matters at the trainer's tens of thousands of ticks
  // per second, where this runs for every panda on every tick.
  cfg.glideCurve = Array.from(
    { length: cfg.glideTicks + 1 },
    (_, i) => cssEase(i / cfg.glideTicks),
  );
  return cfg;
}
