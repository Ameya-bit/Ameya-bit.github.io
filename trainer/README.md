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
| **B4 — shard writer + manifest + JSONL sample** | ⬜ next |
| **B5 — worker_threads fan-out** | ⬜ (see throughput below — may not be needed for the cut) |
| **B6 — cut the corpora, freeze the roster** | ⬜ |

**Throughput clears the phase's exit bar on one core with the whole pipeline in
the loop** (`npm run bench`):

| spec | mean pandas | ticks/s | + encoder | + ground truth | faster than real time |
|---|---|---|---|---|---|
| natural | 6.3 | 439k | 448k | 221k | 11000× |
| dense | 13.8 | 116k | 113k | **56k** | 2800× |
| wild | 12.9 | 125k | 122k | 60k | 3000× |

Bar is ≥50k ticks/s/core, so a 10M-tick corpus is **~3 core-minutes**. Read the
columns as an escalation: the sim alone, then the observation encoder (about 4% —
inside run-to-run noise), then full recording, which costs **~2×** because ground
truth walks each episode twice (see below). The last column is the honest one, and
`dense` — the binding spec — clears the bar with 12% to spare rather than 2×, so
that headroom is worth watching. Cost is otherwise dominated by collision
detection, O(n²) in the panda count (16 corner pairs per body pair, every tick).

B5's worker pool is still *not* on the critical path for the cut at 3 core-minutes;
it is on it for Phase E's on-policy rollouts, where the step count is billions
rather than millions. If recording ever does bind, the scan pass is embarrassingly
parallel and does no encoding at all.

## The pieces

| File | Role |
|---|---|
| `rollout.js` | One episode of the engine, headless, into a sink. `runEpisode({seed, config, sink, ticks, stride, warmup})`. |
| `truth.js` | Per-tick ground truth (B3) + `recordEpisode`, which emits aligned `{tick, action, obs, truth}` rows. |
| `corpus.js` | The three corpus specs (`natural` / `dense` / `wild`) as pure functions of a PRNG, plus deterministic episode seeding. |
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
```
