# panda trainer

Rollout harness, corpus tooling and the viewing game for the learned line-walker —
**Phases B and C** of [design/panda-policy-net.md](../design/panda-policy-net.md).

No site impact: nothing here is ever loaded by a page. It imports the shipped
engine from [`../assets/pandas/engine`](../assets/pandas/engine/README.md)
**directly, never a copy**, so a corpus is always a recording of the machine the
visitor is looking at — and the engine's browser-vs-Node parity gate extends to
every trajectory in it.

Zero dependencies, `node --test`.

## Status (2026-07-27)

| Milestone | State |
|---|---|
| **B1 — rollout harness + corpus specs + throughput bench** | ✅ done |
| **B2 — observation encoder (heading-cone FOV, sticky slots, frozen + bit-matched)** | ✅ done — in the engine, see below |
| **B3 — per-tick ground-truth logging (FSM kind/phase/timers, cascade arm, claims)** | ✅ done |
| **B4 — shard writer + manifest + JSONL sample** | ✅ done |
| **B5 — worker_threads fan-out** | ⬜ (see throughput below — it was never needed for the cut) |
| **B6 — cut the corpora, freeze the roster** | ✅ done |
| **C1 — the game: scoring rules, the policy seam, the evaluator** | ✅ done |
| **C2 — the oracle, the memoryless twins, the exploit bots** | ✅ done |
| **C3 — the twin-episode battery, one set per knowability tier** | ✅ done |
| **C4 — close the action-space holes, price commitment, re-run the gate** | ✅ done |

**Phase B's exit is met.** The corpora are cut, the roster is frozen (and the freeze
is a test — see below), the encoder's fixture check is green, and rollouts clear the
≥50k ticks/s/core bar. B5 is the one milestone left open, and it is a Phase-E want,
not a Phase-B need.

| corpus | spec | episodes × ticks | rows | on disk | cut in |
|---|---|---|---|---|---|
| **`train-wild`** | `wild` | 840 × 12000 | 5.04M (10.08M ticks) | 15.20 GB | 205 s (49k ticks/s) |
| **`eval-natural`** | `natural` | 120 × 12000 | 720k (1.44M ticks) | 1.72 GB | 11 s (126k ticks/s) |

Both carry ground truth. The training corpus spans **6 to 28 pandas** per episode
(23 distinct row widths — which is exactly why the unit of a file is one episode),
uses all 17 actions, and is finite in every cell. Loading it from the manifest alone
in NumPy was checked end to end, including that entity sub-row *k* is panda *k*.

The engine change owed before the cut — the `.stop` hit box, the last known
divergence from `pandas.js` — landed first, so the sim underneath is settled. It
moved the golden digests (`d4a2d47b` @ 32×10k, `bfbc8a5c` @ 60k) and the observation
fixture; every corpus here is cut against that engine and says so in its manifest.

**Throughput, with the whole pipeline in the loop** (`npm run bench`):

| spec | mean pandas | ticks/s | + encoder | + ground truth | + shard | faster than real time |
|---|---|---|---|---|---|---|
| natural | 6.3 | 450k | 453k | 222k | 151k | 7600× |
| dense | 13.8 | 116k | 114k | 56k | **44k** | 2200× |
| wild | 12.9 | 125k | 122k | 60k | **42k** | 2100× |

Read the columns as an escalation: the sim alone, then the observation encoder
(about 4% — inside run-to-run noise), then full recording, which costs **~2×**
because ground truth walks each episode twice (see below), then B4's shard writer,
which is what `cut.js` actually runs. Cost is otherwise dominated by collision
detection, O(n²) in the panda count (16 corner pairs per body pair, every tick).

**Rollouts clear the phase's ≥50k ticks/s/core bar with room — 116k on the binding
spec — but the end-to-end cut lands at 42–44k, about 16% under it.** Most of that
last step is not computation: a labelled `wild` episode is ~18 MB, and writing plus
digesting the bytes is roughly two thirds of the gap (measured: hashing 122 MB costs
0.12 s). It changes nothing operationally — a 10M-tick corpus is **~4 core-minutes**
— but the number is recorded as a miss rather than rounded into a pass. The real B6
cut then ran at **49k ticks/s** end to end, a little above the bench and a hair under
the bar: the bench's `wild` draws are its own, and the corpus mixes cheap thin
episodes with 28-panda ones.

B5's worker pool is therefore still not on the critical path for the cut. It is on
it for Phase E's on-policy rollouts, where the step count is billions rather than
millions, and one shard per episode makes it embarrassingly parallel when it comes:
no shared file, no ordering, nothing to merge.

`cut.js --dry-run` prices a cut before it writes a byte, from exact panda counts
(read from `init`, not estimated) — it called B6's 15.20 GB and 1.72 GB to the
megabyte. A `--no-truth` training cut would have been 6.7 GB; labels were kept,
because a corpus missing labels it could have had is the expensive mistake.

## The pieces

| File | Role |
|---|---|
| `rollout.js` | One episode of the engine, headless, into a sink. `runEpisode({seed, config, sink, policy, ticks, stride, warmup})`. |
| `truth.js` | Per-tick ground truth (B3) + `recordEpisode`, which emits aligned `{tick, action, obs, truth}` rows. |
| `corpus.js` | The three corpus specs (`natural` / `dense` / `wild`) as pure functions of a PRNG, plus deterministic episode seeding. |
| `shard.js` | The shard format (B4): the row layout, the streaming writer, and the reader that decodes it back. |
| `cut.js` | Episodes → shards + manifest + JSONL sample. Also the CLI (`--dry-run`, `--verify`) and `checkContract`, the freeze (B6). |
| `bench.js` | Throughput per spec against the exit bar. |
| `game.js` | **The viewing game (C1)**: the scoring rules, and the sink that keeps the ledger. |
| `percept.js` | **The three information sets (C2)**: what each yardstick is allowed to believe, and the oracle's time-remaining estimator. |
| `planner.js` | **The yardstick body (C2)**: one score-maximising bot, run over each of those beliefs. |
| `policies.js` | Everything the game is scored against: the incumbent, the floors, the yardsticks, the exploit bots. |
| `evaluate.js` | Runs a policy over a set of episodes and reports the distribution. Also the CLI and the gate (`--gate`). |
| `scenario.js` | **Constructed episodes (C3)**: a bare stage, a hand-placed roster, the directors asleep, and a script that injects one event at one tick. |
| `twins.js` | **The twin-episode battery (C3)**: three matched-pair sets, one per knowability tier, and exit check 3. |
| `test/freeze.test.js` | Runs `checkContract` over every committed manifest — the roster freeze, enforced. |
| `corpora/` | Cut corpora. Gitignored except manifests and the JSONL sample — a corpus is re-cuttable from its manifest, so the bytes need not be in git. |

## The observation encoder is in the engine, not here

B2 ships as [`assets/pandas/engine/policy/obs.js`](../assets/pandas/engine/policy/obs.js)
— read that module's header and the engine README for what it sees and why. It is
there rather than here for the same reason the engine is imported rather than
vendored: **Phase D ships it in the browser.** The page's policy has to encode its
own observations frame by frame, so trainer and site must run one implementation,
under the determinism lint, with a fixture (`policy/obs-fixture.json`) that another
language can be held to.

Plugging it into a rollout is three lines, and the pattern the shard writer will
use — one observer and one slot memory per episode, advanced once per sample:

```js
import { makeObserver } from '../assets/pandas/engine/policy/obs.js';

const obs = makeObserver();
const mem = obs.init();
runEpisode({ seed, config, ticks, sink: { sample: (state) => write(obs.observe(state, mem)) } });
```

Two things to know about that memory. It only advances **when you call `observe`**,
so a `warmup` window leaves the slot table cold at the start of recording (correct:
a policy joining mid-episode is cold too, and `warmup` defaults to 0). And the frame
handed back is a **reused buffer** — copy it if you keep it, or pass your own with
`obs.observe(state, mem, out)`.

## Ground truth, and why it takes two passes (B3)

`truth.js` records everything the encoder refused: every anomaly's kind, sub-phase
and timers, the knock FSM, the director's clock, the stack machine, the cascade's
arming flag and its claims, the true positions and hidden gaits — and the rules
expert's own attention, which is a *label*, never an input. Nothing here ever
reaches a policy. (It is also the Phase-C oracle's input: the privileged upper
bound reads exactly this.)

**Kind and phase are readable off one tick; time-remaining is not** — and that is
the tier the whole anticipation economy rests on ("will the nap outlast my walk?").
Deriving it from the FSM constants would mean re-implementing `anomalies.js` in a
second place and still getting it wrong, because a zoomies ends early when it finds
a wall and a spinner draws its stagger count only when the spin ends. So truth is
built in two passes over the same episode, which determinism makes free:

1. `scanEpisode` walks every tick and keeps only where each panda's behaviour
   changed — a timeline of spans, a few hundred numbers per episode.
2. `recordEpisode` re-runs the episode and emits a row per recorded tick, looking
   `age` / `ttl` / `nextMode` up in that timeline.

Exact by construction, no duplicated arithmetic. Pass two re-checks each panda's
mode against the span it lands in, so a timeline built from a different seed or
config throws instead of quietly poisoning every label.

```js
recordEpisode({ seed, config, ticks, observer: makeObserver(), onRow });
// row = { tick, action, obs, truth: { global, entities, slots } }
```

`truth.slots` is what "aligned for future activation capture" means: it records
which panda each observation token addressed, so a Phase-G probe can score "token 3
believes X" against "panda 7 is X" instead of guessing the join. `GLOBAL_FIELDS`
and `ENTITY_FIELDS` are the record schemas in column order — B4 writes them into
the manifest, and a test asserts the records carry exactly those keys, so the
manifest cannot drift from the data.

Two labels are deliberately *unlearnable* and kept as negative controls:
`cascadeIgnitesIn` (arming has no observable signature at all — a probe that finds
it has found leakage) and a wanderer's `ttl`, which is the tick the director will
reach in and pick it.

## Two invariants worth not re-deriving

**The action is read, never re-derived.** `step(state)` with no action lets the
built-in rules expert drive, and writes what it actually applied to `hat.action`.
That value *is* the behaviour-cloning target. Calling `rulesAction` yourself to
ask "what would the expert do?" is wrong twice: it **mutates** the watcher's brain
(it is the expert, not a dry run), and its answer need not match what the engine
applied — on a non-decision tick, or mid-roll, the engine ignores it entirely.

**Recording runs on the policy's clock, not the engine's.** The hat panda decides
at 10 Hz and the engine ticks at 20 Hz, so `stride` defaults to
`TICKS_PER_ACTION`. Per-tick ground truth can override it, at double the disk.

## The shard format, and why the manifest is the corpus (B4)

A shard is a **rectangle**: `rows × width` little-endian float32, no header, no
padding, no framing. The whole loader is one line —

```py
rows = np.fromfile('ep-0000.bin', '<f4').reshape(-1, width)   # width from the manifest
```

— and that is worth a constraint: the row width must be constant, and it is not
constant across a corpus, because the panda count is a per-episode draw (`corpus.js`
varies density on purpose). So **the unit of a file is one episode**. That is the
natural grain anyway: an episode is already the unit of determinism, so it is the
unit that can be re-cut alone, verified alone, and — in B5 — written by its own
worker with nothing to coordinate.

A row is a fixed sequence of blocks, in this order:

| block | sub-rows × width | what it is |
|---|---|---|
| `obs` | `(1 + slots) × 37` | the encoder's frame, verbatim: token 0 is him, 1..8 the slots |
| `action` | `1 × 1` | the 17-way action the engine applied — the BC target |
| `global` | `1 × 22` | `GLOBAL_FIELDS`, in column order |
| `slots` | `slots × 4` | `SLOT_FIELDS` — the observation↔truth join |
| `entities` | `pandaCount × 32` | `ENTITY_FIELDS`; **sub-row k is panda id k** |

Everything is float32, including the labels, because two dtypes would mean two
reads and an alignment rule. Integer labels are exact below 2²⁴ and `cut.js` asserts
that per episode rather than trusting it — on the first row *and the last*, since
`tick` and everything derived from it only grow, so checking the first alone would
be checking the safest row in the episode (`totals.peakIntLabel` reports the
headroom actually used). True positions are the one lossy field — doubles into
float32, ~1e-4 px at stage scale, far under the pixel the sim moves in, and exactly
recoverable by re-running the episode.

**The shards are gitignored and the manifest is not**, which is a claim rather than
a convention: *a corpus is re-cuttable from its manifest*. An episode is a pure
function of (seed, config); the seeds come from one root; the configs come from a
named spec and that same root. So the manifest holds every input, and the bytes are
a cache of them. For that to hold, nothing in a manifest may be a clock or an
outside path — cut the same corpus twice and the two files are byte-identical, which
is what makes it a contract instead of a log. `--verify` executes the claim:

```sh
node cut.js --verify corpora/eval-natural.manifest.json --episode 3
```

It re-cuts that one episode and compares seed, rows, width, bytes and digest. It
also compares a short **golden digest of the engine** recorded at cut time, so a
corpus cut before a sim change announces itself instead of quietly mixing with one
cut after.

The manifest also carries what bytes cannot say for themselves: the row template,
the observation layout and the sensor's parameters, the ground-truth schemas in
column order, the label vocabularies, and the action names.

`<name>.sample.jsonl` is committed beside it — a dozen rows spread across the first
episode, with every field named. It is decoded back **out of the shard's bytes**
rather than re-rendered from memory, and a test pins that, so what it shows is what
the file holds. A format nobody can look at is a format nobody checks.

Three manifests are in the repo: `train-wild` and `eval-natural` (the B6 corpora) and
[`corpora/format-demo.manifest.json`](corpora/format-demo.manifest.json), a 2 × 12000
`natural` cut kept because it is small enough to read in one sitting. Their 17 GB of
shards are not in git; the commands at the bottom of this file put them back.

## The freeze, and what it is a freeze *of* (B6)

Phase B exits with the roster locked (change #5 of the plan). What that means
concretely: once corpora are cut, the 8 anomaly kinds, the mode vocabulary, the
observation layout, the 17-way action space and every ground-truth column are **what
the bytes mean**. Editing one of them does not corrupt a shard — it silently
re-labels one, and every number downstream stays plausible. That is the failure this
phase has to make impossible, so the freeze is a test, not a paragraph:

```sh
node --test test/freeze.test.js
```

`cut.js`'s `checkContract(manifest)` compares every committed manifest against the
code as it stands — shard version, engine digest, encoder digest, action names,
observation layout, truth schemas and label vocabularies — and `test/freeze.test.js`
runs it over `corpora/*.manifest.json`. It reads **no shards**, which is what lets it
live in the ordinary unit suite while the bytes stay gitignored. Change the roster
and the suite goes red naming the field that moved; the corpus then has to be re-cut
and anything trained on it retrained. `cut.js --verify` prints the same list before
it re-cuts an episode.

One field in the manifest exists purely for this: **`encoder`**, a digest of
`policy/obs-fixture.json`. The engine's golden digest cannot cover the sensor —
`policy/obs.js` never touches the sim, so an encoder change moves no golden digest
while changing what every `obs` column means. The fixture is the encoder's own
contract (regenerated from it, enforced by an engine test), so hashing that file
pins the sensor to the corpus.

`observation.params` is deliberately *not* frozen: the cone angle and peripheral
radius are per-corpus config Phase C tunes, and each manifest records what its own
cut used.

## The viewing game (C1)

`game.js` is the only file in the project that says what *good* means. The live
site never computes score and never will — the hat panda's job on the homepage is
to look like he is watching; score is the trainer's opinion about whether he was.

```
+ viewPay per tick, per live incident, while he stands within viewRadius of it
- knockPenalty each time he is floored
- a small cost per stride, a larger one per dive-roll
```

Everything else in `DEFAULT_RULES` exists to move money out of *reaction* and into
*inference*, because a score a reactive policy can reach proves nothing:

| knob | default | what it buys |
|---|---|---|
| `viewRadius` | 180 | Comfortably outside the expert's own study standoff (`inspectNear` = 140) — the reward must not fight the character. At 130 his shipped vantage stops paying and income halves. |
| `anticipationTau` | 200 | The arrival multiplier is `tau / (tau + incident age on arrival)`, **fixed at arrival for the whole incident**. 200 ticks ≈ one stage crossing, so showing up "a crossing late" halves the rate. The wager moves onto time-remaining. |
| `diminishHalf` | 100 | Rate halves after 5 s banked on one incident. Total pay grows logarithmically, so camping is worthless *structurally* rather than penalised after the fact — and principle #3 of [panda-chaos.md](../design/panda-chaos.md) (watch a while, then move on) becomes arithmetic. |
| `incidentCap` | 280 | The hard ceiling on top. Raised from 120 by C4 to leave room for `arrivalPay` plus some view income on one incident. |
| `dwellMin` | 120 | **C4.** An incident pays *nothing* until it has been attended for 120 unbroken ticks; the pay accrues into escrow and is released whole on completion. Walking away — or the incident ending first — forfeits the lot. 6 s is a coin flip against the measured duration distribution (p10 20 / median 115 / p90 334), so a clockless arm's flat prior is wrong about half the time it matters. |
| `dwellGrace` | 20 | How long a lapse a visit survives. Not a softener: with strict contiguity the *oracle* failed 24.7 of 33 commitments, because subjects move and one tick of drift outside the radius reset the run. That scored tracking, not prediction. |
| `arrivalPay` | 120 | **C4.** A lump sum on completion, scaled by the arrival multiplier — "pay on arrival rather than per tick" as a knob. Not optional at `dwellMin` 120: a dwell only ever removes income, and without the bounty the shipped expert falls to −26.7/min and below `still`, which is C1's own disqualifying condition. With it the expert lands on 32.3, within noise of the 30.4 it scored under C1. |
| `stepCost` | 0.5 | A stage crossing ≈ 24 strides ≈ 12 points, about a quarter of what one incident is typically worth. Enough that a trip is a wager, not a free option. |
| `payAll` | true | Pay every incident in range, leaving the `R_VIEW`-intersection parking exploit open on purpose for C2's bots. Measured: turning it off costs the expert **4%** of income on `natural` and 3% on `dense` — at this radius incidents rarely overlap, so the exploit is small before anyone tries to work it. |

Two decisions that look small and are not:

- **Ordinary knocks pay nothing.** Only the three directors post incidents; a panda
  felled by a collision is just a panda on the ground. That is the keystone of the
  flagship twin-episode certificate — a sleeper and a freshly knocked panda encode
  to *identical bytes* (pinned by a test in the engine's obs suite), one is worth
  points and the other nothing, and only event memory separates them. If knocks
  paid, that certificate would be worthless.
- **`inc.abandoned` is ignored**, though `watcher.js`'s own `isLive` honours it. It
  is the rules expert's bookkeeping and is never set at all when a policy drives
  (the expert does not run). Scoring through it would have two policies playing two
  different games.

Pay also stops when the *behaviour* stops, not when the incident expires: an
incident outlives its anomaly by `aftermathLinger` so the watcher can arrive and
find the aftermath, and arriving at the aftermath is worth nothing.

### The policy seam

`runEpisode({ policy })` consults a policy once per decision tick and feeds its
action to `step(state, action)`. A policy is `(state, tick) -> action | null`, or
`{ init(ctx) -> that }` for anything holding per-episode scratch — the same shape
`makeObserver` and `makeEngine` use. Returning null (or a NaN / out-of-range value)
hands the tick back to the rules expert, which is both how `expert` is implemented
and the engine's own bad-logit fallback. Leaving `policy` unset is byte-identical
to before it existed: `cut.js --verify` re-cuts a committed shard to the same
digest.

⚠️ **One tick of alignment is unresolved, deliberately.** A policy sees the state
it acts *from* (tick t−1) and its action lands on tick t — the only causally
available information set. But the Phase-B corpora pair the action applied at tick
t with the observation encoded *after* that step, so a BC policy fed `obs(t-1)`
here is a tick off its training pairing. It cancels out of every comparison made in
Phase C (all policies read the same states); it is Phase D's to settle.

### Calibration, and what the numbers already say

`node evaluate.js` — 24 episodes × 12000 ticks of `natural`, the same seeds and
configs as the committed `eval-natural` corpus (same root, same spec, so a score
and a shard are the same world). Scoring costs nothing worth measuring: 320k
ticks/s, ~0.9 s for the whole set.

| policy | score/min | ±se | view | cost | cover | tick-cov | late | knock/m | down% |
|---|---|---|---|---|---|---|---|---|---|
| `expert` | **30.4** | 8.1 | 1084 | 779 | 33.1% | 19.2% | 77 | 1.27 | 14.1% |
| `still` | −4.4 | 6.1 | 382 | 427 | 12.3% | 6.2% | 48 | 1.07 | 9.7% |
| `random` | −357.6 | 2.3 | 254 | 3830 | 18.1% | 3.4% | 72 | 2.68 | 23.8% |

`knockPenalty` was set from this table, at **40**. It is the +view/−hit ratio D3
leaves open and the knob most likely to move as C2's bots arrive; 40 makes the
knock term ~40% of the expert's gross income, on top of the ~14% of the episode he
spends grounded earning nothing. It also leaves the incumbent clearly positive,
which matters for legibility: a game where the shipped watcher scores negative is a
game where the do-nothing floor looks like a strategy.

**The episode is noisy and that sets the eval size.** Per-episode score/min for the
expert ranges −50 to +111 (sd 39.5, median 32.1) — whether a cascade fired, whether
the tower formed near him, how crowded the draw was. 24 episodes gives ±8; anything
smaller cannot see a 30% memory gap.

Three findings already worth having, none of them flattering:

1. **Standing still is not safe.** `still` is knocked 1.07 times a minute against
   the expert's 1.27 — the field walks into *him*. The knock penalty is therefore
   close to a constant tax on existing rather than a price on recklessness, which
   is most of why the next finding happens.
2. **Under crowding, cowering beats working.** On `dense` the expert scores −47.4
   and `still` −36.5. Break-even is measured, not estimated: the two tie exactly at
   `knockPenalty=29` on `dense` and at `knockPenalty=215` on `natural`. So the game
   as specified prices activity out of the market at high density, and the
   curriculum corpus currently teaches freezing. That is a reward-*shape* problem,
   not a magnitude one — the plan's appendix is blunt that per-tick proximity
   rewards breed parking equilibria and that the fix is the shape.
3. **Camping earns a surprising amount of gross income.** Diminishing returns and
   the cap are per incident, and a crowd supplies a stream of *fresh* ones, each
   paying full early-arrival rate: `still` collects 382 points a run without
   deciding anything. ~~So the anti-camping machinery does not close camping.~~
   **Corrected by C2's exploit bots:** net of cost it does. Every camping bot scores
   *below* the do-nothing floor and far below the reactive ceiling — the gross
   income is real and the strategy still loses. The finding that survives is the
   narrower one: gross view income is a bad diagnostic, and the ledger's components
   have to be read together.

These are recorded rather than tuned away — a default chosen to hide a finding is a
default nobody can reason about — and (1) and (2) are still open at C2.

## The yardstick gate (C2)

The phase's question is not "can something score well" but **how much of this game
can only be won by inferring hidden state**. That is a difference between two
scores, which is a trap: build two bots and the gap you measure is the gap between
how hard you tried on each. So there is **one planner** (`planner.js`) and **three
percepts** (`percept.js`), and the arms differ only in what they may read.

| arm | may read |
|---|---|
| **`oracle`** | true state, the incident feed, and every FSM's own countdown — what each thing is, how long it has run, how long it has left |
| **`reactiveTruth`** | the same, minus everything temporal. The **conservative** ceiling: it strictly dominates any memoryless policy reading observations, so the gap above it is a lower bound no 2-frame network can close |
| **`reactiveObs`** | one observation frame, visible slots only, no feed, no memory. The honest analogue of the plan's memoryless twin |

The planner prices each candidate as expected points, using the **exact integral of
the game's own diminishing-returns curve** — the oracle must be limited by
information, not by optimising something other than what it is paid.

### `node evaluate.js --gate` — 24 × 12000 of `natural`

| policy | score/min | ±se | view | cost | cover | tick-cov | late | knock/m | down% |
|---|---|---|---|---|---|---|---|---|---|
| `oracle` | **85.3** | 6.5 | 1527 | 674 | 39.3% | 28.5% | 66 | 1.35 | 11.9% |
| `reactiveTruth` | 81.3 | 8.5 | 1466 | 653 | 38.6% | 26.4% | 67 | 1.31 | 11.8% |
| `reactiveObs` | 10.2 | 3.8 | 465 | 363 | 13.8% | 7.7% | 53 | 0.87 | 7.9% |
| `expert` | 30.4 | 8.1 | 1084 | 779 | 33.1% | 19.2% | 77 | 1.27 | 14.1% |
| `camper` | −53.4 | 7.7 | 348 | 881 | 12.4% | 6.0% | 44 | 1.40 | 12.2% |
| `parker` | −50.9 | 7.9 | 857 | 1366 | 32.9% | 14.2% | 77 | 2.71 | 23.9% |
| `cowerer` | −13.5 | 4.8 | 171 | 305 | 6.6% | 2.6% | 43 | 0.75 | 9.5% |
| `still` | −4.4 | 6.1 | 382 | 427 | 12.3% | 6.2% | 48 | 1.07 | 9.7% |
| `speeder` | 107.2 | 9.7 | 1963 | 892 | 44.3% | 35.0% | 38 | 1.66 | 14.7% |

**Exit check 1 — the memory gap.** Reported twice, because the two ceilings do not
agree and the disagreement is the result:

- **full gap** (over `reactiveObs`): 75.1 = **88% of the oracle**. Threshold 30% —
  **passes** with enormous room.
- **conservative gap** (over `reactiveTruth`): 4.0 = **5%**. **Fails.**

**Exit check 2 — the exploit bots.** All four sit *below* the reactive ceiling
(climb −85% to −20% on the ceiling→oracle line, against a ≤25% bar) — **pass**. The
`speeder` climbs to 129%, out-scoring the oracle itself — **fail**, and it is in the
battery precisely so the check can say so.

### What the gate actually found

**1. All of the value is in knowing *which* panda is worth watching. None of it is
in knowing *how long*.** Removing every temporal quantity from a policy that keeps
the feed and true state costs it 5% — and it stays at ~5% under every knob turned
at it (`stepCost` 6×, `anticipationTau` 5× harsher, both together). The diagnosis
is structural, not a magnitude: **the feed re-tells you what is live every tick, so
nothing has to be predicted.** Commitment is reversible — retargeting costs a few
strides — so optimism beats prediction, which is also why `reactiveTruth` scores a
hair *above* the oracle: the oracle correctly skips trips its estimate says will not
pay, and is occasionally wrong, while the optimist just goes.

That is a real problem for the plan. The anticipation economy — the arrival
multiplier and the duration posterior, called "the money" in the spec — is currently
worth nothing, and the "statistically inferable" tier of the knowability spine has
no teeth. Making it bite means making commitment *irreversible* rather than
expensive: pay only after a minimum dwell, or pay on arrival rather than per tick.
Neither is a knob that exists yet.

**2. The identity tier, by contrast, is nearly the whole game.** `reactiveObs`
scores 10.2 against 85.3 while looking at the same world, because it cannot tell a
sleeper from a panda that was just run over and prices both at the measured base
rate for "down" — 0.21. Its passivity is not timidity: forcing it to chase harder
(zero switch margin, quadrupled dwell, no risk aversion) moves it to 5–7, never
further. It is not that it will not go; it is that it does not know where.

**3. The action space has no speed limit, and the game does not price one.**
`applyHatAction` executes a STEP as one immediate 50px stride with no cadence
check — pacing lives in the policy by design. Measured: a policy that strides every
decision tick travels **25 px/tick, 5.5× the expert and 2.5× a zoomies**, and the
movement cost cannot restrain it because it is charged per stride and so per
*pixel*, not per second. `speeder` is the oracle with that brake off and it scores
**+26%**. This is the one exploit the gate found, it is an action-space hole rather
than a reward one, and it will be a character-gate failure long before it is a
scoring problem. The yardsticks all hold themselves to the expert's cadence so they
measure the game a deployed policy will actually play.

**4. Camping is not profitable, and gross view income is a bad diagnostic.** All
three camping bots lose money — `parker`, which stands where incidents cluster, is
floored 2.71 times a minute for its trouble, because the place where incidents
overlap is the place you get run over. This corrects C1's third finding above.

**A note on the oracle's time estimates.** `remainingOf` in `percept.js` is a second
implementation of arithmetic that lives in `anomalies.js`, which `truth.js`'s header
warns against — but truth's exact `ttl` comes from a second pass over the same
episode, and an oracle acting on it would change the episode the label came from.
The first attempt used `aTimer` alone; that is the *sub-phase* countdown, not the
anomaly's life (for a loop it reads 8 ticks when 200 remain), so the oracle skipped
every loop, moonwalk and spinner and **scored below the strictly-less-informed
reactive arm** — which is how the bug was found. `test/percept.test.js` now holds
the estimator to truth's exact `ttl` per kind, with a per-kind error bound that says
what each one can honestly know: exact for a sleeper, starer and loop, and loose for
a spinner (whose stagger count is drawn only when the spin ends) and a zoomies
(which crashes into a wall the estimator projects but a hero card it does not).

The one engine change C2 needed: `anomalies.js` now **exports** its sub-phase
constants as `PHASE`, so the estimator reads them rather than copying the numbers.
Behaviour-free — the golden digest is unmoved at `d4a2d47b`.

### The policies (C1's three)

| name | what it is |
|---|---|
| `expert` | The shipped rules watcher. Not a baseline so much as the incumbent: what the site runs, what the corpora recorded, what Phase D clones. Implemented as "return null" — that *is* the definition, since re-deriving through `rulesAction` would mutate the watcher's brain mid-episode. |
| `still` | Always HOLD. The do-nothing floor, and a more interesting one than it sounds — he spawns in a crowd and the field comes to him. |
| `random` | Uniform over the 17 actions. Off its own PRNG stream, never the sim's. Worse than `still` by 350 points a minute, which is the cheapest available check that the cost side of the ledger has teeth. |

Every policy must be a pure function of what it is handed — no `Math.random`, no
wall clock. A score that is not reproducible is not a measurement, and a test pins
that an episode is a pure function of (seed, config, policy).

## The twin-episode battery (C3)

Checks 1 and 2 are differences of *scores*: how much a piece of information is
worth, averaged over 24 draws of the eval corpus. Check 3 is a difference of
*behaviour* on a matched pair, and it answers a question no average can:

> **Can this policy tell these two situations apart at all?**

The plan's wording: "matched episode pairs identical in every current observable,
differing only in hidden history. A policy that approaches one and ignores the
other has *behaviorally proven* the inference, no probes required. One battery per
knowability tier."

| tier | the pair | the hidden difference |
|---|---|---|
| **identity** (fully inferable) | a sleeper vs a panda that was just run over, lying in the same cels on the same pixel | one is a live tier-1 incident; the other is worth nothing, because **ordinary knocks pay nothing** |
| **duration** (statistically inferable) | a nap that just started vs one with 30 ticks left | how long it has been lying there — and therefore whether the walk can pay |
| **unknowable** (provably uninferable) | a cascade armed vs not armed | nothing observable, ever. The negative control |

Each battery is 12 pairs, varying the subject's bearing over the 8 sprite axes and
its distance over 300/340/380 px. The whole thing runs in **0.2 s**, which is why
it is inside `evaluate.js --gate` rather than beside it.

### How a pair is built, and what makes it a twin

`scenario.js` builds a stage rather than sampling one: a bare 1240×900 room with no
hero card, a hand-placed roster, and all three directors' clocks pushed past the end
of time (`QUIET`) — silenced rather than bypassed, so a scenario is a state that
`step` treats exactly like any other. A script hook injects the one event the
experiment is about, at an exact tick, through the engine's own `startAnomaly` /
`beginKnock`. Nothing here is a corpus and nothing here is training data.

Three details are load-bearing:

- **The hat is frozen until his cue.** The policy is consulted on every decision
  tick from the first — so a policy with memory has seen the whole lead-in, which is
  where the answer lives — but its action is discarded and replaced with HOLD until
  `decideAt`. Without that the two arms diverge during the lead-in (in one of them
  there is already something worth walking to) and by the decision tick the frames
  no longer match. Frozen means the hand is held, not the eyes shut.
- **The identity is asserted, not assumed.** Before any verdict, both arms are
  re-run with the hat held still and their observation frames at `decideAt` are
  diffed. A mismatch throws and names the token and field. The whole battery rests
  on "these two are the same picture"; a claim nobody checks is one refactor away
  from being false.
- **`impact` is 85 here rather than the shipped 80.** A knock carries its slide
  across `fallTicks` = 17 ticks as `slide / fallTicks` per tick, and 85/17 = 5
  exactly — so the knocked twin lands on precisely the pixel the sleeping twin was
  placed on, with no float residue in the last bit of a `relX`. The check above
  would catch it either way; a scenario that has to be lucky is one that will one
  day not be.

**The knock arm has no collider on stage**, and that is a stated simplification
rather than a hidden one. A real contact knocks *both* bodies, and matching two arms
through a mutual knock would mean matching two subjects instead of one. What is kept
is the tell that carries the information: an ordinary knock **slides** its victim
85 px away from the struck side across the fall cels, and a sleeper lies down where
it stood. Those 17 ticks are the whole of the difference, they are on screen in both
arms, and from the tick the fall ends the two worlds are the same picture.

### The statistic

    discrimination = approach(hot) − approach(cold)          ∈ [−1, 1]

where `approach` is the fraction of the *closable* distance to the site (the trip
minus `viewRadius`, which is his to make) that he closed during the 90-tick window.
1 = he arrived; 0 = he never set off. A policy that walks to both, or to neither,
scores 0 — which is the honest verdict on a policy that cannot tell them apart.

Attendance in `viewRadius` is reported alongside it but is not the verdict: an arm
can stop paying mid-window (a stale nap ends), and the certificate is about what he
committed to at the decision tick, not what the commitment turned out to be worth.

### `node twins.js` — 12 pairs per tier

`d` is the discrimination; `hot`/`cold` are the two approaches it is made of; `split`
counts pairs on which the policy's *action stream* differed between the arms at all.

| policy | identity `d` | hot / cold | duration `d` | hot / cold | unknowable `d` | split |
|---|---|---|---|---|---|---|
| `oracle` | **1.00** | 1.00 / 0.00 | **1.00** | 1.00 / 0.00 | 0.00 | 0/12 |
| `reactiveTruth` | **1.00** | 1.00 / 0.00 | 0.00 | 1.00 / 1.00 | 0.00 | 0/12 |
| `reactiveObs` | 0.00 | 1.00 / 1.00 | 0.00 | 1.00 / 1.00 | 0.00 | 0/12 |
| `expert` | 0.16 | 0.94 / 0.79 | −0.00 | 0.94 / 0.95 | 0.00 | 0/12 |
| `speeder` | 1.00 | 1.00 / 0.00 | 0.67 | 1.00 / 0.33 | 0.00 | 0/12 |
| `still` | 0.00 | 0.00 / 0.00 | 0.00 | 0.00 / 0.00 | 0.00 | 0/12 |

**Exit check 3 — PASS.** The oracle discriminates on both knowable tiers at ceiling
(1.00, every pair), the memoryless twin is blind on both, and nothing moves a muscle
differently on the unknowable one. Stable at 24 pairs and under `viewRadius=130`.

### What the battery found

**1. The flagship certificate is clean, and the split between the two knowable tiers
is exactly the split between the two reactive ceilings.** `reactiveTruth` — the
conservative ceiling, which keeps the incident feed and loses every temporal
quantity — passes `identity` at 1.00 and fails `duration` at 0.00. That is the
boundary between "which panda is worth watching" and "how long it will last" drawn
by behaviour rather than by a score difference, and it corroborates C2's headline
from an independent direction.

**2. The duration tier is decidable, and C2 showed it is worth 5%.** Those are not
in tension and together they are the diagnosis: the information is *there* — the
oracle separates a fresh nap from a nearly-over one on every single pair — but **the
live distribution almost never forces the choice**, because the feed re-announces
what is live every tick and retargeting costs a few strides. The tier does not need
to be made knowable. It needs to be made *consequential*, which is C4's work: pay
only after a minimum dwell, or pay on arrival rather than per tick.

**3. The shipped watcher fails the flagship certificate — and not for lack of
information.** `expert` reads the incident feed and still scores 0.16 on `identity`,
approaching the worthless twin on 0.79 of the trip (and on one pair going *further*
toward it, −0.17). The reason is its ambient behaviour: with nothing flagged nearby
it walks to the nearest panda and studies it, and a body on the ground is the most
interesting thing on a bare stage. **This matters for Phase D**: BC from this expert
teaches indiscriminate approach, which is precisely the superstition the plan warns
about, now measured instead of predicted.

**4. Speed erodes the anticipation economy, a second time.** `speeder` — the oracle
with C2's action-space brake off — scores 0.67 on `duration` against the oracle's
1.00, because at 25 px/tick the trip is short enough that even a 30-tick nap is
worth taking. The same hole C2 priced at +26% of score also *removes* the pressure
to predict, which is a stronger argument for closing it than the score was.

**5. The negative control has real stakes and stays at zero.** The armed arm's
cascade genuinely fires four ticks after the window (the battery asserts that it
did, and that the unarmed arm's did not) — so the two arms are on materially
different futures, and no policy, privileged or otherwise, changed a single action.
The tighter form of the check is what makes it worth having: on this tier the two
arms agree on every observable byte for the whole window, so `identical` is asked
rather than `blind`, and one differing action anywhere would be leakage.

**No engine change was needed.** C3 is entirely trainer-side; the golden digest is
unmoved at `d4a2d47b` and the 170 engine tests are untouched.

## Closing the game (C4)

C2 and C3 each ended in a demand rather than a verdict. C4 answers both, and in the
course of doing so found that **three of the four things standing between the game
and its exit were in the instrument, not the game.**

### The action space had two holes, and they are closed in the body

`applyHatAction` executed a STEP as one immediate 50px stride and began a dive-roll
on request, checking neither the stride cadence nor the roll cooldown. Both limits
existed; both were enforced by the rules expert *on itself* (`rulesAction` HOLDs
while `moveTimer` runs, its reflex checks `rollReadyAt`) and by nothing else, so the
seam ran on an honour system that only the incumbent honoured. Priced before closing:

| bot | what it ignores | score/min | vs oracle |
|---|---|---|---|
| `oracle` | — | 85.3 | — |
| `speeder` | the stride cadence — 25 px/tick, 5.5× the expert | 107.2 | **+26%** |
| `roller` | the roll cooldown — 288 rolls an episode against the expert's 8 | 103.9 | **+22%** |

`roller` is new here and is the worse of the two: `engine.js` skips ROLLING in the
collision pass, so travelling by dive-roll is faster than walking *and* buys immunity
to `knockPenalty` for 2 points a roll. Neither is a reward bug, so no knob in
`game.js` could have priced them — the ledger pays for where he is, and these buy
position with motion the character does not possess. C3 had already found the cost
that mattered most: at 25 px/tick even a 30-tick nap is worth the trip, so the speed
hole *removed* the pressure to predict (`speeder` scored 0.67 on the duration twins
against the oracle's 1.00). A hole that erodes the thing Phase E exists to grow has
to close in the body.

`limitAction` (engine `hat.js`) now applies both limits to any externally-supplied
action; a blocked action becomes HOLD and is *logged* as HOLD, because the BC
contract is that `hat.action` is what actually moved him. The ceiling is `hatAlert`,
the expert's own full-alert cadence — deliberately not the calm one, because the
corpora are recordings of expert actions and a clone must be able to reproduce the
alert strides in its own training data. Pacing still lives in the policy; only the
ceiling moved. **Behaviour-free for the expert**, which is asserted rather than
assumed: a test replays 4000 expert decisions through the limiter and none is
refused, both frozen corpora re-cut to their committed digests, and the golden digest
is unmoved at `d4a2d47b`.

### Exit check 2 was asking action exploits the wrong question

The plan's wording — "much nearer the reactive ceiling than the oracle" — assumes a
bot that wins *without knowing anything*. `camper` and `cowerer` are that. `speeder`
and `roller` are the opposite animal: they are the privileged oracle with one brake
off, so their information *is* the oracle's, and a climb near 1 is what they score
when the exploit is **closed**. Measured against the reactive ceiling, a working
limiter reads as a 100% failure. The two families are now scored against the thing
each would have to beat to be a problem — reward exploits against the reactive
ceiling, action exploits against the oracle itself — and check 2 passes outright.

### Three bugs in the instrument, one of which invalidated a published finding

**1. The yardsticks priced the wrong game.** The planners are constructed once, at
module load, against `DEFAULT_RULES`; `--rules` changed only the referee. Every knob
sweep ever run therefore measured policies that had never seen the knob. C4's first
reading of `dwellMin` showed *identical stride and knock costs at every setting*,
which is what finally exposed it — the trajectories were byte-for-byte the same.
⚠️ **This invalidates C2's published claim** that the conservative gap "stays at ~5%
under every knob turned at it (`stepCost` ×6, `anticipationTau` ×5 harsher, both at
once)". Those sweeps moved the referee and left the policies alone. `runEpisode` now
hands the episode's rules to the policy through `ctx`, and a test pins it.

**2. The planner kept its book in the wrong units.** It is consulted once per
*decision* tick and incremented `banked` by 1, while the referee counts *engine*
ticks — so it believed every visit was half as long as it was. Harmless to the gap
(all three arms shared the error) but it made the dwell arithmetic meaningless.
Correcting it alone moved the conservative gap from −5% to 18%.

**3. A guess was being treated as a short countdown.** An arm with no clock
substitutes `priorRemaining`; treating that point estimate as *known* turns
`est - travel < dwellMin` into a hard refusal, and at the shipped defaults that is
every trip costing more than ~30 ticks of travel. The clockless arm went catatonic —
it stopped walking to the flagship battery's sleeper at all, failing exit check 3 —
and the enormous conservative gap it produced was mostly paralysis. An uncertain arm
now bets the **survival curve** (memoryless, mean `est`) and finds out by winning or
losing. Erring this way keeps the gap conservative, which is the direction
`percept.js` says a gate must err in.

### The commitment economy, and what it actually bought

`dwellMin` + `arrivalPay` make commitment irreversible rather than merely expensive:
a trip pays nothing unless the incident is still running 120 ticks after he arrives,
so what a trip is worth turns on hidden state and on nothing else. Measured on the
corrected instrument, `natural` × 24 × 12000:

| rules | oracle | rTruth | rObs | expert | still | conservative gap |
|---|---|---|---|---|---|---|
| C1–C3 defaults (`dwellMin` 0) | 83.3 | 87.5 | 1.9 | 30.4 | −4.4 | **−5%** |
| `dwellMin` 60 / `arrivalPay` 60 | 148.8 | 137.9 | 4.6 | 56.8 | −1.6 | 7% |
| **shipped: 120 / 120** | **175.4** | **146.1** | **9.5** | **32.3** | **2.6** | **17%** |
| 180 / 180 | 136.5 | 108.8 | −6.3 | 3.3 | −5.2 | 20% |
| 240 / 240 | 75.1 | 57.9 | −10.3 | −41.5 | −20.3 | 23% |
| 300 / 300 | 93.0 | 34.6 | −14.5 | −54.4 | −29.3 | 63% |

Two things to read off this. First, **the default game was worse than C2 reported**:
on a correctly-priced instrument the clockless arm *beats* the oracle (−5%), which is
"optimism beats prediction" in its purest form. Second, **the commitment economy
works but does not reach 30%**: it takes the conservative gap from negative to 17%
while leaving the incumbent where C1 calibrated it, and every setting that clears the
threshold does so by putting the shipped watcher below the do-nothing floor — C1's
own disqualifying condition, now a test rather than a paragraph.

### `node evaluate.js --gate` — the C4 game, 24 × 12000 of `natural`

| policy | score/min | ±se | cover | tick-cov | late | knock/m |
|---|---|---|---|---|---|---|
| `oracle` | 175.4 | 13.8 | 29.5% | 26.6% | 57 | 1.17 |
| `reactiveTruth` | 146.1 | 16.0 | 42.7% | 29.5% | 65 | 1.50 |
| `reactiveObs` | 9.5 | 6.9 | 15.0% | 7.9% | 48 | 0.89 |
| `expert` | 32.3 | 11.6 | 33.1% | 19.2% | 77 | 1.27 |
| `camper` | −53.6 | 9.1 | 12.4% | 6.0% | 44 | 1.40 |
| `parker` | −83.7 | 9.8 | 32.9% | 14.2% | 77 | 2.71 |
| `cowerer` | −13.6 | 6.4 | 6.6% | 2.6% | 43 | 0.75 |
| `still` | 2.6 | 8.6 | 12.3% | 6.2% | 48 | 1.07 |
| `speeder` | 168.6 | 15.3 | 28.9% | 26.7% | 58 | 1.25 |
| `roller` | 66.5 | 11.0 | 23.8% | 16.8% | 61 | 1.18 |

- **Exit check 1 — split, and the split is narrower than it was.** Full gap **95%**
  (PASS). Conservative gap **17%** against a 30% threshold (FAIL), up from a corrected
  −5%. The honest reading is in the next section.
- **Exit check 2 — PASS, outright.** Every reward exploit sits below the reactive
  ceiling; `speeder` is −4% and `roller` −62% against the oracle, so the limiter binds.
- **Exit check 3 — PASS.** Unchanged by the new economy: oracle 1.00 on both knowable
  tiers, both memoryless twins blind on both, and not one action differed on the
  provably-uninferable one.

### What C4 concludes, and what it leaves open

**The conservative threshold is being asked of the wrong quantity, and that is now
measurable rather than arguable.** `reactiveTruth` is handed *identity* for free by
the incident feed — it always knows which pandas are live incidents — so the gap
above it prices the duration tier **alone**. C3 established that both knowable tiers
require memory (a 2-frame reader cannot tell a sleeper from a panda that was run over
once the fall is finished). So the memory gap decomposes: identity is ~78% of the
oracle and duration is 17%, and demanding 30% from duration by itself is a stronger
ask than the plan's own wording ("oracle − the memoryless twin", which is `reactiveObs`
at 95%) ever made. C4 does not quietly relax the threshold — the gate still prints
FAIL — but the number to carry into Phase E is that **the duration tier is now worth
17% of a much larger pie, against ~0% when C3 closed.**

Still open, and explicitly *not* fixed by C4's knobs:

- **Cowering still wins under crowding.** On `dense` the expert scores −55.0 against
  `still`'s −36.2 (it was −47.4 vs −36.5 under C1), so the commitment economy makes
  the crowded regime slightly worse rather than better. This is C1's finding (2), and
  it is a cost-side problem: a probe at `knockPenalty` 20 puts the expert at −1.6
  against `still`'s −2.4 on `dense` and finally ahead. Not adopted here — it moves
  `natural` too and the recalibration is its own piece of work — but it is the lead.
  ⚠️ **This matters for Phase E**, whose training corpus `wild` is dense-ish, so the
  curriculum still teaches freezing.
- **Standing still is not safe** (C1's finding (1)): `still` is knocked 1.07/min
  against the expert's 1.27, so `knockPenalty` remains closer to a tax on existing
  than a price on recklessness. Same recalibration.


## Corpus specs

A spec is `(rng) -> config overrides`. Diversity is not tidiness here — it is the
emergence lever. A belief only becomes legible along axes the training
distribution varies; train on one stage size with one anomaly cadence and the net
can memorise arrival times instead of inferring them.

- **`natural`** — the live distribution: a real viewport, the shipped density rule
  (`layout.js`, the same function the host calls), shipped timings, entrance on.
  This is the **eval** corpus, because it is what a visitor actually gets.
- **`dense`** — the same worlds packed 1.6–2.6× tighter, with incident cadence
  scaled to match. The curriculum: a policy that never trains under pressure never
  learns to triage.
- **`wild`** — the **training** corpus. Stage, density, incident cadence, anomaly
  duration priors, and both set-piece clocks all move; half the episodes open
  mid-scene (`entrance: false`) so the corpus is not over-weighted with the calm
  opening 20 s.

⚠️ `makeConfig` is a shallow merge that **silently ignores unknown keys**, so a
typo in a spec is not an error — it is a quiet fallback to shipped defaults,
discovered later as an unexplained result. `test/corpus.test.js` checks every key
every spec can emit against `DEFAULT_CONFIG` for exactly this reason.

## Commands

```sh
node --test                        # unit tests
node bench.js                      # throughput vs the exit bar
node bench.js --ticks 60000 --episodes 12

# score policies on the game (C1) and run the whole Phase-C gate (C2 + C3)
node evaluate.js --gate                            # the headline run: all three exit checks
node evaluate.js                                   # every policy, natural, 24 episodes
node evaluate.js --policy oracle,reactiveObs --episodes 64
node evaluate.js --spec dense --ticks 6000
node evaluate.js --policy expert --json            # the full per-episode reports
node evaluate.js --rules knockPenalty=25,payAll=0  # turn a knob and re-read

# the twin-episode battery (C3) on its own — 0.2 s for all three tiers
node twins.js                                      # exit check 3
node twins.js --pairs 24                           # every bearing x distance
node twins.js --tier identity --verbose            # every policy, pair by pair
node twins.js --tier duration --policy oracle,expert
node twins.js --json

# cut a corpus: shards under corpora/<name>/, manifest + sample beside it
node cut.js --spec natural --name eval-natural --episodes 120 --ticks 12000
node cut.js --spec wild --name train-wild --episodes 840 --dry-run   # cost, no bytes
node cut.js --spec wild --name train-bc --episodes 840 --no-truth    # BC-only, half the disk
node cut.js --verify corpora/eval-natural.manifest.json --episode 3

# put the cut corpora back (they are gitignored; the manifests are not)
node cut.js --spec wild --name train-wild --episodes 840 --ticks 12000
node cut.js --spec natural --name eval-natural --episodes 120 --ticks 12000
```

`--stride` (default 2, the policy's 10 Hz clock), `--warmup`, `--seed` (the corpus
root, default 20260727) and `--sample` are the remaining knobs.
