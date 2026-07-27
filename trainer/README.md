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
| **B3 — per-tick ground-truth logging (FSM kind/phase/timers, cascade arm, claims)** | ⬜ next |
| **B4 — shard writer + manifest + JSONL sample** | ⬜ |
| **B5 — worker_threads fan-out** | ⬜ (see throughput below — may not be needed for the cut) |
| **B6 — cut the corpora, freeze the roster** | ⬜ |

**Throughput clears the phase's exit bar on one core, encoder included**
(`npm run bench`):

| spec | mean pandas | ticks/s | + observation encoder | faster than real time |
|---|---|---|---|---|
| natural | 6.3 | 440k | 445k | 22200× |
| dense | 13.8 | 115k | 110k | 5500× |
| wild | 12.9 | 124k | 124k | 6200× |

Bar is ≥50k ticks/s/core, so a 10M-tick corpus is **~1.5 core-minutes**. The
encoder costs about 4% at 10 Hz — inside run-to-run noise, which is why the bench
reports both columns rather than trusting one. Cost is otherwise dominated by
collision detection, which is O(n²) in the panda count (16 corner pairs per body
pair, every tick) — which is why the bench reports per spec, and why `dense` is
the one that matters. B5's worker pool is therefore *not* on the critical path for
the corpus cut; it is on it for Phase E's on-policy rollouts, where the step count
is billions rather than millions.

## The pieces

| File | Role |
|---|---|
| `rollout.js` | One episode of the engine, headless, into a sink. `runEpisode({seed, config, sink, ticks, stride, warmup})`. |
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
