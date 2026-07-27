// The observation encoder — everything the policy is allowed to see, and nothing else.
//
// B2 of design/panda-policy-net.md. This is the sensor the learned line-walker
// looks through: one fixed-width Float32 frame per decision tick, built out of a
// heading-cone field of view over per-panda token slots with persistent identity.
//
// **Why it lives in the engine and not in trainer/.** The trainer records through
// it (a corpus is a recording of this sensor) and Phase D *ships* it — the
// in-browser policy has to encode its own observations, frame by frame, from the
// same state the renderer draws. One implementation, imported by both, exactly as
// the trainer imports the engine rather than vendoring it. It also means the
// determinism lint covers it, which matters: an encoder that rounds differently in
// Chrome than in Node would move actions in the browser that the trainer never saw.
//
// ## Three rules the design hangs on
//
// 1. **No privileged state, ever.** No anomaly kind, no FSM phase or timer, no
//    director/incident queue, no velocities, no `moveSpeed`, no `oblivious`, and
//    none of the rules watcher's brain (`subject`, `incSubject`, …) — that brain is
//    the thing the network replaces. The operational test is stricter and simpler:
//    *the encoder may read of another panda only what the renderer reads*, because
//    what the renderer reads is precisely what a bystander could see. `test/obs.test.js`
//    pins that with a read-tracking proxy, and pins the flagship consequence
//    directly: a sleeper and a freshly-knocked panda in the same fall cels encode
//    to identical bytes. Telling them apart is memory's job, not the sensor's.
// 2. **The encoder remembers identity and nothing else.** A slot stays bound to its
//    panda while it is out of view (`holdTicks`), so the network is not made to
//    solve identity binding before it can infer any FSM — a confound, not the study
//    (D1 note in the plan). But an unseen panda's token carries *no* stale
//    position, pose or facing: those fields go to zero and only `present` stays
//    lit. Where that panda went, and what it is probably doing now, is the world
//    model's job. Putting a decaying position estimate in here would be building
//    the belief we are trying to watch emerge.
// 3. **Frozen and bit-exact.** Every value lands in a `Float32Array`, whose store
//    is IEEE-754 round-to-nearest-even — the same rounding `Math.fround` performs,
//    mandated identically in every JS engine. The arithmetic upstream of it is
//    +,-,*,/ and `sqrt`, plus one `cos` at construction time through `mathx`. So
//    "Node, Chrome and a future Python trainer see the same numbers" is true by
//    construction; `tools/obs-fixture.js` makes it *checkable*, as a portable
//    (world, memory) -> floats fixture other languages can be held to.
//
// The layout is versioned (`OBS_VERSION`). Changing it invalidates a cut corpus,
// which is why it freezes with the roster at the exit of Phase B.

import { AX, AY, DIR_COUNT, wrapDir } from '../dirs.js';
import { PI, cos, sq, sqrt, clamp } from '../mathx.js';
import { crossesFence } from '../geometry.js';
import { MODE, ANIM_NAME } from '../state.js';
import { hiccupLift } from '../anomalies.js';

export const OBS_VERSION = 1;

const POSE_COUNT = ANIM_NAME.length; // 7 drawn animations — the cel cycles

// ---- the frame layout ----
//
// A frame is `1 + slots` tokens of `OBS_WIDTH` floats, row-major: token 0 is the
// hat panda himself, tokens 1..slots are the neighbour slots. One shared width for
// both kinds (a transformer embeds every token through the same matrix), so the
// self-only tail simply stays zero on a neighbour, and the neighbour block stays
// zero on the self token except for the pose/facing it shares.

const F = Object.freeze({
  SELF: 0, // 1 on the self token, 0 on a neighbour
  PRESENT: 1, // this slot is bound to a panda (seen recently, maybe not now)
  VISIBLE: 2, // …and it is in view *this* frame; when 0, every field below is 0
  REL_X: 3, // egocentric offset, normalised by sightRange (world axes, not rotated:
  REL_Y: 4, // the action space is 8 fixed world headings, so a body frame would only
  DIST: 5, // make the policy un-rotate before it could choose)
  LIFT: 6, // drawn height off the ground / hiccupRise — a hiccup pop is visible
  RIDING: 7, // seated on a tower (the seated art is unmistakable)
  FLYING: 8, // mid-hop onto a head
  CARRYING: 9, // a tower is standing on this panda
  LEVEL: 10, // which tier of the tower it is, halved into 0..1
  FACING: 11, // one-hot over the 8 drawn headings
  POSE: 19, // one-hot over the 7 drawn animations
  // ---- self only ----
  ROLL_CD: 26, // dive-roll cooldown remaining, 1 = just rolled, 0 = ready
  HAT_ON: 27, // wearing the hat (see the note on the field list below)
  EDGE: 28, // clearance to the four stage edges (left, right, up, down)
  FENCE: 32, // signed offsets to the hero card's four edges (l, r, t, b)
  FENCE_ON: 36, // …0 when the stage has no card, in which case FENCE is all zero
});

export const OBS_WIDTH = 37;

// The self-describing field table — this is what a corpus manifest records, and
// what a probe or a debug overlay indexes by name. Sizes tile [0, OBS_WIDTH).
export const OBS_FIELDS = Object.freeze([
  { name: 'self', at: F.SELF, size: 1 },
  { name: 'present', at: F.PRESENT, size: 1 },
  { name: 'visible', at: F.VISIBLE, size: 1 },
  { name: 'relX', at: F.REL_X, size: 1 },
  { name: 'relY', at: F.REL_Y, size: 1 },
  { name: 'dist', at: F.DIST, size: 1 },
  { name: 'lift', at: F.LIFT, size: 1 },
  { name: 'riding', at: F.RIDING, size: 1 },
  { name: 'flying', at: F.FLYING, size: 1 },
  { name: 'carrying', at: F.CARRYING, size: 1 },
  { name: 'level', at: F.LEVEL, size: 1 },
  { name: 'facing', at: F.FACING, size: DIR_COUNT },
  { name: 'pose', at: F.POSE, size: POSE_COUNT },
  { name: 'rollCooldown', at: F.ROLL_CD, size: 1 },
  { name: 'hatOn', at: F.HAT_ON, size: 1 },
  { name: 'edgeClear', at: F.EDGE, size: 4 },
  { name: 'fenceOffset', at: F.FENCE, size: 4 },
  { name: 'fencePresent', at: F.FENCE_ON, size: 1 },
]);

// ---- the sensor's own tunables ----
//
// These are Phase-C knobs, not cosmetics: the cone angle and the peripheral radius
// move the memory gap directly (a wider cone means less to remember), and the hold
// window sets how long identity survives an occlusion. Defaults are a starting
// point chosen against the watcher's own working distances — `hatDangerR` 130,
// `ambientStandoff` 280, `chainRange` 350 — so the useful field is inside sight
// and the far side of a 2560px monitor is not.
export const DEFAULT_OBS = Object.freeze({
  slots: 8, // per-panda tokens. 9 tokens/frame => a 16-frame window is 144 tokens,
  // inside the plan's 100-200 context budget.
  sightRange: 520, // px — nothing registers past this, cone or not
  peripheralR: 130, // px — the omnidirectional stub: he notices what is on top of him
  coneDeg: 120, // full cone width about his heading (so +-60 degrees)
  occludeFence: true, // the hero card is opaque: no seeing a panda through it
  holdTicks: 40, // 2 s — how long a slot keeps its panda after losing sight of it
  hysteresisPx: 40, // a nearer stranger must beat the slot it evicts by this much
});

// The frame shape for a given slot count — what B4 writes into a corpus manifest.
export function obsLayout(slots = DEFAULT_OBS.slots) {
  const tokens = 1 + slots;
  return {
    version: OBS_VERSION,
    slots,
    tokens,
    width: OBS_WIDTH,
    length: tokens * OBS_WIDTH,
    fields: OBS_FIELDS.map((f) => ({ ...f })),
  };
}

// The hat panda — the one entity a policy drives, and the eye everything here is
// measured from. Found by `hasHat` rather than by index, because the entrance
// shuffles spawn order.
export function observerOf(state) {
  return state.entities.find((e) => e.hasHat);
}

// ---- the encoder ----

// Build an observer. Returns `{ params, layout, init, observe, describe }`, in the
// same shape as `makeEngine`: `init()` mints the slot memory, `observe(state, mem)`
// advances it and fills a frame.
//
// One observer owns one scratch/output buffer and is therefore single-threaded by
// construction: `observe` returns a view that the *next* call overwrites. Copy it
// (`frame.slice()`) if you are keeping it. A worker pool gives each worker its own.
export function makeObserver(overrides = {}) {
  const params = Object.freeze({ ...DEFAULT_OBS, ...overrides });
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_OBS)) throw new Error(`unknown observation parameter "${key}"`);
  }
  const K = params.slots;
  const layout = obsLayout(K);

  // Derived once, in doubles, so the hot path is comparisons only. `cos` is
  // mathx's pinned series, not Math's — see the module header.
  const coneCos = cos((params.coneDeg / 2) * (PI / 180));
  const sightR2 = sq(params.sightRange);
  const periphR2 = sq(params.peripheralR);
  const invRange = 1 / params.sightRange;

  const frame = new Float32Array(layout.length);

  // Scratch for the visibility pass, reused across calls (the RL loop runs this
  // millions of times). Grown on demand; never shrunk.
  let visEnt = [];
  let visD = [];
  let visTaken = [];

  const init = () => ({
    // Slot memory: which panda each slot holds, when it was last actually seen,
    // and how far away it was then. That last number is only ever used to rank
    // eviction candidates — it never reaches the frame.
    id: new Array(K).fill(-1),
    seen: new Array(K).fill(-1),
    dist: new Array(K).fill(0),
  });

  // Which visible index holds panda `id`, or -1. The scan is over what is in view
  // (a handful of bodies), so a linear walk beats a map.
  function visIndexOf(id, n) {
    for (let i = 0; i < n; i++) if (visEnt[i].id === id) return i;
    return -1;
  }

  function observe(state, mem, out = frame) {
    const cfg = state.cfg;
    const self = observerOf(state);
    if (!self) throw new Error('observe: no hat panda in this state');
    if (!mem || mem.id.length !== K) throw new Error(`observe: slot memory must have ${K} slots`);
    out.fill(0);

    const n = scanVisible(state, cfg, self);
    updateSlots(state, mem, n);
    writeSelf(out, state, cfg, self);
    writeSlots(out, state, cfg, self, mem, n);
    return out;
  }

  // ---- what is in view this frame ----
  //
  // Visible = inside `sightRange`, and either inside the peripheral stub or within
  // the heading cone, and not behind the hero card. Everything is measured off the
  // VISUAL position (`x`, `y`) — the drawn body, which is also the one that
  // collides. The rules expert reasons on the logical stride grid instead and so
  // sees a step into the future; the policy does not get that, deliberately. It
  // sees the picture.
  function scanVisible(state, cfg, self) {
    const ents = state.entities;
    const ux = AX[wrapDir(self.dir)];
    const uy = AY[wrapDir(self.dir)];
    let n = 0;
    for (let i = 0; i < ents.length; i++) {
      const q = ents[i];
      if (q.hasHat) continue; // himself
      const dx = q.x - self.x;
      const dy = q.y - self.y;
      const d2 = sq(dx) + sq(dy);
      if (d2 > sightR2) continue;
      const d = sqrt(d2);
      if (d2 > periphR2 && (dx * ux + dy * uy) / d < coneCos) continue;
      if (params.occludeFence && crossesFence(cfg, self.x, self.y, q.x, q.y)) continue;
      visEnt[n] = q;
      visD[n] = d;
      visTaken[n] = false;
      n += 1;
    }
    return n;
  }

  // ---- slot assignment: sticky k-nearest with hysteresis ----
  //
  // Sticky, because a slot that reshuffles every frame teaches the network that
  // token 3 means nothing in particular. Hysteresis, because without it two pandas
  // at nearly equal range trade places every few frames and do the same damage. The
  // ranking only ever consults *visible* distances (or the last visible distance of
  // a held slot) — inferring an unseen panda's range would be exactly the privileged
  // read this file exists to refuse.
  function updateSlots(state, mem, n) {
    // 1. Refresh what is still in view; expire what has been gone too long.
    for (let s = 0; s < K; s++) {
      if (mem.id[s] < 0) continue;
      const i = visIndexOf(mem.id[s], n);
      if (i >= 0) {
        mem.seen[s] = state.tick;
        mem.dist[s] = visD[i];
        visTaken[i] = true;
      } else if (state.tick - mem.seen[s] > params.holdTicks) {
        mem.id[s] = -1;
        mem.seen[s] = -1;
        mem.dist[s] = 0;
      }
    }

    // 2. Place the unbound, nearest first (ties by id, so the order is total and
    //    reproducible). Selection rather than a sort: the candidate list is a
    //    handful of bodies and this allocates nothing.
    for (;;) {
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (visTaken[i]) continue;
        if (best < 0 || visD[i] < visD[best] ||
          (visD[i] === visD[best] && visEnt[i].id < visEnt[best].id)) best = i;
      }
      if (best < 0) return;
      visTaken[best] = true;

      let free = -1;
      for (let s = 0; s < K; s++) {
        if (mem.id[s] < 0) { free = s; break; }
      }
      if (free < 0) {
        // Full: evict the farthest incumbent, but only for a clearly nearer
        // stranger. A slot holding an out-of-view panda keeps its last known
        // distance, so it is evictable on that stale number — and if it is not,
        // `holdTicks` frees it soon enough anyway.
        let worst = 0;
        for (let s = 1; s < K; s++) if (mem.dist[s] > mem.dist[worst]) worst = s;
        // Candidates arrive in ascending distance, so if this one cannot beat the
        // incumbent, none of the rest can either.
        if (visD[best] + params.hysteresisPx >= mem.dist[worst]) return;
        free = worst;
      }
      mem.id[free] = visEnt[best].id;
      mem.seen[free] = state.tick;
      mem.dist[free] = visD[best];
    }
  }

  // ---- writing the frame ----

  // Token 0: proprioception. What he knows about his own body without looking at
  // anyone — where the walls and the card are relative to him, which way he faces,
  // what he is doing, and whether the dive-roll has recharged.
  function writeSelf(out, state, cfg, self) {
    out[F.SELF] = 1;
    out[F.PRESENT] = 1;
    out[F.VISIBLE] = 1;
    out[F.FACING + wrapDir(self.dir)] = 1;
    out[F.POSE + self.anim] = 1;
    out[F.HAT_ON] = self.hasHat ? 1 : 0;
    // Ticks left on the roll cooldown, as a fraction of its full length. The one
    // piece of the watcher's brain block that is honest proprioception: his legs
    // know whether they can go again.
    out[F.ROLL_CD] = clamp((self.rollReadyAt - state.tick) / cfg.rollCooldownTicks, 0, 1);

    const cx = self.x + cfg.cell / 2;
    const cy = self.y + cfg.cell / 2;
    out[F.EDGE + 0] = clamp(cx * invRange, 0, 1);
    out[F.EDGE + 1] = clamp((cfg.width - cx) * invRange, 0, 1);
    out[F.EDGE + 2] = clamp(cy * invRange, 0, 1);
    out[F.EDGE + 3] = clamp((cfg.height - cy) * invRange, 0, 1);

    const f = cfg.forbid;
    if (!f) return; // no card on this stage: FENCE stays zero and FENCE_ON reads 0
    out[F.FENCE_ON] = 1;
    out[F.FENCE + 0] = clamp((f.l - cx) * invRange, -1, 1);
    out[F.FENCE + 1] = clamp((f.r - cx) * invRange, -1, 1);
    out[F.FENCE + 2] = clamp((f.t - cy) * invRange, -1, 1);
    out[F.FENCE + 3] = clamp((f.b - cy) * invRange, -1, 1);
  }

  // Tokens 1..K: one per slot. A bound-but-unseen slot writes `present` and stops
  // there — see rule 2 in the header.
  function writeSlots(out, state, cfg, self, mem, n) {
    for (let s = 0; s < K; s++) {
      if (mem.id[s] < 0) continue;
      const base = (1 + s) * OBS_WIDTH;
      out[base + F.PRESENT] = 1;
      const i = visIndexOf(mem.id[s], n);
      if (i < 0) continue;
      writeNeighbour(out, base, visEnt[i], visD[i], state, cfg, self);
    }
  }

  // Everything here is a fact about the drawn panda: where it is, which way it is
  // facing, which cel cycle it is playing, whether it is off the ground, and where
  // it sits in a tower. Nothing about *why*.
  function writeNeighbour(out, base, q, d, state, cfg, self) {
    out[base + F.VISIBLE] = 1;
    out[base + F.REL_X] = clamp((q.x - self.x) * invRange, -1, 1);
    out[base + F.REL_Y] = clamp((q.y - self.y) * invRange, -1, 1);
    out[base + F.DIST] = clamp(d * invRange, 0, 1);
    out[base + F.LIFT] = cfg.hiccupRise > 0 ? hiccupLift(q, cfg) / cfg.hiccupRise : 0;
    out[base + F.RIDING] = q.mode === MODE.RIDING ? 1 : 0;
    out[base + F.FLYING] = q.flying ? 1 : 0;
    out[base + F.CARRYING] = state.stack.baseId === q.id ? 1 : 0;
    out[base + F.LEVEL] = q.stackLevel / 2;
    out[base + F.FACING + wrapDir(q.dir)] = 1;
    out[base + F.POSE + q.anim] = 1;
  }

  // The manifest entry: parameters + layout, JSON-ready. A corpus that records this
  // can be re-encoded, checked, or read by another language without guesswork.
  const describe = () => ({ params: { ...params }, layout: obsLayout(K) });

  return { params, layout, init, observe, describe };
}
