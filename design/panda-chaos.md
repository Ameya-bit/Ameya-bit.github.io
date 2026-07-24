# Panda hero chaos — the overwhelmed interpreter

*Started 2026-07-23. This spec **supersedes [panda-choreography.md](panda-choreography.md)** (the activation-patching troupe). That system shipped all five phases and was then retired by design review: the conga lines turned characters into notation — coordination read as uniform and janky, line membership suppressed the collisions that are the scene's actual charm, and the patch fired too rarely/late for anyone to see. Base engine, palette, hat pipeline, and fencing rules still live in [whimsy.md](whimsy.md), [direction.md](direction.md), and [[panda-hat-pipeline]]; this doc specifies what the troupe does **now**. Status: **Phases 0–1 shipped 2026-07-23; Phase 2 next.** Both await Ameya's review on the live preview.*

---

## The thesis (revised)

The hero is a **self-portrait, not a demonstration**. A field of small agents doing inscrutable things, and one figure — the hat panda, Ameya's self-insert — moving among them, trying to understand. That *is* mechanistic interpretability, rendered as disposition instead of diagram. The audience for the interp meaning is **Ameya alone** (decided 2026-07-23): visitors see charming panda slapstick; the private layer needs no caption and no legibility bar. The old acceptance test ("reads without a caption") is retired. The new one: **does the scene feel alive without feeling noisy — and does the watcher's scrambling make you smile?**

### Principles (locked)

1. **Characters, not notation.** Every chaos behaviour is an *individual* malfunctioning. No formations, no coordinated walks, no diagram vocabulary. (The lesson of the conga lines.)
2. **Variety over frequency — raise the ceiling, not the floor.** The baseline texture stays calm (at a glance: wandering pandas, maybe one odd thing). Chaos comes from many *kinds* of rare events, not a higher event rate. The union keeps the hat panda busy; the scene stays ambient.
3. **The hat panda misses more than it catches — emergently.** Never script lateness. Anomalies have different lifespans (a nap lasts 20s, a crash is over in 1s); with independent clocks and one attention slot, early/on-time/too-late arrivals fall out on their own, each a different little phenomenon.
4. **The hat panda is always outside the chaos.** It never joins, causes, or suffers any of it (collision ghost, as today). It watches, scrambles between incidents, and takes relaxing beats *amidst* the chaos — planted and content while the field churns. It is never "caught up"; there is always more. (Hat panda getting swept up in the chaos: parked as a possible later addition, explicitly not now.)
5. **No new baked art.** Everything below composes existing cels + the three shipped primitives (`throwArc` parabola, `spin3d` facing-cycle, asymmetric knock). The one candidate exception — a hand-drawn rider cel for the stack — goes through the body editor in the workshop ([[panda-hat-pipeline]]), never AI generation ([[no-ai-generated-art]]).

### The private key (for Ameya; never rendered)

| On screen | In the head |
|---|---|
| The wandering troupe | the model — small units doing inscrutable things |
| The hat panda scrambling incident to incident | me; post-hoc analysis of behaviours that already happened |
| Sleeper (flops down, naps) | a dead / ablated unit |
| Loop (stuck retracing a circle) | repetition — the canonical LLM failure |
| Zoomies (3× sprint into a wall/panda) | a runaway activation |
| Tumbler (trips on nothing) | noise, clumsiness of the substrate |
| The stack (tower parading as one) | stacked layers pretending to be one coherent entity — until it falls apart |
| The cascade (one bump fells the herd) | a perturbation propagating through the network (the old patch metaphor, reborn as slapstick) |
| The oblivious one (never participates) | the unit no probe ever explains |

---

## The chaos economy — three tiers

One **director** (see below) owns all rates. Indicative constants are starting points; every one is tuned on the live Quarto preview ([[verify-animations-static-only]]).

### Tier 1 — individual weirdness (frequent, small, cheap)

One roamer at a time goes strange, then recovers. Roster, each with duration class (long ones are "catchable" by the hat panda; instant ones are always post-hoc):

- **Sleeper** — stops mid-walk, plays fall→fallen deliberately (no slide, no impact), lies 8–20s, stands, resumes. *Long.*
- **Loop** — walks a small closed octagon (turnIndex +1 every stride) 2–4 times before snapping out. Organic-looking, mechanically trivial. *Medium.*
- **Starer** — stops, faces the nearest edge, holds the settled idle 6–12s, moves on. Nothing happens. *Medium.*
- **Spinner** — `spin3d` in place ~1.2s, then 2–3 quick stagger-steps in random directions, resumes. *Short.*
- **Zoomies** — locks a straight heading at ~3× speed until it hits a wall (tumbles) or a panda (ordinary knock — feeds the collision economy). *Short, kinetic.*
- **Tumbler** — trips on nothing: facing-cycle tumble over a short slide, ends splayed in the fall frames, gets up. *Instant.*

Cadence: one tier-1 anomaly begins every ~`ANOM_GAP` 7–14s (jittered), never two of the same kind back-to-back, never targeting the hat panda, the oblivious one, an entering panda, or a current stack member.

### Tier 2 — the stack (occasional, medium spectacle)

- **Mount:** a roamer walks up behind another, hops onto its head — a small `throwArc` (~400ms, ~55px rise). A third may join the same way. Cap **3 high** (the reference image; the hero band is short).
- **Parade:** the bottom panda is the only real actor — it walks (ordinary wander), collides as the **unstoppable force** (the conga asymmetry code, retargeted: knocks roamers aside, never knocked). Riders are ghosts pinned at vertical offsets, holding a still pose with a CSS sway, z-ordered above.
- **Wobble accumulator:** sway amplitude grows the longer it parades — collapse is visibly foreshadowed. A wobbling stack should be irresistible to the hat panda.
- **Topple** (wobble maxes out, or something kinetic hits the stack — a zoomies panda into the tower is a gift): riders `throwArc` off in different directions, all land in fall frames, ordinary recovery. A tossed rider landing on a bystander = one collateral knock. A topple is a **self-contained payoff** — it is *not* a cascade (see the coupling rule below).
- Frequency: a stack forms every ~`STACK_GAP` 60–120s; at most one stack alive; no stack during a cascade.

**⚠ Rider pose — workshop before building (the one open art question).** These pandas are upright bipeds, so stacking = standing on heads, which the WBB reference (quadrupeds) sidesteps. Options, in build order:
1. **Standing on the head, as-is (zero art).** Circus-acrobat read; precariousness is the point, and the standing pose already exists in all 8 facings — full parade freedom for free. *Prototype this first.*
2. **Hand-drawn sitting cel** (legs crossed → reads as sitting on the head — Ameya's suggestion). Cheapest honest version: riders always face **down** (toward the viewer) regardless of travel direction, so exactly **one** cel is needed, drawn by trace-and-nudge in the body editor and baked like the hat. Per-facing sitting cels (5 rows) only if the always-face-down cheat looks wrong.
3. Decide on the live preview, like every motion call before.

### Tier 3 — the cascade (rare, the jackpot)

The chain-reaction knockout. **Directed, not hoped for — cartoon physics: outcome-authored, physics-flavoured.** Pure chance can't chain at our density (~200px mean neighbour spacing vs an 80px slide), so:

- **Arming:** the director arms tier 3 on a long jittered timer (`CASCADE_ARM` 2–5min). While unarmed, all collisions are ordinary.
- **Ignition:** once armed, the **next natural collision escalates** (or a stack topple, if one happens first — see coupling). Both parties take a hard slide aimed **at their nearest standing neighbour** (slide vector continuous, fall facing snapped to the 8), magnitude = the actual gap, so they land overlapping.
- **Propagation:** each felled panda, on landing, fells its own nearest standing neighbour within `CHAIN_RANGE` (~350px) the same way — a greedy nearest-neighbour BFS with **two fronts**, animated. A front with no neighbour in range dies out naturally.
- **Coverage: 70–90%, never 100%.** A full clear reads scripted. A couple of inexplicably untouched survivors are part of the joke, and the **oblivious one is structurally guaranteed to survive** (steering never targets it).
- **Recovery:** ordinary knock recovery, naturally staggered by fall order. **No freeze, no spotlight** — the world never pauses; chaos continuing around the watcher is the point now.
- **Staging:** the director prefers to ignite while the hat panda is **mid-inspection elsewhere** — it looks up from a sleeping panda to find the field going down behind it, then stands amid the bodies, gaze darting, not knowing where to start. (Decided 2026-07-23.)
- **Coupling rule (rarity lives in the director, not the trigger):** a stack topple is always just a topple — *unless* the director happens to be armed, in which case the topple serves as the ignition. Cascade frequency stays pinned to the arming clock no matter how many ignition sources exist; topple-into-cascade is the rarest, best co-occurrence the site can produce.

### The standing anchor — the oblivious one

One roamer, chosen at spawn (never the hat panda): it is never selected for anomalies, never mounts or is mounted, never targeted by cascade steering. It wanders a small patch, idles often, and sits placid through everything. Chance collisions may still knock it (keeps it honest). Every big event gets a comic foil; the hat panda may occasionally plant and watch *it*, puzzled — the panda that does nothing is the biggest mystery of all.

---

## The hat panda — attention, scramble, inspect, relax

The Phase-3 observer machinery survives nearly whole, **retargeted from lines to incidents**:

- **Incidents:** every anomaly/stack/cascade emits `{panda(s), position, tier, expiresAt}`. The hat panda holds **one** incident at a time.
- **Priority:** tier 3 > tier 2 > tier 1; within a tier, newer preempts older only after a stickiness window (~2.5s) so it doesn't thrash between simultaneous events.
- **Scramble:** `stepWeaving` unchanged — it threads through the troupe to the incident, routing round the hero card (`crossesFence`/`detourCorner`).
- **Inspect:** plant at a closer standoff than the old line-watch (`INSPECT_NEAR` ~140px feels right for a single subject — tune live), face the subject dead-on via the axis logic, run the gaze scan (`pickGaze` retargeted: the subject, the point of impact, a nearby witness, a brief look-around). Hold until the incident expires or is preempted, then a beat, then back to ambient.
- **Ambient / relax:** no live incident nearby → plant somewhere clear (`bestAxis` crowd penalty, unchanged) and watch the field, gaze drifting between whatever's mildly notable. This is the "relax amidst the chaos" beat — it emerges from empty queue + planted idle; do not script it.
- **Arrival phenomenology (free, do not engineer):** long anomalies → it arrives in time, gets the long look. Instant ones → it inspects aftermath. Mid ones → coin flip. The mix of durations *is* the timing design.
- Speed stays `HAT_MOVE_MS` 540 with the calm 2s glide (the darty pass stays reverted).

---

## Demolition & salvage (Phase 0 scope)

**Delete** (from `pandas.js` + `styles.scss`): `class Line`, `manageLines`, `joinLine`, snake stepping, `LINE_*`/`JOIN_*`/`MANAGE_*`/`POST_PATCH_*`/`DISSOLVE_*` constants, `runPatch`, `managePatch`, all `PATCH_*` constants, the freeze system (`frozen`, `freezeFrame` call-sites guarding it), spotlight CSS (`.intervening`, `.spot`), `makeLine`, `pushAside`, `angleBetween`.

**Keep as-is:** entrance (Phase 1), ma5a collision + knock/fall/get-up, tap-to-knock, hat drop/retrieve skit, the hero-card fence, hat pipeline.

**Salvage (retargeted):** `throwArc` (mount hop, topple tosses), `spin3d` (spinner), asymmetric unstoppable-force collision (stack bottom), the whole observer suite (`observe` loop skeleton, `stepWeaving`, `bestAxis`, `crowdAt`, `pickGaze`, `AXES`, watch/relocate hysteresis).

**Engine debts folded into Phase 0** (binding — they predate this spec and were never done):
1. **Transform glide.** Motion moves off `margin-left/top` onto `transform: translate` (z-index still from y). Kills the layout-invalidation churn; also makes the 20Hz `getBoundingClientRect` collision reads cheap (layout stays clean under transform-only animation). Optionally switch collision to logical `x/y` later — note the caveat that logical leads rendered by up to a stride.
2. **Off-screen / hidden-tab pause.** IntersectionObserver on the stage + `visibilitychange`: all loops (animate, wander, director, incidents) pause when the hero is off-screen or the tab hidden. The old spec called this binding; it was never implemented.
3. **Mobile: no pandas.** Below the mid breakpoint (~800px) the stage doesn't populate at all (decided 2026-07-23: the hero content owns that space). `PANDA_COUNT` 20 wide / 12 mid stands.
4. **Reduced motion = a composed tableau**, not random scatter: troupe scattered, one 3-stack mid-parade, one fallen panda with the hat panda planted facing it. The frozen story, per the original locked decision.
5. Small repairs: `Panda.timers` unbounded growth; `bestAxis` off-stage fallback.

---

## Implementation phases

Build one at a time, review each on the live preview before the next (the workflow that worked last time). Bar for every phase: **alive, not noisy.**

- **Phase 0 — demolition + engine debts. ✅ shipped.** Ripped out lines/patching/freeze; landed transforms, pause, mobile gate, tableau, leak fix. The observer suite survived retargeted from `Line` to a generic `subject`, so Phase 2 replaces one call (`pickSubject`) and the rest of the loop is untouched.
  - *Found:* the conga lines had been incidentally making ~10 pandas collision-immune. Without them the ma5a baseline alone kept a mean of **12.8 of 20** pandas on the ground (vs 7.9 before) — enough to bury the Sleeper. `PANDA_COUNT` dropped to **10 wide / 7 mid** so an anomaly reads against a calm baseline; raise it once the tiers are in (Ameya's call, 2026-07-23).
  - *Fixed:* `stepWeaving` stepped along the **normalized** `AXES`, so the hat panda's diagonal strides were 50px against every other panda's 71 — it had been losing ~30% of its ground on every diagonal. `AXES` is now for scoring bearings only; both steppers share `stepCell()`.
- **Phase 1 — director + first anomalies. ✅ shipped.** The scheduler, plus sleeper / spinner / tumbler and the oblivious one. Each anomaly owns its panda through an `owns()` closure; a real knock clears `anomaly`, so the sequence sees it lost the panda and stops rather than fighting for it. Verified: 0 wedged pandas over 2 minutes, no console errors, ground occupancy mean 4.5/10.
  - *Open:* `OBLIVIOUS_R` was cut 170 → 110. At 170 the oblivious one covered as much ground as an ordinary roamer (~270px in this short band), so the whole feature was imperceptible. Tune on the preview.
- **Phase 2 — hat panda attention.** Incidents, scramble, inspect, relax beats. Acceptance: the watcher visibly notices, hurries over, studies, and sometimes arrives too late — without any scripted lateness.
- **Phase 3 — remaining tier 1.** Loop, starer, zoomies. Acceptance: variety reads; no two glances at the page look the same.
- **Phase 4 — the stack.** Mount, parade (unstoppable), wobble, topple. Rider-pose workshop happens here (standing first, sitting cel only if needed). Acceptance: the tower forms, sways, falls, and the hat panda can't look away.
- **Phase 5 — the cascade.** Arming, ignition-by-next-collision, steered two-front chain, coupling rule, staging preference. Acceptance: rare, spectacular, survivors standing, the watcher overwhelmed — and the site's best moment.

## Open decisions

1. **Rider pose** — standing (zero art) vs one hand-drawn face-down sitting cel. Prototype standing; workshop in the body editor only if it reads wrong. (Phase 4.)
2. **Cascade recovery flourish** — do the fallen just get up ma5a-style (recommend: yes, staggered by fall order is already a nice ripple), or does the hat panda "check on" one specific victim first?
3. **Exact rates** — all `*_GAP` constants are guesses; tune on the preview with real dwell.
