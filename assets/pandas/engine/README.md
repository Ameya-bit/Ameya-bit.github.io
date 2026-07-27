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

**The port is complete and the Phase-A gates are green.** The homepage now loads
this engine on `?engine=new`; **the default is still the original `../pandas.js`,
untouched**, and stays that way until Ameya's character gate passes.

| Milestone | State |
|---|---|
| **M1 — world + wander + model-space collision + knock/recover** | ✅ done |
| **M2 — director + incident queue + 8 tier-1 anomaly FSMs** | ✅ done |
| **M3 — hat panda (observe / reflex / dive-roll) + 17-action seam + i-frames** | ✅ done |
| **M4 — stack (tier 2) + cascade (tier 3)** | ✅ done |
| **M5 — presentation: real sprites/cels/CSS, tick interpolation, seated riders, the two deferred beats, the reduced-motion tableau, `?engine=old\|new`** | ✅ done |

129 unit tests green, determinism lint clean, and the **browser-vs-Node parity
gate passes**: batch `6acd01f7` at 32 seeds × 10k ticks, and `711c07e4` at 32 ×
60k (≈27 hours of simulated field), identical in Node and in Chrome. Re-run it
with `npm run serve` in one shell and `node tools/parity.mjs` in another.

> **The gate earned its keep on the first real run.** Node 25 and Chrome disagree
> on `Math.sin` by one ULP. It surfaced at seed `-626627309`, tick 5189 — a stack
> rider's x differing by 1e-13 through the wobble, after which the two runs never
> reconverge. `mathx.js` (the module that existed precisely to be this swap point)
> now computes `sin`/`cos` itself from IEEE-754-pinned arithmetic, and `x ** 2` —
> which is specified in terms of `Math.pow`, the same hazard — is banned by the
> lint in favour of `mathx.sq`. Digests moved once as a result; nothing else did.

**What is still open:** the entrance. The original walks the troupe on from
off-stage (hat panda first, then waves of two — map §8); the engine places
everyone at a clear spot at tick 0 instead. That is movement, so it is sim work,
not presentation — and it changes initial conditions for the training corpora, so
it is Ameya's call whether to add an `ENTERING` mode (the `entering` flag and its
collision/director exemptions are already in place) or to let the new engine open
on a field already in motion.

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
  **visual** position (`x, y`) that eases toward it (`config.glideK`). Collision
  and rendering use the visual position; wander/fence logic uses the logical one.
  `.stop` behaviours (knock slide, tumbler skid, zoomies dash, any grounded phase)
  snap visual to logical.
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
  smeared. Note the CSS transition is **gone**: in the original the 2 s glide *was*
  the movement model, and the engine now owns it.
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

## Layout

| File | Role |
|---|---|
| `rng.js` | Seeded PRNG (mulberry32); state is one uint32 threaded through `step`. Replaces `Math.random`. |
| `mathx.js` | `sin`/`cos` computed from IEEE-754-pinned arithmetic (NOT `Math`'s — they differ across engines), plus `sq`/`hypot`/`clamp`. The one sanctioned home for anything transcendental. |
| `tick.js` | Fixed-tick clock (`TICK_HZ=20`/`TICK_MS=50`, 10 Hz action cadence) + ms→tick / pxPerMs→perTick converters. |
| `config.js` | Every tunable, defaults = live values, timing in ticks. `makeConfig(overrides)` for training corpora. |
| `dirs.js` | 8 headings: `DX/DY` (full STEP/axis, for strides), `AX/AY` (normalized, for zoomies/tumbler), `eightWay`. |
| `geometry.js` | Pure bounds / hero-card fence / `applyPos` (per-axis, x commits before the y-check, like the original). |
| `state.js` | Entity factory, `MODE`/`ANIM`/`KNOCK` enums, `isDown`, `easeVisual`/`snapVisual`, `spawnEntities`. |
| `collision.js` | Model-space corner-proximity collision (replaces `getBoundingClientRect`); i-frames while the hat rolls. |
| `anomalies.js` | The 8 tier-1 FSMs (`startAnomaly`/`updateAnomaly`) + shared grounded fall→lie→stand tail. |
| `director.js` | Tier-1 scheduler (pick kind≠last + eligible candidate), the shared `isFreeRoamer` pool test, and the incident queue (`emitIncident`/`pruneIncidents`). |
| `stack.js` | Tier 2: the tower — director, mount walk + hop, parade with accumulating sway, topple. Exports `riderSway` for the renderer. |
| `cascade.js` | Tier 3: the arming clock, the nearest-neighbour sweep (`igniteCascade`/claims/scheduled falls), `cascadeKnock`, the liveness backstop. |
| `actions.js` | The hat panda's 17-way discrete action interface (`hold / step×8 / roll×8`) — the policy seam. |
| `watcher.js` | The hat panda's rules brain: attention picker + observe/reflex logic, emitting one action per decision tick (`rulesAction`). |
| `hat.js` | The engine side of the seam: executes an action (`updateHat`), runs the roll + knock mechanics. |
| `engine.js` | `makeEngine(config)` factory + default `init`/`step(state, action)`/`encode`; per-entity dispatch, director, hat, collisions. Re-exports `ACTION` + `rulesAction`. |
| `layout.js` | Host-side `pandaCountForViewport` — density scaling. Not engine core. |
| `render/art-data.js` | **Generated.** The art lifted verbatim from `../pandas.js`: sprite rows, hat pixels + seats, seated cels. Never hand-edit — re-bake. |
| `render/art.js` | Builds the SVG: sprite blocks (with/without the worn hat), the loose hat, the five seated drawings + their measured seat heights. |
| `render/cels.js` | Cel tables — which of the 13 columns and 5 rows an `(anim, dir)` draws, and the 140 ms frame cadence. |
| `render/renderer.js` | Engine state → DOM, once per frame: transforms + depth, facings, cels, state classes, rider seats and tilt. Interpolates between the two held ticks. |
| `render/flourish.js` | The two hand-authored beats: the gaze flourish (a drawn facing) and the hat-drop/fetch skit (drives the 17-way seam). |
| `render/tableau.js` | The reduced-motion still, built as an ordinary state so the ordinary renderer draws it. |
| `render/host.js` | `mountPandas(stage)` — the fixed-timestep loop, pause (hidden tab / off-screen), resize re-framing, density, reduced-motion branch. |
| `render/site.js` | The homepage entry point (`?engine=new` loads this). |
| `render/pandas.css` | Presentation styles for the engine-rendered pandas. Separate from `styles.scss` so both engines can run side by side. |
| `tools/checksum.js` | FNV-1a over canonical IEEE-754 bytes — identical hashes across V8. |
| `tools/trace.js` | Engine-agnostic golden-trace runner (`runSeed`/`runTrace`/`firstDivergence`) + the 32-seed set. |
| `tools/golden.js` | CLI: run an engine across 32 seeds × N ticks, print per-seed + batch digests. |
| `tools/golden.html` | Browser side of the same computation — its batch digest must equal the CLI's. |
| `tools/preview.html` | Dev preview: full-window stage, hero-card fence, density slider, anomaly/role tags, stack + cascade readouts, and buttons that nudge the tier-2/3 clocks so the rare set pieces are watchable. **Schematic shapes, not the shipped sprites.** |
| `tools/stage.html` | Dev preview with the **real** sprites: a hero-card stand-in, the fence, and a "knock his hat off" button so the fetch skit is watchable on demand. |
| `tools/bake-art.js` | Lifts the art literals out of `../pandas.js` into `render/art-data.js`. `--check` fails if they have drifted (a unit test runs it). |
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
node tools/golden.js --engine ./engine.js --ticks 10000   # deterministic trace digest
npm run serve                            # dev server -> /tools/stage.html (real sprites)
                                         #            -> /tools/preview.html (schematic + set-piece buttons)
```

Browser-vs-Node parity gate — with `npm run serve` running, either:

```sh
node tools/parity.mjs --ticks 10000      # automated (drives your installed Chrome)
```

…or by hand: open `/tools/golden.html?ticks=10000` and confirm its batch digest
equals `node tools/golden.js --engine ./engine.js --ticks 10000`. Current values:
`6acd01f7` at 10k ticks, `711c07e4` at 60k.

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

Phase A is done bar one judgment call and one deliberate omission.

1. **The character gate.** Open the homepage with `?engine=new` and compare it to
   the default. Everything about *how it moves* is Ameya's call: the glide
   (`cfg.glideK`), the knock rate, the density, the interpolation, whether the
   watcher still reads as a watcher. The page wins over the number, always. Only
   after that does the default flip from `old` to `new`.
2. **The entrance** (map §8), the one behaviour not ported — see Status above.
   Ameya's call, because it is sim work and it moves the training corpora's
   initial conditions.
3. **Then Phase B** (design/panda-policy-net.md): the Node rollout harness,
   per-tick ground-truth logging, the observation encoder, and the corpus cut —
   at which point the anomaly roster freezes.

Everything the trainer needs is already in place: `step(state, action)` takes the
17-way action, the applied action is logged on `hat.action`, and the parity gate
proves the browser and the trainer are stepping the same machine.
