# pandas.js behavioral map — the design input for the fixed-tick rewrite

*Produced 2026-07-26 as the first work of Phase A ([panda-policy-net.md](panda-policy-net.md)). A complete, line-anchored map of the current `assets/pandas/pandas.js` (1857-line IIFE): every constant, every source of nondeterminism/time, every per-entity state field, and every FSM described as an explicit state machine. This is the reference the pure `step(state, actions) -> state` engine is built from — the point of capturing it is so the port can be validated against a written spec (plus golden traces + Ameya's eye) rather than by re-reading the closures each time.*

**Base tick is settled: 50 ms (20 Hz).** Both `STACK_TICK_MS` and the collision `setInterval` already run at 50 ms, and the header comment calls the collision cadence "20 Hz". So the engine's fixed tick = 50 ms, and every `*_MS` constant below converts by `msToTicks(ms) = max(1, round(ms/50))`. Feel drift from rounding is expected and gated on Ameya's preview.

Art/data blobs (skip when reading): `pandaSvg` decoder table L108–112; `HAT_PIXELS` L148; `SIT_CELS` L1340. *(2026-07-27: these four literals are now lifted verbatim into `assets/pandas/engine/render/art-data.js` by `tools/bake-art.js`, and a unit test fails if the two copies drift — `pandas.js` remains the authoring side, per the hat pipeline.)*

---

## 1. Constant inventory (the tick-conversion table)

### Core timing (ms → ticks at 50 ms)

| Name | Line | Value | Unit | Ticks | Used for |
|---|---|---|---|---|---|
| `FRAME_MS` | 119 | 140 | ms/cel | 3 | sprite cel advance (animate, fall/standUp/roll pacing) |
| `PAUSE_POLL` | 64 | 400 | ms | — | poll interval for `paused` (becomes an engine-external gate) |
| `MOVE_SPEEDS` | 131 | [850,900,950,1000,1100] | ms/stride | [17,18,19,20,22] | roamer wander cadence pool |
| `HAT_MOVE_MS` | 132 | 540 | ms/stride | 11 | hat panda calm stride |
| `HAT_ALERT_MS` | 133 | 380 | ms/stride | 8 | hat panda alert stride |
| `HAT_SPRINT_MS` | 134 | 300 | ms/stride | 6 | hat panda hat-retrieval dash |
| `HAT_ROLL_FRAME_MS` | 1184 | 58 | ms/cel | 1 | dive-roll cel rate (≈290 ms over 5 cels) |
| `HAT_ROLL_COOLDOWN` | 1185 | 2600 | ms | 52 | dive-roll reuse cooldown (perf.now → tick count) |
| `HAT_REFLEX_MS` | 1187 | 80 | ms | 2 | reflex poll rate |
| `STICKY_MS` | 1011 | 2500 | ms | 50 | incident-focus stickiness window |
| `AFTERMATH_LINGER` | 1013 | 2600 | ms | 52 | incident TTL tail past behaviour end |
| `DWELL_MIN/MAX` | 1046 | 8000/18000 | ms | 160/360 | ambient-subject hold time |
| `GAZE_MIN/MAX` | 1086 | 1800/4200 | ms | 36/84 | planted gaze-shift interval |
| `ANOM_GAP_MIN/MAX` | 1251 | 6000/11000 | ms | 120/220 | director tier-1 spawn window |
| `ANOM_KICK` | 1253 | 9000 | ms | 180 | delay before director first runs |
| `SLEEP_MIN/MAX` | 1255 | 8000/20000 | ms | 160/400 | sleeper nap duration |
| `SPIN_MS` | 1256 | 1200 | ms | 24 | spinner turn duration |
| `STAGGER_MS` | 1257 | 190 | ms | 4 | spinner stagger-step interval |
| `TRIP_TICK_MS` | 1259 | 60 | ms | 1 | tumbler skid tick |
| `TRIP_DOWN_MS` | 1261 | 900 | ms | 18 | tumbler ground time |
| `LOOP_STEP_MS` | 1264 | 420 | ms | 8 | loop stride cadence |
| `STARE_MIN/MAX` | 1265 | 6000/12000 | ms | 120/240 | starer hold |
| `ZOOM_STEP_MS` | 1266 | 60 | ms | 1 | zoomies tick |
| `ZOOM_MAX_MS` | 1267 | 8000 | ms | 160 | zoomies fuse (safety timeout) |
| `ZOOM_TUMBLE_MS` | 1268 | 700 | ms | 14 | zoomies crash ground time |
| `ZOOM_TTL` | 1269 | 3500 | ms | 70 | zoomies incident TTL |
| `MOON_STEP_MS` | 1272 | 460 | ms | 9 | moonwalk stride |
| `HICCUP_STRIDE_MS` | 1274 | 420 | ms | 8 | hiccup ordinary stride |
| `HICCUP_HOP_MS` | 1275 | 300 | ms | 6 | hiccup pop duration |
| `OBLIVIOUS_IDLE_MIN/MAX` | 1286 | 2200/5200 | ms | 44/104 | oblivious idle duration |
| `STACK_GAP_MIN/MAX` | 1322 | 60000/120000 | ms | 1200/2400 | stack recurrence window |
| `STACK_KICK` | 1323 | 35000 | ms | 700 | delay before first stack |
| `MOUNT_HOP_MS` | 1324 | 440 | ms | 9 | mount throwArc duration |
| `MOUNT_WALK_MS` | 1326 | 300 | ms | 6 | mounter walk-up stride |
| `STACK_INCIDENT_TTL` | 1328 | 60000 | ms | 1200 | tier-2 incident TTL |
| `PARADE_MIN/MAX` | 1329 | 18000/34000 | ms | 360/680 | stack parade lifetime before topple |
| `STACK_TICK_MS` | 1330 | 50 | ms | 1 | **stack tick rate = the base tick** |
| `SIT_WOBBLE_CYCLE` | 1344 | 1600 | ms | 32 | rider teeter period |
| `CASCADE_ARM_MIN/MAX` | 1524 | 120000/300000 | ms | 2400/6000 | cascade re-arm window |
| `CASCADE_KICK` | 1525 | 40000 | ms | 800 | first arming delay |
| `CASCADE_ARM_TIMEOUT` | 1526 | 40000 | ms | 800 | armed→forced-ignite backstop |
| `CASCADE_HOP_MIN/MAX` | 1528 | 150/230 | ms | 3/5 | inter-domino stagger |
| `CASCADE_DURATION` | 1530 | 14000 | ms | 280 | cascade machinery idle-out |
| `CASCADE_INCIDENT_TTL` | 1531 | 9000 | ms | 180 | tier-3 incident TTL |
| `SPIN_STEP_MS` | 1642 | 55 | ms | 1 | spin3d facing-flip rate |
| `LEAD_GAP` | 990 | 1800 | ms | 36 | hat panda's solo entrance lead |
| `WAVE_GAP` | 991 | 1050 | ms | 21 | gap between entrance waves |
| `HAT_CFG.pause` | 176–177 | 750 (drop) | ms | 15 | pause before hat pickup |
| collision poll | 1839 | 50 | ms | 1 | `setInterval(collisionCheck, 50)` |

### Distances / spatial (px — unchanged by the tick refactor)

`CELL`=100, `IMPACT`=80, `STEP`=50 (L119); `FOOT`=24,`GAP`=12 (L71); `CLEAR`=120 (L88); `HAT_W/H`=28/14 (L143); `AVOID_R`=85 (L1080); `AXIS_CROWD_W`=24000 px² (L1084); `INSPECT_NEAR`=140 (L1043); `AMBIENT_STANDOFF`=280 (L1044); `HAT_DANGER_R`=130 (L1181); `HAT_ROLL_R`=74 (L1182); `HAT_ROLL_DIST`=92 (L1183); `HAT_THREAT_LOOKAHEAD`=60 (L1186); `HAT_SIDESTEP_R`=108 (L1190); `HAT_PANIC_R`=50 (L1191); `HAT_STEP_CROWD_W`=40 (L1193); `TRIP_SLIDE`=46 (L1260); `ZOOM_INCR`=10 px/tick (L1266); `HICCUP_RISE`=18 (L1276); `OBLIVIOUS_R`=110 (L1282); `MOUNT_NEAR`=68 (L1325); `TOPPLE_HIT_R`=76 (L1332); `BASE_STEP`=3 px/tick (L1330); `CHAIN_RANGE`=350 (L1527); `RIDER_RISE`=62 (L1709); `TABLEAU_GAP`=118 (L1710); `OFF`=100 (L993); `TARGET_IN`=110 (L994); `SIT_TRAVEL_PX`=6 (L1343); boundary clamp lower −40 / upper 60 (L279).

### Dimensionless / probability / count

`OBLIVIOUS_IDLE_P`=0.45 (L1285); `BASE_TURN_P`=0.06 (L1331); `STANDOFF_SLACK`=1.7 (L1045); `AXIS_COS`=cos22.5° / `AMBIENT_AXIS_COS`=cos40° (L1047/1056, computed once); `CROWD_BUMP`=1.2 (L1085); `WEAVE_CROWD_W`=0.7 (L1081); `WEAVE_HOLD_BIAS`=0.12 (L1082); `WEAVE_STUCK`=5 (L1083); `HAT_CLOSING_MIN`=0.15 (L1188); `HAT_FAST_SPEED`=0.12 px/ms → **0.12·50 = 6 px/tick** (L1192); `WAVE_SIZE`=2 (L992); `LOOP_LAPS_MIN/MAX`=2/4 (L1263); `TRIP_TICKS`=4 (L1258); `MOON_STEPS_MIN/MAX`=8/16 (L1271); `HICCUP_MIN/MAX`=4/7 (L1273); `MOUNT_MAX_STEPS`=24 (L1327); `CASCADE_COVER_MIN/MAX`=0.70/0.90 (L1529); `MOBILE_MIN`=800 (L58); `PANDA_COUNT`=10 or 7 (L59/1785); `TURN_OPTIONS`=[1,1,−1,−1,0] (L135); `SIT_TILT_DEG`=6 (L1342).

> Speeds denominated in px/ms (`HAT_FAST_SPEED`, and `ZOOM_INCR`/`BASE_STEP` already px/tick) convert with `pxPerMsToPerTick(v)=v·50`. Everything spatial stays in px.

---

## 2. Nondeterminism & time sites (everything the lint bans)

- **`Math.random`** (via `rand()`/`pick()` L55–56, or direct): initial `turnIndex` (220); oblivious idle roll (317,319); gaze hold (470); anomaly kind + candidate pick (1305,1307); sleeper nap (759); spinner stagger count/dir (792,798); loop laps (813); starer hold (834); moonwalk heading/steps (872,874); hiccup count/wander (896,916–917); gaze-target roll (1111,1115–1116); ambient dwell (1148); director gap (1299); stack nRiders/base-dir/turn (1424,1432,1506); parade lifetime (1423); cascade hop stagger (1573) & coverage (1594); stack/cascade recurrence gaps (1498,1628); oblivious pick (1828); hat toss jitter (659–662).
- **`performance.now`** (no `Date.now` in file): dive-roll cooldown `_rollReadyAt` (525,556); zoomies deadline (856,860); incident `born`/`expires` (1017,1022,1133); stack `born`/age (1422,1430,1467); rider sway phase (1446). → all become **tick counts**.
- **`requestAnimationFrame`**: hat-toss kick (672); `throwArc` frame loop (1694,1696); resize debounce (1852); spawn layout-wait (1776). → renderer / host layer.
- **`setTimeout`**: the universal step primitive `Panda.after()` (243) and every self-rescheduling loop/director. → replaced by per-tick advancement.
- **`setInterval`**: one only — `collisionCheck` @50 ms (1839).
- **`matchMedia`** reduced-motion (54): host input, but currently branches core scheduling (tableau vs live entrance) — becomes an engine mode flag.
- **`getBoundingClientRect`**: `computeForbid` (76) and `collisionCheck` per hit-corner (939,950). → **replace with model-space geometry**; the fence rect + stage size become engine inputs.
- **Transcendentals**: `Math.hypot` (91,101,403,502,1233,1395,1671,1726 — distances); `Math.cos` (1047,1056 — once); `Math.sin` (1446 — **per-tick rider sway, perf.now-driven → make it a function of tick count**). No `atan2`/`pow`/`exp` anywhere. All route through `mathx.js`.

---

## 3. Panda instance state fields (per-entity shape)

Constructor (200–242) unless noted. DOM refs (`el`,`inner`,`sprite`,`corners`) move to presentation.

`x,y` (px, canonical); `frame` (cel idx); `animation` (walk/stop/idle/fall/fallen/standUp/roll); `turnIndex` (0–7 facing); `direction` (DIRS member); `defaultFallDirection`; `moveSpeed` (stride ticks, fixed at construction); `hit` (false|dir); `knocked`; `hasHat`; `hatLost/hatRest/retrieving`; `observer` (=hasHat); `subject` (Panda|null, watched target); `anomaly` (string|null — the ownership token); `oblivious`; `home` ([x,y]|null); `solid` (unstoppable/unknockable base); `flying` (mid-arc ghost); `riding` (stack rider ghost); `moveQueued`; `entering` (walk-in ghost); `rolling` (mid dive-roll, lazy); `_rollReadyAt` (cooldown expiry → tick); `_reflex` (reflex-started flag); `relocating`; `ambientTicks`; `vAxis` (0–7 vantage axis); `td` (standoff px); `_incident/_incidentSince`; `_stuck/_revantaged/_stuckPrev` (hold→re-vantage→abandon accounting); `gazeTicks/gazeTarget`; `_sit/_sitKey` (rider seat cache, presentation).

> The `_`-prefixed fields are lazily first-written outside the constructor — a smell. The rewrite declares one explicit shape per entity type (roamer / hat-panda / stack-rider) up front. The mutual-exclusion flags (`anomaly`,`solid`,`riding`,`flying`,`entering`) collapse into a single `mode` tag.

---

## 4. The director(s) — three self-rescheduling global schedulers

**tier-1 `director()` (1298–1309):** global `lastAnomaly` (prevents same kind twice-running). Candidate filter `anomalyCandidates` (1294): ordinary roamer, on feet, not busy, not hat, not oblivious, not solid/flying/riding. Picks a kind from the 8 `ANOMALIES` (L1288) excluding `lastAnomaly`, picks a candidate, invokes `pool[kind]()`. Reschedules in `ANOM_GAP` (6–11 s).

**tier-2 `stackDirector()` (1497–1512):** singleton `activeStack` (at most one alive). Needs pool ≥3 and a candidate with headroom `y ≥ 2·RIDER_RISE+20`. `nRiders` = 2 (45%) or 1 (55%) — L1506 is `random() < 0.45 ? 2 : 1`, so a 3-high tower is the *less* likely of the two; nearest pool members become mounters; `new Stack(base, mounters)`. Reschedules in `STACK_GAP` (60–120 s).

**tier-3 `cascadeDirector()` (1627–1635):** global `cascadeArmed`, `cascadeActive`, `cascadeLock` (Set of claimed victims), `cascadeFelled`/`cascadeTargetFell`. Arms (sets `cascadeArmed`) and schedules `forceIgnite` backstop at 40 s. Reschedules in 2–5 min. **Ignition is external** — fired by `collisionCheck` (985) on a natural armed collision, `Stack.topple` (1488) coupling, or `forceIgnite` (1615).

**Incident queue (Phase-2 attention, 1005–1152):** `incidents[]` of `{subject,tier,born,expires}`. `emitIncident` (1016) posted by every anomaly/stack/cascade. `liveIncidents()` (1021) lazily prunes expired. `topIncident(self)` (1030): highest tier, ties by nearest distance then recency. `pickWatchTarget(self)` (1132) is the seam — held incident persists `STICKY_MS` unless a higher tier preempts; empty queue → ambient `pickSubject()` held a `DWELL`-derived count. Already tick-count-friendly once `perf.now`→ticks.

---

## 5. Anomaly FSMs (8 tier-1 kinds)

Common entry `beginAnomaly(tag, ttl)` (728): sets `anomaly=tag`, drops queued move, posts a tier-1 incident, returns `owns() = () => this.anomaly===tag`; every tick checks `owns()` first — a real `knock()`/`cascadeKnock()` clears `anomaly` and silently kills the sequence. Common exit `endAnomaly()` (734): clears `anomaly/knocked/hit`, resumes walk. (In the fixed-tick engine `owns()` becomes a `mode`-equality check.)

1. **sleeper** (756): `[nap]`. `lieDown(nap)` → knocked; fall (6 cels) → fallen → (nap `SLEEP_MIN..MAX`) → standUp (6 cels) → end.
2. **tumbler** (764): `skid(0..3)` every `TRIP_TICK_MS`, flip facing +1, slide `TRIP_SLIDE/4` px/tick → `lieDown(TRIP_DOWN_MS)`.
3. **spinner** (786): `spin3d(SPIN_MS)` (cycle facings every 55 ms, frozen stance) → `stagger(2–3)` random-dir strides every `STAGGER_MS` → end.
4. **loop** (808): `step(0..strides−1)`, `strides=laps·8`, `laps` 2–4; `turnIndex+1` + one cell each `LOOP_STEP_MS`; 8 unit vectors sum to zero → closed octagons.
5. **starer** (831): compute nearest-edge dir once, `idle`, single timeout `STARE_MIN..MAX` → end. No intermediate ticks.
6. **zoomies** (844): `dash()` every `ZOOM_STEP_MS`, step `ZOOM_INCR`=10 px along locked heading. Ends via (a) `ZOOM_MAX_MS` fuse, (b) wall/fence hit (no movement) → `lieDown(ZOOM_TUMBLE_MS)`, or (c) external knock into another panda (feeds the collision economy).
7. **moonwalk** (868): `step(0..steps−1)`, `steps` 8–16; travel a random heading each `MOON_STEP_MS` while facing opposite (`(travel+4)%8`, fixed); ends after steps or early on wall.
8. **hiccup** (892): `cycle(0..hops−1)`, `hops` 4–7; each cycle = two ordinary strides (`HICCUP_STRIDE_MS`, 35% chance re-facing) then a `throwArc` pop (`HICCUP_HOP_MS`, rise 18, lands in place).

**tier-2 Stack (class 1367–1490):** `mount(i)` (per-mounter walk-then-`throwArc` hop) → `parade()` → `tick()` every 50 ms (base steps `BASE_STEP`=3 px, `BASE_TURN_P`=6%/tick turn; each rider's `sin` sway accumulates upward) → `topple()` (drop solid/anomaly flags, riders collapse onto base coincident, next collision tick does the 3-way knock). Topple on `age ≥ life` (`PARADE_MIN..MAX`) or `struck()` (zoomies within `TOPPLE_HIT_R`=76). Topple also ignites cascade if armed.

**tier-3 Cascade (functions 1514–1635):** global BFS, not per-panda. `igniteCascade(seeds)` seeds fronts (collision parties or stack base), computes `cascadeTargetFell` (70–90% of universe), then `fellNext(fromP)` recurses: nearest standing neighbour within `CHAIN_RANGE`=350 not in `cascadeLock` → claim → after `CASCADE_HOP` stagger, `cascadeKnock` steered toward *its* nearest neighbour → recurse. Front dies at no-neighbour or target reached. Whole machine self-resets after `CASCADE_DURATION`=14 s.

---

## 6. Collision & knock

**Detection** `collisionCheck()` (934–987) every 50 ms: pairwise `getBoundingClientRect` overlap (`|a−b|<20`) on hit-corners. Ghost exclusions: `entering`,`flying`,`riding`. `solid`+`solid` never collide; a `solid` knocks non-solids without being knocked (the base asymmetry). **→ replace with model-space AABB/circle test on `x,y`+body dims; the 20 px tolerance + corner hitboxes reproduce exactly in model space.**

**knock()** (589): `anomaly=null` (real knock outranks all), `knocked`, `.stop` class, `fall`, `slide()` (knockback `IMPACT`=80 px over the fall's cels), drops hat if worn. Timeline: fall 6 cels → `fallen`; +`1000·(rand(4)+1)` ms lie → `standUp`; +6 cels → recover (resume retrieveHat / walk).

**cascadeKnock(vx,vy,faceDir)** (614): same shape, slide vector is the steered gap to the next domino; clears `cascadeLock` on recover.

**throwArc** (1670): parabolic rAF flight, `peak=min(150,45+dist·0.3)`, tumbles 16 facings, `flying=true`; `setTimeout` fallback finish if rAF starved.

**spin3d** (1649): cycle 8 facings every 55 ms, frozen stance, `alive()` lets a knock abort.

**dive-roll `dodgeRoll`** (523): `roll` anim, travel `HAT_ROLL_DIST`=92 px over the roll's cels @58 ms. Sets `_rollReadyAt = now + 2600` at roll **start**. **Currently NO i-frames** — Phase A adds them (agreed 2026-07-24: committed escape).

---

## 7. Hat panda — the 17-action seam

**observe()** (374–486), rescheduled each tick at `HAT_ALERT_MS` (mid-roll yield) or `alert ? HAT_ALERT_MS : moveSpeed`. Per tick: `pickWatchTarget` selects subject+standoff; no subject → wander; else compute `dist`, `losBlocked` (`crossesFence`), `angleOff` (bearing vs nearest of 8 `AXES`, tolerance `AXIS_COS`/`AMBIENT_AXIS_COS`). Not relocating → relocate if `dist>far` or `losBlocked` or `angleOff`. **Relocating:** `stepWeaving(tx,ty)`; `_stuck`/`_stuckPrev` accounting — reached/settled clears; progress resets; `WEAVE_STUCK`=5 stuck ticks → first re-vantage (`bestAxis` avoiding current), second → abandon (`subject=null`). Never phases through. **Planted:** sidestep tier first (`threatsTo(HAT_SIDESTEP_R)` → `bestEscape` → calm one-cell step); else idle+gaze: crowd check (`crowdAt>CROWD_BUMP` → relocate), gaze-target refresh every `GAZE_MIN..MAX` via `pickGaze` (55% subject / 25% bystander / 20% random point), face gaze.

**hatReflex()** (552) separate poll @80 ms, started once. Skips if paused/knocked/retrieving/rolling/entering or on cooldown. `near = threatsTo(HAT_DANGER_R)`; triggers `dodgeRoll(bestEscape(...))` if `fast` (any threat ≥`HAT_FAST_SPEED`), `crowd` (≥2 within `HAT_ROLL_R`), or `panic` (≥1 within `HAT_PANIC_R`).

**Helpers:** `threatsTo(self,R)` (1206) moving pandas within R closing on self (dot ≥`HAT_CLOSING_MIN`), excl. entering/flying/observer. `bestEscape(self,threats,dist,avoidCrowd)` (1224) scores 8 landing cells by min-dist to threats' projected positions (`HAT_THREAT_LOOKAHEAD`=60), optional crowd penalty. `bestAxis(subject,p,td,avoid)` (1158) least-crowded/nearest/LOS-clear standoff axis, 3-tier fallback. `crowdAt(x,y,self)` (1089) Σ(1−dist/AVOID_R). `stepWeaving` (499) routes the fence via `detourCorner`, scores 8 cells by progress−`WEAVE_CROWD_W`·crowd, hold penalised by `WEAVE_HOLD_BIAS`, returns −1 (hold) if all steps off-stage/into-card.

> The 17-way interface maps here: hold / step×8 / dive-roll×8. `wanderStep`+`stepWeaving` = the step actions; `dodgeRoll`+sidestep = evasive actions; `pickWatchTarget`+gaze = attention (stays hand-authored / not in the action space per the spec — the policy owns *where to be*).

---

## 8. Entrance & reduced-motion tableau

**Entrance** `spawn()` (1774) + `walkIn` (342): `PANDA_COUNT` from viewport (1785); hat panda first via `enterOne(true)` with `LEAD_GAP`=1800 ms head start; then waves of `WAVE_SIZE`=2 every `WAVE_GAP`=1050 ms. `pickEntry()` (1801) random edge, `OFF`=100 off-stage, `TARGET_IN`=110 in, fence-avoid retry ≤40. `walkIn` straight strides (unclamped `setPos`) → hands off to observe/moveAbout within one `STEP`.

**Entrance: ported 2026-07-27 (M6)** as `MODE.ENTERING` behind `cfg.entrance` (default on = today's live behaviour). Waves become per-entity countdowns drawn at spawn (`aTimer`), the walk-in is one stride per `moveSpeed` ticks toward a target carried in `home` (which then doubles as the oblivious one's patch, exactly as here), and arrival hands off to WANDER — or, for the hat, straight into OBSERVING. It stays a config flag rather than a host-side script because training corpora need both: most episodes opening mid-scene, some on the walk-in.

**Reduced-motion tableau** `tableau(place)` (1713): no scheduling — one static composition: a fallen panda (`clearSpot`, frozen `fallen`), hat panda planted at `INSPECT_NEAR` facing it, a static 3-high stack (manual z-order), rest standing (`stop`) at `clearSpot`s ≥`TABLEAU_GAP`=118 apart (60-try farthest-point).

---

## 9. Pause system

`paused = document.hidden || !onScreen` (66), from `visibilitychange` (1847) + stage `IntersectionObserver` (1846). Every recursive tick-closure checks `if (paused) { after(PAUSE_POLL, resume); return; }` — a manual re-poll, not a global gate. State lives in closures/fields, so resume continues a half-finished sequence exactly. `collisionCheck` just early-returns when paused. **In the engine:** pause is a host concern — the host simply stops calling `step()`; state is already a plain snapshot, so resume is free.

---

## 10. DOM / presentation touchpoints (the cut line)

*Ported 2026-07-27 (M5) into `assets/pandas/engine/render/` — `renderer.js` for the first three bullets, `host.js` for the events/bounds/`matchMedia` inputs, `art.js` for the DOM/SVG construction, `collision.js`+`geometry.js` (already) for the two rect reads. The one change of substance: the wrapper's `transition: transform 2s` is gone, because the engine now owns the glide and the renderer interpolates between ticks — which also demotes `.stop` from a physics-mode toggle to a bare CSS hook.*

Everything here moves to the presentation layer:

- **Position→transform** `applyTransform()` (274): the sole place `x,y` reach the DOM (`translate`+`zIndex` from `y`).
- **Facing/anim→classes & sprite offset** `setFacing` (245), `drawFrame`/`freezeFrame` (252–264, cel selection from `ANIM`/`ROW`).
- **State→CSS classes**: `.stop` (**kills the CSS glide — a physics-mode toggle the engine relies on**, not just cosmetic: `slide`, `cascadeSlide`, tumbler skid, zoomies, stack tick, throwArc all assume it), `.observing`, `.hatless`, `.riding`, `.flying`.
- **DOM creation**: constructor `innerHTML` (204), `refreshSprite` (248), loose-hat el (666), rider seat (1400), `renderRider` (1359).
- **Collision geometry**: `getBoundingClientRect` reads (939,950) → model-space.
- **Fence geometry**: `computeForbid` reads `.hero-inner`+stage rects (73) → engine input.
- **Stage bounds**: `stage.clientWidth/Height` (281,664,837,1000,1775) → explicit width/height state.
- **Events**: click→tap (237), IntersectionObserver (1846), visibilitychange (1847), resize (1850) → host, feeding paused/fence/viewport into the engine.
- **`matchMedia`** (54) → host input; its scheduling branch becomes an engine mode flag.

---

## Cross-cutting notes for the rewrite

- **`mode` tag** replaces the loose `anomaly`/`solid`/`riding`/`flying`/`entering` flags — the mutual-exclusion semantics a state machine needs are already there implicitly.
- **`owns()` closures** → simple `entity.mode === tag` checks; no closures.
- **Variable-interval `setTimeout` self-scheduling** is the main obstacle: every duration converts to a tick countdown field on the entity/FSM.
- **The incident queue + tier ranking** ports almost verbatim (declarative already).
- **Globals** `cascadeLock`, `activeStack`, `cascadeArmed/Active`, `lastAnomaly`, `incidents[]` become top-level fields of `state`.
- **Collision** must become a pure model-space test; **rider sway** and any per-tick `sin` become functions of tick count, not `perf.now`.
