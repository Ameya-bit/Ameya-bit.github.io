# Panda hero choreography — the activation-patching troupe

*Started 2026-07-23. This is the choreography spec for the homepage hero panda troupe — the concept that supersedes "roaming troupe with a hat" (Candidate 6 in [whimsy.md](whimsy.md)). Base engine, palette, fencing rules, and build history live in [whimsy.md](whimsy.md) and [direction.md](direction.md); this doc specifies only what the troupe **does**. Status: **design locked, not built.** Prototype target: the steady-state loop in the workshop artifact before any site code.*

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

### Phase 1 — Pandas walk onto the screen (the entrance)
- **Goal:** replace the "greeted by 10 pandas at once" cold open with a paced reveal that sets the severe tone first.
- **Mechanics:** hero starts blank. The **hat panda ambles in first, alone** (the protagonist establishes). Then the troupe enters **a couple at a time**, not all at once, from the edges, and begins wandering (existing ma5a wander).
- **Acceptance:** the empty hero holds a beat; entries feel deliberate and staggered; ends in a calm wandering steady-state.

### Phase 2 — Conga line creation
- **Goal:** roamers organize into a follow-the-leader chain.
- **Mechanics:** *script* the nucleation (periodically seed a leader; nearby roamers fall in behind and copy the one-ahead's heading) rather than hoping it emerges. Lines can **grow** as roamers join the tail (cap: see open decisions).
- **Acceptance:** a line reads as one chain following a leader, not coincidental single-file; heading changes at the front visibly copy down the line (this is the mechanic Phase 4 depends on).

### Phase 3 — Hat panda observation
- **Goal:** establish the self-insert as the interpreter watching the system.
- **Mechanics:** whenever a line exists, the hat panda moves to a vantage off to its side, **stops, and faces it**, holding perpendicular distance and re-orienting as the line moves. Its default state is *still*.
- **Acceptance:** the hat panda reads as an outside observer, clearly not part of any line.

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

## Prototype-first plan

Before any site code: build the **steady-state loop only** (Phases 2→4→5, skip the entrance) in the workshop artifact — two heading-copying lines, the hat panda watching still from the side, one patch with the grab-arc and the bend rippling down the tail. If it reads without a caption, layer the entrance (Phase 1) and ship-integrate per the pandas.js pipeline (see [[panda-hat-pipeline]]).
