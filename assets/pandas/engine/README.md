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

The **live site still runs the original `../pandas.js`, untouched.** This engine
gets wired into the homepage (behind `?engine=old|new`) only once it passes the
golden-trace gate and Ameya's preview. Progress on the port (task #6):

| Milestone | State |
|---|---|
| **M1 — world + wander + model-space collision + knock/recover** | ✅ done |
| **M2 — director + incident queue + 8 tier-1 anomaly FSMs** | ✅ done |
| **M3 — hat panda (observe / reflex / dive-roll) + 17-action seam + i-frames** | ✅ done |
| M4 — stack (tier 2) + cascade (tier 3) | next |
| M5 — presentation port (real sprites/cels/CSS + renderer interpolation), reduced-motion tableau, wire `index.qmd` behind `?engine=old|new` | — |

89 unit tests green, determinism lint clean, golden digests stable Node-side
(batch `4dbc8291` @ 32 seeds × 10k ticks). Browser-vs-Node parity (task #7) still
needs a connected Chrome and re-runs against the finished engine.

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
| `mathx.js` | The one sanctioned home for transcendentals (swap point for cross-engine variance) + `clamp`. |
| `tick.js` | Fixed-tick clock (`TICK_HZ=20`/`TICK_MS=50`, 10 Hz action cadence) + ms→tick / pxPerMs→perTick converters. |
| `config.js` | Every tunable, defaults = live values, timing in ticks. `makeConfig(overrides)` for training corpora. |
| `dirs.js` | 8 headings: `DX/DY` (full STEP/axis, for strides), `AX/AY` (normalized, for zoomies/tumbler), `eightWay`. |
| `geometry.js` | Pure bounds / hero-card fence / `applyPos` (per-axis, x commits before the y-check, like the original). |
| `state.js` | Entity factory, `MODE`/`ANIM`/`KNOCK` enums, `isDown`, `easeVisual`/`snapVisual`, `spawnEntities`. |
| `collision.js` | Model-space corner-proximity collision (replaces `getBoundingClientRect`); i-frames while the hat rolls. |
| `anomalies.js` | The 8 tier-1 FSMs (`startAnomaly`/`updateAnomaly`) + shared grounded fall→lie→stand tail. |
| `director.js` | Tier-1 scheduler (pick kind≠last + eligible candidate) + the incident queue (`emitIncident`/`pruneIncidents`). |
| `actions.js` | The hat panda's 17-way discrete action interface (`hold / step×8 / roll×8`) — the policy seam. |
| `watcher.js` | The hat panda's rules brain: attention picker + observe/reflex logic, emitting one action per decision tick (`rulesAction`). |
| `hat.js` | The engine side of the seam: executes an action (`updateHat`), runs the roll + knock mechanics. |
| `engine.js` | `makeEngine(config)` factory + default `init`/`step(state, action)`/`encode`; per-entity dispatch, director, hat, collisions. Re-exports `ACTION` + `rulesAction`. |
| `layout.js` | Host-side `pandaCountForViewport` — density scaling. Not engine core. |
| `tools/checksum.js` | FNV-1a over canonical IEEE-754 bytes — identical hashes across V8. |
| `tools/trace.js` | Engine-agnostic golden-trace runner (`runSeed`/`runTrace`/`firstDivergence`) + the 32-seed set. |
| `tools/golden.js` | CLI: run an engine across 32 seeds × N ticks, print per-seed + batch digests. |
| `tools/golden.html` | Browser side of the same computation — its batch digest must equal the CLI's. |
| `tools/preview.html` | Dev preview: full-window stage, hero-card fence, density slider, anomaly tags. **Schematic shapes, not the shipped sprites.** |
| `tools/demo-engine.js` | A toy engine that proved the harness before the real engine existed. Deletable. |
| `tools/lint-determinism.js` | Fails if engine code reaches for `Math.random` / clock / timers / rAF / raw transcendentals. |
| `test/` | `node --test` unit tests for every module. |

## Commands

Run from this directory:

```sh
node --test                              # unit tests
npm run lint:determinism                 # ban check on engine sources
node tools/golden.js --engine ./engine.js --ticks 10000   # deterministic trace digest
python3 -m http.server 8137              # then open /tools/preview.html to watch the sim
```

Browser-vs-Node parity gate: open `/tools/golden.html?ticks=10000` and confirm its
batch digest equals `node tools/golden.js --engine ./engine.js --ticks 10000`.

## Rules

- Engine code (everything outside `test/` and `tools/`) is a pure function of
  `(seed, actions)`: no `Math.random`, no wall clock, no timers/rAF, no raw `Math`
  transcendentals (route through `mathx.js`). The determinism lint enforces this.
- No DOM in the engine. Positions, facings, and modes are plain state; the
  presentation layer turns them into transforms/classes and interpolates between
  ticks.
- No dependencies. Node's built-in test runner only.

## Picking up at M4

M4 ports the **tier-2 stack** and **tier-3 cascade** — the two multi-panda set
pieces. The stack: `stackDirector` (a singleton `activeStack`, needs pool ≥3 and a
base with headroom), the mount walk-up + `throwArc` hop, the parade `tick` (base
strides with rider sway as a function of tick count, not `perf.now`), and `topple`
(drop the solid/anomaly flags → the 3-way knock next collision tick). The cascade:
the global BFS (`igniteCascade` → `fellNext` claiming victims into `cascadeLock`,
each `cascadeKnock` steered at its nearest neighbour), armed by `cascadeDirector`
and ignited externally by a natural armed collision, a topple, or the `forceIgnite`
backstop. New collision-role modes (STACK_BASE / RIDER, the `solid`/`riding`/
`flying` flags already stubbed in the entity) slot into the `mode` tag. Source
spec: `design/panda-engine-map.md` §5 (Stack + Cascade), §6 (`cascadeKnock`,
`throwArc`); original `../pandas.js` classes ~1367–1490 (Stack) and functions
~1514–1635 (Cascade). The 17-action seam + hat brain from M3 are unaffected.
