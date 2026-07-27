# panda trainer

Rollout harness and corpus tooling for the learned line-walker —
**Phase B** of [design/panda-policy-net.md](../design/panda-policy-net.md).

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
| **B5 — worker_threads fan-out** | ⬜ (see throughput below — still not needed for the cut) |
| **B6 — cut the corpora, freeze the roster** | ⬜ next |

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
— but the number is recorded as a miss rather than rounded into a pass.

B5's worker pool is therefore still not on the critical path for the cut. It is on
it for Phase E's on-policy rollouts, where the step count is billions rather than
millions, and one shard per episode makes it embarrassingly parallel when it comes:
no shared file, no ordering, nothing to merge.

**What B6 will cost, from `cut.js --dry-run`** (exact byte counts — panda counts come
from `init`, not an estimate):

| corpus | spec | episodes × ticks | rows | on disk |
|---|---|---|---|---|
| training | `wild` | 840 × 12000 | 5.04M | 15.2 GB (6.7 GB with `--no-truth`) |
| eval | `natural` | 120 × 12000 | 720k | 1.7 GB |

## The pieces

| File | Role |
|---|---|
| `rollout.js` | One episode of the engine, headless, into a sink. `runEpisode({seed, config, sink, ticks, stride, warmup})`. |
| `truth.js` | Per-tick ground truth (B3) + `recordEpisode`, which emits aligned `{tick, action, obs, truth}` rows. |
| `corpus.js` | The three corpus specs (`natural` / `dense` / `wild`) as pure functions of a PRNG, plus deterministic episode seeding. |
| `shard.js` | The shard format (B4): the row layout, the streaming writer, and the reader that decodes it back. |
| `cut.js` | Episodes → shards + manifest + JSONL sample. Also the CLI, including `--dry-run` and `--verify`. |
| `bench.js` | Throughput per spec against the exit bar. |
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

[`corpora/format-demo.manifest.json`](corpora/format-demo.manifest.json) and its
sample are in the repo as exactly that — a 2 × 12000 `natural` cut whose only job is
to make the format readable before B6 cuts anything real. Its 28 MB of shards are
not in git; `node cut.js --spec natural --name format-demo --episodes 2 --ticks 12000`
puts them back.

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

# cut a corpus: shards under corpora/<name>/, manifest + sample beside it
node cut.js --spec natural --name eval-natural --episodes 120 --ticks 12000
node cut.js --spec wild --name train-wild --episodes 840 --dry-run   # cost, no bytes
node cut.js --spec wild --name train-bc --episodes 840 --no-truth    # BC-only, half the disk
node cut.js --verify corpora/eval-natural.manifest.json --episode 3
```

`--stride` (default 2, the policy's 10 Hz clock), `--warmup`, `--seed` (the corpus
root, default 20260727) and `--sample` are the remaining knobs.
