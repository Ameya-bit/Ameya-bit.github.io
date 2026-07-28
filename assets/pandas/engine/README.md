# panda engine

The deterministic, fixed-tick simulation engine for the home-page hero pandas —
Phase A of [design/panda-policy-net.md](../../../design/panda-policy-net.md).

A pure, DOM-free `step(state, actions) -> state` that runs **byte-for-byte
identically** in Node (golden traces + the future policy trainer) and the browser
(the shipped site, loaded buildless via `<script type="module">`). The sim FSMs
are ported on top of the determinism foundation, guided by
[design/panda-engine-map.md](../../../design/panda-engine-map.md) — the full
behavioral map of the original `../pandas.js`.

## Status (2026-07-27)

**Phase A is complete and this engine is the homepage default** — the character
gate passed 2026-07-27, on its second round (see below for what round one caught).
The original `../pandas.js` stays, unmodified, behind `?engine=old`: it is the
reference the port is judged against.

| Milestone | State |
|---|---|
| **M1 — world + wander + model-space collision + knock/recover** | ✅ done |
| **M2 — director + incident queue + 8 tier-1 anomaly FSMs** | ✅ done |
| **M3 — hat panda (observe / reflex / dive-roll) + 17-action seam + i-frames** | ✅ done |
| **M4 — stack (tier 2) + cascade (tier 3)** | ✅ done |
| **M5 — presentation: real sprites/cels/CSS, tick interpolation, seated riders, the two deferred beats, the reduced-motion tableau, the `?engine=old\|new` switch** | ✅ done |
| **M6 — the entrance (`cfg.entrance`): the troupe walks on from off-stage** | ✅ done |
| **B2 — `policy/obs.js`: the observation encoder (Phase B, no site impact yet)** | ✅ done |
| **the `.stop` hit box — the last divergence from `pandas.js`** | ✅ closed |

**This engine is now frozen against cut corpora.** Phase B's 17 GB of training and
eval rollouts (`trainer/README.md`) are recordings of *this* machine, and every
manifest carries its golden digest, so a behavioural change here is no longer a day's
work — it is a re-cut and a retrain. `trainer/test/freeze.test.js` fails the moment
the two disagree, which is the intended reminder rather than an obstacle.

170 unit tests green, determinism lint clean, and the **browser-vs-Node parity
gate passes**: batch `d4a2d47b` at 32 seeds × 10k ticks and `bfbc8a5c` at 32 × 60k
(≈27 hours of simulated field), identical in Node and in Chrome. Re-run it with
`npm run serve` in one shell and `node tools/parity.mjs` in another. (Digests moved
from `f557d268`/`26907de6` when the `.stop` hit box landed, and from
`916ea37b`/`24a89cd2` before that when the glide was fixed — the trace covers both,
so it had to.)

> **The gate earned its keep on the first real run.** Node 25 and Chrome disagree
> on `Math.sin` by one ULP. It surfaced at seed `-626627309`, tick 5189 — a stack
> rider's x differing by 1e-13 through the wobble, after which the two runs never
> reconverge. `mathx.js` (the module that existed precisely to be this swap point)
> now computes `sin`/`cos` itself from IEEE-754-pinned arithmetic, and `x ** 2` —
> which is specified in terms of `Math.pow`, the same hazard — is banned by the
> lint in favour of `mathx.sq`. Digests moved once as a result; nothing else did.

**The entrance is in** (M6, Ameya's call, built before Phase B on purpose: any sim
change after the corpora are cut forces a retrain). `MODE.ENTERING` — the troupe
starts off-stage and walks on, the hat panda alone first with his lead, then waves
of two, everyone's arrival target doubling as their `home` (so the oblivious one's
patch is where it walked in to, as in the original). An entering panda is a ghost,
is invisible to all three directors, and is the one thing in the sim that moves
with the bounds/fence clamp bypassed — its corridor starts outside the stage.
It is `cfg.entrance` rather than a host-side script precisely because the corpora
need it: it is the first ~20 s of every episode a deployed policy meets, and it is
the calmest one (no anomaly fires for 9 s), which is where relax beats and camping
exploits live. Training can open mid-scene by turning it off.

**M3 scope note.** M3 ships the sim-critical watcher: the attention picker
(`pickWatchTarget` over the incident queue, with stickiness + abandonment), the
observe loop (relocate / weave / plant / sidestep), the reflex + dive-roll (now
with **i-frames** — the roll is invulnerable — and the cooldown as a tick count),
all wrapped behind the **17-way action seam** (`step(state, action)`; `hold /
step×8 / roll×8`). The applied action is logged on `hat.action` — the exact BC
target for Phase B. Deliberately **deferred to M5 (presentation):** the gaze
flourish (the planted hat just faces its subject — no random bystander glances yet)
and the hat-drop / fetch skit (a knocked hat keeps its hat and simply recovers back
into observing). Those are hand-authored character beats per the plan, not sim.

**M4 scope note.** The two multi-panda set pieces, both driven by their own clock and
both ending in ordinary collisions rather than special-cased outcomes:

- **The stack (`stack.js`).** One tower at most, every 60–120 s. The director recruits
  a base with headroom plus the 1–2 nearest free roamers; each climbs (a `flying`
  ghost) and hops onto the head below; then the tower parades as a single `solid`
  actor with the riders re-pinned every tick, teetering with a sway that accumulates
  up the tower. It topples on its parade clock or when a zoomies ploughs into it — the
  riders drop onto the base so all three hitboxes overlap, every stack flag clears,
  and the *ordinary* collision pass fells the pile a tick later. The original's nested
  `setTimeout` assembly became one explicit phase machine (`MOUNT → FLIGHT → PARADE`)
  on `state.stack`; the rider sway, which was a `performance.now()` sine, is now
  `riderSway(tick, level, cfg)` — exported so the renderer tilts by the same value
  that shifts the seats.
- **The cascade (`cascade.js`).** Arms every 2–5 min and then waits: while unarmed
  every collision is ordinary. The next natural collision — or a stack topple, the
  coupling rule — ignites a greedy nearest-neighbour sweep, each faller steered at its
  own next domino so it lands overlapping. Coverage caps at 70–90% of the roamer
  universe, so the oblivious one (structurally excluded) and a few out-of-range
  stragglers always survive. The original's recursive `victim.after(hop, …)` timers
  became a `pending` queue of scheduled falls keyed by tick. A liveness backstop
  manufactures an ignition from the panda farthest from the watcher if 40 s pass with
  no collision, and an ignition under his nose is held for a farther one — he should
  turn to find the field already going down.

The cascade's tier-3 incident is the first one whose subject is a **place, not a
panda** (`POINT_SUBJECT`): there is no one body to blame for the carnage, so the
watcher walks to the origin and stands among them. The watcher's target resolution
(`watchedTarget`) handles a panda and a spot interchangeably.

Two cross-tier races are guarded (both exist in the original, both look broken when
they land): tier 2 will not recruit a panda a cascade front has already claimed, and
a scheduled fall on a panda that joined a tower meanwhile is dropped rather than
yanking a rider out of mid-air.

## Core model

- **Fixed tick = 50 ms (20 Hz)** — confirmed against the original (`STACK_TICK_MS`
  and the collision `setInterval` were both 50 ms). Every `*_MS` constant is
  converted to ticks in `config.js`; the hat panda's action interface is 10 Hz
  (one decision per 2 ticks).
- **Two-position movement.** The original's collision read the smooth 2 s CSS-glide
  position, not the logical step — the glide is a collision softener. So each
  entity carries a **logical** position (`lx, ly` — the stride grid, fenced) and a
  **visual** position (`x, y`) that glides toward it. Collision and rendering use
  the visual position; wander/fence logic uses the logical one. `.stop` behaviours
  (knock slide, tumbler skid, zoomies dash, any grounded phase) snap visual to
  logical.
- **`.stop` is physics, not style.** Besides killing the glide it shortened the
  original's hit box (`margin-top: 8px; height: 46px`), so a grounded, skidding,
  dashing or parading panda collides with a different box than a standing one. The
  entity carries it as `stopped` — set and cleared exactly where pandas.js added and
  removed the class — and `collision.js` picks the box off it. Contacts compare
  corner top-lefts rather than box edges, so a stopped panda cedes 8px of reach
  upward and gains 4px downward.
- **The glide is a port of the CSS transition, restart and all.** `transition:
  transform 2s` with the default `ease` curve, and the original writes the
  transform *only when the logical position changes* — so each stride starts a
  **fresh** curve from wherever the body had glided to. `cfg.glideTicks = 40` is
  that duration; `mathx.cssEase` is that curve (cubic-bezier(0.25, 0.1, 0.25, 1),
  Newton-inverted with a fixed iteration count, sampled once per config into
  `cfg.glideCurve`). ⚠️ The first port used an exponential chase
  (`x += (lx - x) * 0.08`) instead. It has the same average lag and none of the
  shape: constant velocity instead of a stride that surges and settles, and a
  reversal that has to decelerate through zero before it turns. On the page that
  reads as **sliding on ice with momentum to overturn** — caught by Ameya at the
  character gate, 2026-07-27, and not by any test, which is why `test/glide.test.js`
  now pins the restart, the settle and the turn.
- **…and the browser was smoothing it a second time.** Fixing the engine did not fix
  the page, because `styles.scss` — which loads on every visit, since `?engine=old`
  still has to work — sets `.panda_wrapper { transition: transform 2s }`, and
  `render/pandas.css` merely *omitted* a transition. The cascade resolves conflicting
  declarations, not absent ones, so the browser went on animating the engine's
  transforms over 2 s. Measured on the page: **22 px/s drawn against the engine's
  ~44 px/s** — over half of every stride eaten. Worse, the drawn body then sat tens of
  pixels from the hitbox that collides, which is why pandas appeared to **walk through
  each other and through the hat panda, "but sometimes" collide**. Both of the
  character gate's findings were this one bug. The fix is a specificity one:
  `host.js` puts `.panda_engine` on the stage and `pandas.css` overrides through it,
  so it cannot silently depend on sheet load order. **The dev pages never showed it —
  `tools/stage.html` and `tools/preview.html` don't load `styles.scss`.** Anything
  about how the engine looks has to be judged on the real page.
- **`mode` tag** drives each panda (WANDER / KNOCKED / the 8 anomalies / the hat's
  OBSERVING + ROLLING); the original's loose `anomaly`/`solid`/`riding`/`flying`/
  `entering` flags collapse into it. `isDown(e)` (grounded animation) gates
  collision knock-immunity; a rolling hat is i-framed on top of that.
- **Density scales with viewport** via `layout.js` (host-side): `pandaCount =
  clamp(freeArea / areaPerPanda)`. Locked default `areaPerPanda = 217000`
  (Ameya's pick: ~15 pandas at 2560×1343). This pairs with the trainer, which
  randomizes density across corpora (Phase B).
- **Nothing implementation-defined touches state.** `mathx.js` computes `sin`/`cos`
  from pinned arithmetic; `sqrt` is native (IEEE-754 requires correct rounding);
  `exp`/`pow`/`atan2` are not exported at all, and `**` is lint-banned. That is
  what makes "the browser and Node run the same machine" a checkable claim rather
  than a hope.

## The presentation layer (M5)

Strictly one-way: the sim decides what is true, `render/` decides what that looks
like, and nothing measured or drawn is ever written back. A headless rollout (Node,
the trainer) never loads any of it.

- **Two ticks are held and drawn between.** The engine runs at a fixed 20 Hz, the
  display at whatever the monitor does, so each frame interpolates the previous
  tick toward the current one. A position change larger than `JUMP_PX` is a
  teleport (a knock snap, a hop landing, a topple drop), taken whole rather than
  smeared. Note the CSS transition is **gone** — in the original the 2 s glide *was*
  the movement model, and the engine now owns it — but "gone" takes an explicit
  `transition: none` through `.panda_engine`, because the old sheet still declares it
  for `?engine=old`. See the glide note above; this was a shipped bug, not a
  hypothetical.
- **Cels free-run at the original's 140 ms**, except where the sim owns the
  progress — the dive-roll's 5 cels span exactly its 5 ticks, and a mount hop or a
  hiccup pop freezes the stance because the panda is being thrown, not walking.
- **Seated riders sit on the drawn head.** The engine carries one flat
  `riderRise = 62` (art data has no business in sim state); the renderer corrects
  it per facing from the seated art's own measured height (48–54 px), easing the
  correction in across the hop so a climber never jumps as it lands.
- **The two hand-authored beats** live in `render/flourish.js`. The gaze flourish
  is a drawn facing only. The hat-drop/fetch skit needs him to actually *walk*, so
  rather than smuggle a second movement system into the sim it **drives the same
  17-way action seam a policy will** — one action per tick while it owns him, null
  the rest of the time. While it does, the rules expert doesn't run, so he can't
  dodge mid-fetch: preoccupied, which is the joke, and what the original did too.

## The hat-panda seam (M3)

The hat panda is the one entity a policy drives. `step(state, action)` takes an
optional action for it; everything else is autonomous.

- **The action** is one integer per decision tick (10 Hz = every 2 engine ticks),
  from `actions.js`: `0` HOLD, `1..8` STEP+dir, `9..16` ROLL+dir (17 total). Only
  locomotion + evasion — *where to be*. Attention (which subject, gaze) is **not**
  in the action space; the policy expresses it through where it walks.
- **`step(state, action)` semantics:** `action == null` (the default, and the
  shipped site) → the built-in rules expert (`watcher.js`) decides. An integer
  `0..16` on a decision tick overrides the expert. A malformed value (NaN /
  out-of-range — a future NN's bad logit) falls back to the expert (`isValidAction`
  guard). Off-decision ticks ignore the action and just glide; an in-progress roll
  (5 ticks) ignores it entirely and runs to completion.
- **Exact BC targets:** the action actually applied each tick is written to
  `hat.action` and serialised by `encode()`. Phase B logs `(observation,
  hat.action)` straight off a `step(state)` rollout — no re-derivation, the logged
  action *is* what moved him. `rulesAction` is re-exported for querying the expert
  directly, but note it **mutates** the hat's brain (it is the expert, not a
  dry-run); the side-effect-free path is reading `hat.action` off the stepped state.
- **Pacing lives in the policy, not the engine.** A STEP is one 50px stride applied
  immediately; the rules expert emits STEP only at its stride cadence and HOLDs
  between, so it moves at the right speed. A learned policy sets its own rhythm the
  same way. This is why the interface is 17 discrete actions rather than a velocity.

## The observation encoder (`policy/obs.js`, B2)

The other half of the policy seam: the action interface is what the policy *does*,
this is what it *sees*. One `Float32Array` frame per decision tick — a self token
of proprioception plus `slots` neighbour tokens — built by `makeObserver(params)`,
which mirrors `makeEngine`: `init()` mints the slot memory, `observe(state, mem)`
advances it and fills a frame.

It lives here rather than in `trainer/` because **Phase D ships it**: the
in-browser policy has to encode its own observations from the same state the
renderer draws. One implementation, imported by the trainer and by the page, the
same way the trainer imports the engine instead of vendoring it — and it is inside
the determinism lint's reach, which matters, because an encoder that rounds
differently in Chrome than in Node would move actions the trainer never saw.

- **Vision is a heading cone** (D1, variant (b)): `coneDeg` about his facing out to
  `sightRange`, plus a short omnidirectional `peripheralR` stub, and the hero card
  is opaque (`occludeFence`, via the same `crossesFence` the watcher routes by).
  Measured over four 10-minute episodes per corpus spec: he sees a mean of 1.7
  (natural) to 3.7 (wild) pandas at once out of 7–17 on the field, holds 0.6–1.4
  more from memory alone, and is looking at nobody at all in 3–12% of frames. Those
  are the numbers D1 exists to produce, and the knobs Phase C will turn to move the
  memory gap.
- **What a neighbour token carries is what a bystander could see**: egocentric
  position, distance, drawn facing and drawn animation, whether it is airborne in a
  hiccup pop, and where it sits in a tower. The operational rule is stricter than a
  list — *the encoder may read of another panda only what `render/renderer.js`
  reads* — and a read-tracking proxy in `test/obs.test.js` enforces it. Hence the
  flagship property, pinned as its own test: **a sleeper and a freshly-knocked panda
  encode to identical bytes.** Telling them apart is memory's job.
- **Slots are sticky, and that is the only memory in here.** A slot stays bound to
  its panda through `holdTicks` out of sight, so the network is not made to solve
  identity binding before it can infer anything (a confound, not the study). But an
  unseen panda's token drops to `present = 1` and *zeros* — no stale position, no
  last-known pose. A decaying estimate in the sensor would be the belief we are
  trying to watch emerge, pre-built.
- **Positions are the visual ones** (`x, y`) — the drawn body, which is also the one
  that collides. The rules expert reasons on the logical stride grid and so sees a
  step into the future; the policy does not get that, deliberately. It sees the
  picture.
- **Frozen, and checkably so.** The arithmetic is +,-,*,/ and `sqrt` into a
  `Float32Array` (whose store is the same round-to-nearest-even `Math.fround`
  performs), plus one `mathx.cos` at construction — so cross-engine bit-identity
  holds by construction. `policy/obs-fixture.json` makes it *testable*: four
  (world, slot memory) → (frame, slot memory) cases carrying only the observable
  projection of a real state, so a Python or WASM port can be held to them without
  a simulator. `node tools/obs-fixture.js --check` (a unit test runs it) fails if
  the encoder drifts from the fixture; the layout freezes with the roster at the
  exit of Phase B, because changing it invalidates a cut corpus.

## Layout

| File | Role |
|---|---|
| `rng.js` | Seeded PRNG (mulberry32); state is one uint32 threaded through `step`. Replaces `Math.random`. |
| `mathx.js` | `sin`/`cos` computed from IEEE-754-pinned arithmetic (NOT `Math`'s — they differ across engines), plus `cssEase` (the glide's `ease` curve) and `sq`/`hypot`/`clamp`. The one sanctioned home for anything transcendental. |
| `tick.js` | Fixed-tick clock (`TICK_HZ=20`/`TICK_MS=50`, 10 Hz action cadence) + ms→tick / pxPerMs→perTick converters. |
| `config.js` | Every tunable, defaults = live values, timing in ticks. `makeConfig(overrides)` for training corpora. |
| `dirs.js` | 8 headings: `DX/DY` (full STEP/axis, for strides), `AX/AY` (normalized, for zoomies/tumbler), `eightWay`. |
| `geometry.js` | Pure bounds / hero-card fence / `applyPos` (per-axis, x commits before the y-check, like the original). |
| `state.js` | Entity factory, `MODE`/`ANIM`/`KNOCK` enums, `isDown`, `easeVisual`/`snapVisual` (the CSS transition, restart semantics and all), `spawnEntities` + the entrance's off-stage placement and `advanceEntrance`. |
| `collision.js` | Model-space corner-proximity collision (replaces `getBoundingClientRect`); i-frames while the hat rolls. |
| `anomalies.js` | The 8 tier-1 FSMs (`startAnomaly`/`updateAnomaly`) + shared grounded fall→lie→stand tail. Exports its sub-phase constants as `PHASE` for Phase C's oracle, which estimates time-remaining off the FSM scratch (`trainer/percept.js`, held to ground truth by a test). |
| `director.js` | Tier-1 scheduler (pick kind≠last + eligible candidate), the shared `isFreeRoamer` pool test, and the incident queue (`emitIncident`/`pruneIncidents`). |
| `stack.js` | Tier 2: the tower — director, mount walk + hop, parade with accumulating sway, topple. Exports `riderSway` for the renderer. |
| `cascade.js` | Tier 3: the arming clock, the nearest-neighbour sweep (`igniteCascade`/claims/scheduled falls), `cascadeKnock`, the liveness backstop. |
| `actions.js` | The hat panda's 17-way discrete action interface (`hold / step×8 / roll×8`) — the policy seam. `ACTION_NAME`/`actionName` name them for anything that has to print one (the corpus manifest, a debug overlay); the sim never reads those. |
| `watcher.js` | The hat panda's rules brain: attention picker + observe/reflex logic, emitting one action per decision tick (`rulesAction`). |
| `hat.js` | The engine side of the seam: executes an action (`updateHat`), runs the roll + knock mechanics. |
| `engine.js` | `makeEngine(config)` factory + default `init`/`step(state, action)`/`encode`; per-entity dispatch, director, hat, collisions. Re-exports `ACTION` + `rulesAction`. |
| `layout.js` | Host-side `pandaCountForViewport` — density scaling. Not engine core. |
| `policy/obs.js` | The observation encoder (B2): heading-cone FOV, sticky per-panda slots, one Float32 frame per decision tick. The other half of the seam. |
| `policy/obs-fixture.json` | **Generated.** The encoder's cross-language contract — (world, slot memory) → frame cases another implementation must reproduce. Re-bake, never hand-edit. |
| `render/art-data.js` | **Generated.** The art lifted verbatim from `../pandas.js`: sprite rows, hat pixels + seats, seated cels. Never hand-edit — re-bake. |
| `render/art.js` | Builds the SVG: sprite blocks (with/without the worn hat), the loose hat, the five seated drawings + their measured seat heights. |
| `render/cels.js` | Cel tables — which of the 13 columns and 5 rows an `(anim, dir)` draws, and the 140 ms frame cadence. |
| `render/renderer.js` | Engine state → DOM, once per frame: transforms + depth, facings, cels, state classes, rider seats and tilt. Interpolates between the two held ticks. |
| `render/flourish.js` | The two hand-authored beats: the gaze flourish (a drawn facing) and the hat-drop/fetch skit (drives the 17-way seam). |
| `render/tableau.js` | The reduced-motion still, built as an ordinary state so the ordinary renderer draws it. |
| `render/host.js` | `mountPandas(stage)` — the fixed-timestep loop, pause (hidden tab / off-screen), resize re-framing, density, reduced-motion branch. |
| `render/site.js` | The homepage entry point — loaded on every visit that does not ask for `?engine=old`. |
| `render/pandas.css` | Presentation styles for the engine-rendered pandas. Separate from `styles.scss` so both engines can run side by side. |
| `tools/checksum.js` | FNV-1a over canonical IEEE-754 bytes — identical hashes across V8. `hashBytes` is the same hash fed raw bytes, for artefacts that need no canonicalising (a corpus shard's float32 rows). |
| `tools/trace.js` | Engine-agnostic golden-trace runner (`runSeed`/`runTrace`/`firstDivergence`) + the 32-seed set. |
| `tools/golden.js` | CLI: run an engine across 32 seeds × N ticks, print per-seed + batch digests. |
| `tools/golden.html` | Browser side of the same computation — its batch digest must equal the CLI's. |
| `tools/preview.html` | Dev preview: full-window stage, hero-card fence, density slider, anomaly/role tags, stack + cascade readouts, and buttons that nudge the tier-2/3 clocks so the rare set pieces are watchable. **Schematic shapes, not the shipped sprites.** |
| `tools/stage.html` | Dev preview with the **real** sprites: a hero-card stand-in, the fence, and a "knock his hat off" button so the fetch skit is watchable on demand. |
| `tools/bake-art.js` | Lifts the art literals out of `../pandas.js` into `render/art-data.js`. `--check` fails if they have drifted (a unit test runs it). |
| `tools/obs-fixture.js` | Bakes `policy/obs-fixture.json`. `--check` fails if the encoder no longer produces it (a unit test runs it). |
| `tools/parity.mjs` | The browser-vs-Node gate, automated: compares batch digests and bisects a mismatch to the seed, tick and encode slot. Needs Playwright (deliberately not a dependency). |
| `tools/demo-engine.js` | A toy engine that proved the harness before the real engine existed. Deletable. |
| `tools/lint-determinism.js` | Fails if engine code reaches for `Math.random` / clock / timers / rAF / raw transcendentals. |
| `tools/serve.js` | Zero-dep dev static server that sends `no-store`, so edited ES modules are never served stale (`npm run serve`). |
| `test/` | `node --test` unit tests for every module. |

## Commands

Run from this directory:

```sh
node --test                              # unit tests
npm run lint:determinism                 # ban check on engine sources
node tools/bake-art.js --check           # the baked art still matches pandas.js
node tools/obs-fixture.js --check        # the observation encoder still matches its fixture
node tools/golden.js --engine ./engine.js --ticks 10000   # deterministic trace digest
npm run serve                            # dev server -> /tools/stage.html (real sprites)
                                         #            -> /tools/preview.html (schematic + set-piece buttons)
```

The suite is deterministic and should be green every time. It was not, until
2026-07-27: `flourish.test.js` failed about one run in three, because the skit is
presentation and so is *allowed* `Math.random` (where the hat lands when it comes
off), and an unlucky toss plus a re-knock mid-fetch — he cannot dodge while the skit
owns him — pushed the fetch past the test's tick budget. Those two tests now pin
`Math.random` for their duration instead of widening the budget and hoping. A test
that fails one run in three teaches you to ignore red, which is the actual damage.

Browser-vs-Node parity gate — with `npm run serve` running, either:

```sh
node tools/parity.mjs --ticks 10000      # automated (drives your installed Chrome)
```

…or by hand: open `/tools/golden.html?ticks=10000` and confirm its batch digest
equals `node tools/golden.js --engine ./engine.js --ticks 10000`. Current values:
`d4a2d47b` at 10k ticks, `bfbc8a5c` at 60k. (Without `--engine ./engine.js` the CLI
digests the *toy demo* engine, which never changes — an easy way to fool yourself.)

**Use `npm run serve`, not `python3 -m http.server`.** Python's server sends only
`Last-Modified` — no `Cache-Control`, no `ETag` — so browsers apply heuristic caching to
ES modules and can serve a stale one without revalidating. After an edit you then get
errors describing the code as it *was*: the giveaway is `SyntaxError: doesn't provide an
export named 'X'` for an export that is plainly in the file (and in the served response).
`tools/serve.js` sends `no-store` on everything, so a plain refresh always picks up the
real module graph. If you do end up on a cached page, Cmd/Ctrl+Shift+R clears it.

## Rules

- Engine code (everything outside `test/`, `tools/` and `render/`) is a pure
  function of `(seed, actions)`: no `Math.random`, no wall clock, no timers/rAF, no
  raw `Math` transcendentals and no `**` (route through `mathx.js`). The
  determinism lint enforces this. `render/` is the presentation layer those rules
  exist to protect, so it is exempt — it owns rAF, the wall clock, and the visit's
  seed by design, and is never called from `step()`.
- No DOM in the engine. Positions, facings, and modes are plain state; the
  presentation layer turns them into transforms/classes and interpolates between
  ticks.
- No dependencies. Node's built-in test runner only.

## Picking up from here

Phase A is closed, and so is Phase B, in [`trainer/`](../../../trainer/README.md) —
except the observation encoder, which lives here (see above). **The corpora are cut
and the roster is frozen**, which changes what a sim change costs: `trainer/test/
freeze.test.js` compares every committed corpus manifest against this engine's
golden digest, the encoder's fixture digest and every schema, so editing the roster,
a mode, the observation layout or the action space now turns that suite red and means
re-cutting 17 GB and retraining anything fitted to it. Sim changes need a reason
worth that from here on; the last free one (the `.stop` hit box, in the
character-gate record below) landed just before the cut.

### The character gate (passed 2026-07-27, on round two)

Everything about *how it moves* is Ameya's call: the glide (`cfg.glideTicks`), the
knock rate, the density, the interpolation, whether the watcher still reads as a
watcher. The page wins over the number, always.

   - **Round 1 found two symptoms with one cause** — ice, and pandas
     passing through each other. Both were the double transition above: the engine's
     exponential-chase glide *and* the legacy CSS animating the result again. Both
     fixed; round two passed and the homepage default flipped to this engine.
   - **The collision economy was then measured against the original**, by polling both
     pages in a real browser for 10 minutes each (the original is DOM/timer-driven, so
     a browser is its only clock):

     | | old | new |
     |---|---|---|
     | 1600×900, 10 pandas both | 4.00 knocks/min, 40.1% grounded | 3.20 knocks/min, 33.2% grounded |
     | 2560×1343 (a real monitor) | 10 pandas, 1.70/min, 14.9% | 11 pandas, 0.80/min, 7.4% |
     | median knock | 5.6 s | 5.6 s |

     **The port is not hotter than the original — it is gentler**, consistently, which
     is the dive-roll's i-frames (a deliberate M3 addition) doing exactly what they
     were added to do. The identical median knock says the recovery FSM is faithful.
     Note also how violently knock rate depends on stage *area*: the same 10 pandas
     go from 4.0/min to 1.7/min between those two viewports.
   - Two windows exist where a contact legitimately does nothing, in both engines: the
     entrance (~12 s of collision ghosts) and any grounded panda, which cannot be
     re-knocked. Otherwise a standing hat panda is knocked by *every* contact — no
     exclusion ever fires in 160k ticks of instrumented sim.
   - **Density differs by design.** The original spawns a flat 10 pandas on any desktop
     (`W >= 1200 ? 10 : 7`); the port scales with free area (`layout.js`,
     `areaPerPanda = 217000`, Ameya's 2026-07-26 pick). Same density, different counts:
     11 on a 2560×1343 monitor's hero region against the original's 10. The "≈15" that
     pick was made against was in `tools/preview.html`, whose stage is the whole window
     rather than the shorter hero strip — the density is the same, the count is not.
   - **The one known divergence is now closed (2026-07-27):** the original shrinks a
     `.stop` panda's hit box (`.panda_wrapper.stop .hit_area { margin-top: 8px;
     height: 46px }` — zoomies, skids, anything grounded, the parading stack base),
     where `collision.js` used the 44×54 box for everyone. It was deferred so that
     one change was being judged at a time, and it had to land before the corpus cut
     (after that a sim change costs a retrain). It moved the golden digests and the
     obs fixture with it, as expected.

     **What it does to the economy, measured headless over 24 episodes × 20 min at
     1600×900 (and 40 × 20 min at 1200×520), before vs after:**

     | | knocks/min (hat) | grounded |
     |---|---|---|
     | 1600×900 | 1.53 → **1.77** | 13.2% → **15.0%** |
     | 1200×520 | 2.63 → **2.89** | 22.9% → **24.9%** |

     So the watcher goes down **10–16% more often** — the port moves *toward* the
     original's hotter economy, which is the direction fidelity predicted. The
     mechanism is the asymmetry: the box a *fallen* panda wears reaches 4px further
     down, and the watcher's whole job is standing next to fallen pandas. (These are
     headless numbers on a bare rectangle; they are not comparable to the in-browser
     rates in the table above, which were measured on the real hero strip. Only the
     before/after delta is.) **The motion is Ameya's call, as always.**

Everything the trainer needs is already in place: `step(state, action)` takes the
17-way action, the applied action is logged on `hat.action`, and the parity gate
proves the browser and the trainer are stepping the same machine.
