# Panda hero choreography — the activation-patching troupe

*Started 2026-07-23. This is the choreography spec for the homepage hero panda troupe — the concept that supersedes "roaming troupe with a hat" (Candidate 6 in [whimsy.md](whimsy.md)). Base engine, palette, fencing rules, and build history live in [whimsy.md](whimsy.md) and [direction.md](direction.md); this doc specifies only what the troupe **does**. Status (2026-07-23): **Phases 1–3 shipped.** Built directly into the live site (`assets/pandas/pandas.js` + `styles.scss`), not the workshop artifact — the prototype-first plan at the bottom was superseded. Phase 3's re-alignment problem is tamed for now (bearing-slip threshold raised); the durable fix (finer sprite angles) and a frame-based idle are **parked as pixel-art work** — see the Phase 3 heading. Next: Phase 4.*

---

## The thesis

The homepage hero doesn't demonstrate a *result*; it demonstrates **the method** — activation patching, the causal-intervention technique underneath every circuit the site dissects. The panda stays Ameya's identity mark (durable across research pivots — see the July-22 "identity, not topic" decision in whimsy.md); what carries the topic is the **choreography**, not the character. This resolves the identity-vs-topic tension: **durable character, topic-native choreography.**

- **Homepage hero = the method** (patching). The method never goes stale — it's the constant across every circuit, exactly like the panda-as-avatar is the constant across every research pivot. So a topic-native hero is *also* durable here.
- **Each post's hero = that post's specific circuit** (induction path-copying on the induction post, IOI name-movers on IOI, …). Keeps the "one mechanism per post" framework intact.

## The metaphor (it is literally correct, not loose)

| On screen | In interpretability |
|---|---|
| A conga line (follow-the-leader chain) | One forward pass over a sequence |
| Two conga lines | A clean run and a corrupted run |
| One panda in the line | An activation at some position |
| Hat panda grabs a panda from line B, drops it into line A | Patching that activation from the corrupted run into the clean run |
| The grabbed panda carries line B's **heading** | The patched activation's value |
| From the insertion point back to the tail, the new heading ripples down the line | The patched activation propagating downstream |
| Everyone **ahead** of the insertion keeps the old heading | Upstream of the intervention is unaffected |
| Where the bend starts | Which point you intervened at |
| The line visibly veers off course | The output changed → the activation was causally responsible |
| The hat panda | The interpreter running the experiment (the self-insert) |

The two motions divide the storytelling cleanly and stay pure-Emil (zero chroma):
- **the grab-arc** (panda visibly travels from one line to the other) = *where it came from* (the intervention)
- **the bend rippling down the tail** = *what it caused* (the propagation)

Nothing lingers as a mark; the whole thing is told in motion and then gone, like a demonstration.

## Design decisions (locked)

1. **Conga line = a heading-copying chain.** Each panda copies the heading of the one directly ahead. This is what makes propagation work: inject a foreign heading at position *k* and it propagates *k → tail* as a wave while the front stays clean. Build the line specifically this way — the layer-localization (bend position encodes where you intervened) falls out for free.
2. **Direction carries the effect, not color.** A `--gray-800`-vs-ink tone difference is nearly invisible on 48px sprites in motion and gone in a still frame; a kinking trajectory is unmistakable both moving and frozen — and it adds zero chroma. Direction is more legible *and* more Emil.
3. **The patch only fires when the two lines' headings differ meaningfully (>~45°).** A subtle bend is a wasted intervention. "Wait for a meaningful contrast before intervening" is also what a real researcher does — character and legibility pull the same way.
4. **The patch is rare** (~once per 20–30s). Most of the time it's calm conga ambling; the stillness between is what makes the intervention read as an *event*.
5. **Spotlight the pause.** When the hat panda intervenes, dim/hold everything except the two lines being compared — mirrors how patching is drawn in papers (clean vs corrupted side by side) and is both a legibility aid and an editorial beat.
6. **The hat panda observes by stillness + orientation, not trailing.** It holds *perpendicular* distance (off to the side, not at the tail), mostly **stands still and faces the line**. Standing-and-watching reads as observer; walking-behind reads as a lagging straggler. It never joins a line.
7. **Reduced motion = static tableau** (two lines, one bent, hat panda mid-reach or watching). The frozen kink still reads — another reason direction beats color.

## Core constants / rules

- **The hat panda must be faster than every other panda.** Non-negotiable: it has to close distance on a moving line, reposition to a vantage between two lines, and intercept for the grab. At parity speed it could never catch or set up an intervention. Give it a clear speed premium over the troupe's `MOVE_SPEEDS`.
- Base engine constants (`FRAME_MS`, `ANIM`, sprite rows, 50px glided steps) are ma5a's and stay fixed — see whimsy.md. Note the standing tension: her engine animates *margins*; direction.md's motion spec wants transform/opacity only. Resolve when porting (keep the 2s-glide feel on transforms, or consciously exempt the replica engine).
- Fencing (from direction.md/whimsy.md, binding): hero only, text block is a hard exclusion zone, `aria-hidden`, transform-only, rAF paused via IntersectionObserver off-screen and on `visibilitychange`.

---

## Implementation phases

Build and workshop one at a time. Each phase's bar: **does it read without a caption?**

### Phase 1 — Pandas walk onto the screen (the entrance) — ✓ SHIPPED (commit `a3dd257`)
- **Goal:** replace the "greeted by 10 pandas at once" cold open with a paced reveal that sets the severe tone first.
- **Mechanics:** hero starts blank. The **hat panda ambles in first, alone** (the protagonist establishes). Then the troupe enters **a couple at a time**, not all at once, from the edges, and begins wandering (existing ma5a wander).
- **As built:** `spawn()` in `pandas.js`; `walkIn()` steps a panda in from off-stage then hands off. Constants `LEAD_GAP` (1800), `WAVE_GAP` (1050), `WAVE_SIZE` (2), `TARGET_IN` (110). Entering pandas are collision-immune. Reduced-motion = static placement.

### Phase 2 — Conga line creation — ✓ SHIPPED (commit `4ba8512`)
- **Goal:** roamers organize into a follow-the-leader chain.
- **Mechanics:** *script* the nucleation (periodically seed a leader; nearby roamers fall in behind and copy the one-ahead's heading) rather than hoping it emerges. Lines can **grow** as roamers join the tail (cap: see open decisions).
- **As built:** `class Line` + `manageLines()` in `pandas.js`. Snake model — each follower steps into the cell the one ahead vacated, so a front heading-change ripples down the line (the Phase 4 mechanic). `LINE_CAP` (3), `MAX_LINES` (2), `LINE_STEP_MS` (950), `LINE_TURN_P` (0.35), `JOIN_RADIUS` (340), `MANAGE_START` (4200), `MANAGE_MS` (2600). Collision is **asymmetric**: a conga panda is an unstoppable force — knocks free roamers aside, never knocked itself, passes through other conga pandas. Lines persist (no dissolve — that's Phase 5).

### Phase 3 — Hat panda observation — ✓ SHIPPED
- **Goal:** establish the self-insert as the interpreter watching the system.
- **As built** (`observe()` + `bestAxis`/`AXES`/`crossesFence`/`detourCorner`/`stepToward` in `pandas.js`; idle CSS in `styles.scss`):
  - Hat panda is the **fastest** (`HAT_MOVE_MS = 540`) and a **collision ghost** — never knocks, is never knocked or tapped (the old knock→hat-drop skit is retired for it).
  - **Standoff hysteresis** (not perpendicular): base `WATCH_BASE = 150`; **plants at 3× = `WATCH_NEAR` (450)**; relocates when a line drifts past **5× = `WATCH_FAR` (750)**.
  - **Oversees all lines:** locks onto one line a random **15–30s** (`FOCUS_MIN`/`FOCUS_MAX`), then moves to another — not camping one team. It only engages a line once it's a **real conga (2+ members)** — `manageLines()` seeds a line with a lone leader first, so until a follower joins the observer just ambles; it never "watches" a single panda.
  - **Line of sight:** relocates when the hero card sits between it and the line (`crossesFence`); when relocating it **routes around** the card via corner waypoints (`detourCorner`, `CLEAR = 120`) and only accepts vantages that are on-stage **and** have a clear view.
  - **Faces dead-on:** stands on one of the **8 exact sprite axes** (`AXES`) from the line so the facing lands straight; re-aligns (a small sidestep at current distance) once the bearing slips past **22.5°** off an axis (`AXIS_COS`) — the half-angle between axes, raised from 15° to tame the over-frequent sidesteps.
  - **Idle:** a breathing bob (`.panda_wrapper.observing .panda_sprite`, `@keyframes panda-watch`, 2.6s / 3px) while planted, so it isn't frozen.
- **Acceptance:** the hat panda reads as an outside observer, clearly not part of any line, that oversees the whole scene.

> **⚠ PARKED — the durable idle/facing polish needs pixel-art authoring, not code (2026-07-23, Ameya: "I'm not an artist").** Phase 3 ships as-is; two refinements are deferred, both blocked on *drawing* new sprite cels:
> 1. **Finer facing (16 sprite angles).** The dead-on stare re-aligns because there are only **8 sprite headings** (5 rows mirrored). Drawing the **4 intermediate ¾-angles** (mirrored → 8 new headings → 16 total) would let it face the true bearing while **stationary** and likely retire the sidestep entirely. *Interim fix already applied:* `AXIS_COS` raised **15° → 22.5°** so it tolerates full inter-axis drift before adjusting — cheap, and it tames the twitch.
> 2. **Frame-based idle.** The planted idle is a CSS `translateY` bob (`@keyframes panda-watch`, styles.scss) — a rigid float. Replace with **drawn idle cels** (breathe · blink · glance-to-line) driven by a JS sequencer on irregular timing. Plan + four live motion drafts (settle / scan / fidget / curious — **scan** recommended) live in the "Observer idle — frame plan" artifact.
>
> **Enabler already built:** a **body editor** in `design/sketches/panda-behaviors-workshop.html` — rasterises any existing sprite cel into an editable pixel grid (pure-JS scanline fill, `parseDir`/`rasterCel`) so you trace-and-nudge the new angles + idle cels, and exports `PANDA_BODY_PX` (same `"x,y"→colour` shape as `HAT_PIXELS`). See [[panda-hat-pipeline]].
>
> **How to resume:** draw the cels in the body editor → export `PANDA_BODY_PX` → bake into `pandas.js` with a `bodyArt(px)` render, wire 9 sprite rows + 16-way `DIR_SPRITE`/`AXES`, and add the idle sequencer. Independent of Phase 4 — pick it up whenever the art appetite returns.

### Phase 4 — Hat panda activation patching
- **Goal:** the intervention itself, legible without a caption.
- **Mechanics:** requires **two lines coexisting** with headings >~45° apart. Hat panda moves between them → **pause + spotlight** → **grab-arc**: it visibly pulls a panda across the gap from line B and inserts it into line A → resume → the inserted panda's heading **ripples down the tail** of line A while the front stays on the old heading. Returns to its still watch. Fires ~once per 20–30s.
- **Acceptance:** a viewer reads "he pulled one across from the other line and the line bent to follow" — origin (grab-arc) and effect (bend) both land.

### Phase 5 — Conga line split & lifecycle
- **Goal:** resolve the post-patch state and keep the scene breathing.
- **Mechanics:** after a patch the line carries two headings — front (old) and back-from-the-insertion (new) — so it **splits into two divergent groups**. Elegant option: the two halves become **seeds for new lines** (patch → split → reform), tying growth, dissolution, and the intervention into one loop. Bent/split groups need bounds so they never wander under the headline (text exclusion zone); the dissolve handles most of it.
- **Acceptance:** the loop breathes — form → (two coexist) → patch → split → dissolve/reform — with no pile-up and no incursion into the text zone.

---

## Open decisions (recommended defaults — not locked)

1. **Do conga lines dissolve, or continue forever?**
   *Recommend: dissolve.* If lines never dissolve the stage saturates — every panda ends up in a line, no roamers remain to seed new ones, the form→patch→reform loop dies, and a bent line eventually hits bounds/the exclusion zone. Proposed rule: a line disbands a few seconds **after it's been patched** ("the experiment is done"), *and* has a max lifetime so un-patched lines don't live forever. Keeps a healthy churn of fresh material.

2. **Can lines grow, and what's the cap?**
   *Recommend: yes, cap = 3 (tunable up to 4).* The hero runs ~10 pandas (one hatted). Minus the hat panda, ~9 are available. Two lines at cap 3 = 6 in lines, ~3 roamers left to keep forming/joining — the roamers are what keep the scene alive and seed new lines. Cap 4 = up to 8 in lines, only ~1 roamer — a more impressive line but a barer stage. Lean 3 for liveliness; allow 4 on large viewports where panda count scales up. Ameya leaned "3 or 4" — default 3.

---

## Build log

The original plan was to prototype the steady-state loop in the workshop artifact first; in practice we **built phase-by-phase directly into the live site** (`assets/pandas/pandas.js`, styles in `styles.scss`), reviewing each phase in the Quarto preview before moving on. See [[panda-hat-pipeline]] for the sprite/hat authoring pipeline.

- **Phase 1** — entrance — ✓ shipped, commit `a3dd257`.
- **Phase 2** — conga lines + asymmetric collision — ✓ shipped, commit `4ba8512`.
- **Phase 3** — observer — ✓ shipped (commits `e021ecc` + `4fc1e67`). Re-alignment tamed (`AXIS_COS` 15°→22.5°); observer waits for a real conga (2+) before watching; finer sprite angles + frame-based idle **parked as art work** (body editor built to author them — see the Phase 3 heading).
- **Phase 4** — activation patching — **next, not started.**
- **Phase 5** — split & lifecycle — not started.
