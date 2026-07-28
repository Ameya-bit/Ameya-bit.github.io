# panda-bc — Phase D's training side

Behaviour-cloning the rules watcher, and exporting the result to the browser.
**Phase D** of [design/panda-policy-net.md](../../design/panda-policy-net.md).

The only Python in the repo. Everything upstream of it (sim, sensor, corpora, game)
is zero-dependency Node, and everything downstream (the forward pass that ships) is
hand-written JS — this is the middle, where the gradients are.

```sh
uv sync
uv run python train.py --steps 72000        # ~8 min on an M-series GPU
uv run python export.py --checkpoint runs/bc-long/checkpoint.pt
uv run python reference.py                  # the parity fixture + bulk arrays -> ../parity/
uv run python eval.py                       # score the exported model
```

Then, from `assets/pandas/engine`:

```sh
node --test test/net.test.js                # the committed parity fixture (trainer/parity/)
node tools/parity-net.mjs                   # the 24k-frame agreement figure
```

**Train the deployed timing: `--delay 1`.** The page runs the forward pass in a Web
Worker on a pipelined schedule — the frame from decision k produces the action
applied at decision k+1 — so a deployed net only ever answers for an action one
decision after the observation it saw. `--delay 1` pairs windows and actions that
way (see `data.py`'s header); the checkpoint carries the value, `export.py` writes it
into the manifest, and `eval.py` scores under it automatically. The Phase-D
clone predated the contract (delay 0); measured on the C5 ledger, running it delayed
anyway cost −64.7 → −68.6 score/min and 2.01 → 2.42 knocks/min — the reflex fires
off a 100 ms-stale picture. A policy *trained* delayed can compensate by
anticipating; one merely *run* delayed cannot, which is why the flag exists.

## E1 — the shipped weights are now the partial-obs, delay-trained clone (2026-07-28)

Phase E's first workstream, run before E0 exists on purpose: it re-trains the clone
under everything the deployed policy actually faces — the 120° cone (`train-wild`,
which also carries the ground truth Phase E's probes need), the one-decision delay,
`eval-natural` as the scoring pair — and in doing so exercises the whole
train → export → parity → deploy pipeline on the real sensor. It is also the KL
anchor E3's PPO run will pull against, and the recipe is one command:

```sh
uv run python train.py --train ../corpora/train-wild.manifest.json \
    --eval ../corpora/eval-natural.manifest.json --delay 1 \
    --steps 72000 --pool 64 --rotate 20 --eval-every 12000 --out runs/bc-e1
uv run python export.py --checkpoint runs/bc-e1/checkpoint.pt --corpus ../corpora/train-wild.manifest.json
uv run python reference.py --corpus ../corpora/eval-natural.manifest.json
```

(8.1 min on an M-series GPU, 76k samples/s; export digest `1f0d343e13a8aea9`,
237.5 KB, parity 24,000/24,000 with a largest logit difference of 1.9e-5.) The
`policy/weights/` pair is replaced in place — the loader builds its observer from
the manifest's own recorded params, so the page's `?policy=nn` arm picks up the
cone without a code change, and `eval.py` follows `trainedOn` to the matching
corpora rather than assuming the 360° pair.

**The cone and the delay cost almost nothing offline** — which is the pipeline
working, not a surprise about the problem: the labels the full-obs clone could
learn were the visible-reflex ones all along.

| question | E1 (cone 120, delay 1) | Phase-D clone (360°, delay 0) |
|---|---|---|
| `dir_given` | **0.555** | 0.578 |
| `roll_recall` | **0.629** | 0.620 |
| `move_f1` | 0.306 | 0.301 |

Online under the deployed contract (`node evaluate.js --policy clone --delay 1`),
it scores **−61.7/min on `natural` at 2.18 knocks/min** against the shipped clone's
−68.6 and 2.42 when run delayed — trained-under-delay buys back about the delay
penalty, no more. The gap to the expert (57.7/min, 1.27 knocks/min) is the
imitation gap RL exists to close, and it is E3's, not E1's.

## E3 — the PPO trainer (2026-07-28)

Phase E's engine: `slotnet.py` + `warmstart.py` + `ppo.py`. The model is E2's pick
made trainable — the single-frame spatial transformer with a d48 GRU per token,
policy path 133,361 params (260 KB as float16, matching the priced kernel;
`JsGru` reproduces `tools/bench-kernels.js`'s arithmetic to 6e-8 over a stepped
trajectory, so the eventual export is a straight copy) — plus two heads the
browser never sees: the critic, and setting 2's auxiliary predictor (own future
observations, per token, at horizons 1/2/4, conditioned on the executed actions).

```sh
uv run python warmstart.py --steps 4000 --batch 256      # ~15 min; writes best.pt
uv run python ppo.py --init runs/warmstart-slot/best.pt  # the recipe, defaults = the plan
```

**The warm start is re-learned in the new body** (E1's stacked-frame weights do
not transfer), as sequence-BC over contiguous windows: 16 burn-in decisions warm
the zero-initialised memory, the loss reads the next 48. Two findings from its
first two runs:

- **BPTT through 64 GRU steps blows up at BC's own learning rate.** At `train.py`'s
  3e-4 the loss ran 0.59 → 2.0 at step ~1550 and settled in a near-HOLD basin the
  cosine decay froze in place (final `roll_recall` 0.10, against 0.80 at its own
  step 1000). At 1.5e-4 with clip 0.5 the same run is clean end to end. This is
  the plan's "transformers may not train under RL" risk showing up in *supervised*
  BPTT, which is why `warmstart.py` now writes `best.pt` — the checkpoint that
  ships forward is the best one measured, never the last one trained.
- **The recurrent clone learns the expert's cadence, which the stacked window
  provably could not.** The expert's stride clock (`moveTimer`) is internal state
  no observation exposes — but a net that carries memory can *count decisions
  since its last stride*. Measured on `eval-natural`, against the E1 clone:

  | question | slot warm-start | E1 (stacked, delay 1) |
  |---|---|---|
  | `move_f1` | **0.783** | 0.306 |
  | `roll_recall` | **0.831** | 0.629 |
  | `dir_given` | 0.517 | 0.555 |

  The cadence was the D5 diagnosis ("it never pauses — it walks 45% more") and it
  is largely closed *before RL* — carried memory doing real work on day one.

**`ppo.py` is the locked recipe, and the delay contract is structural.** The
rollout processes each frame once and steps the sampled action at the *next*
decision; the first decision of every episode goes to the rules expert (`-1`)
while the pipeline fills — the deployed timing, bit for bit. Those expert
decisions land as `skip` slots: no forward ran, so the replay discards their
memory update and every loss masks them. Recurrent replay uses rollout-snapshot
initial states at `--bptt` (64) boundaries — R2D2's stored-state compromise; the
chunk length is also the horizon credit can flow over, and must stay longer than
the knock-to-classification span the flagship certificate needs. Critic-only
warmup holds the actor at lr 0 for `--warmup-updates`; the leash
(`--leash frac:coef,...`) is piecewise-linear over the run — tight, annealed
loose mid-training so information-seeking is discoverable, re-tightened late;
KL-to-anchor is computed against the *exported* E1 pair (`load_exported`), the
same file the browser fetches, driven on a 4-frame ring primed by repetition
exactly as `net.js` primes. `--aux-coef 0` is the setting-1 purist arm.

**Validated end to end at real scale (10M steps, the default fleet and recipe):**
**21.2k decisions/s** through env + inference + replay on the dev machine — a
300M-step E5 run is ~4 hours, comfortably overnight — and the loop *learns*:
score/min on `wild` climbed from **−90 (the warm start's level, delay 1) to
−21** by 10M steps, while the anchor KL held at 0.23–0.27 through the entire
leash sweep (the believability tether working: score quadrupled without leaving
the clone's neighbourhood), the aux loss fell monotonically 0.049 → 0.022, and
entropy never collapsed. The mechanism is visibly the D5 pathology being priced
out — the ledger charges for exactly the aimless walking the clone over-does.
Checkpoints land every `--save-every-steps` (2M): E4's probes read those. What
a 10M-step run does **not** show is anything Phase E is actually for — the
expert is at +21.8/min on this spec, the memory gap sits above *that* — so the
numbers here validate the machinery, not the emergence; E5 owns the real runs.

The known bill for scoring a slot-GRU candidate through `evaluate.js --gate`:
the JS inference kernel for this architecture does not exist yet (`net.js` runs
the stacked clone; `tools/bench-kernels.js` has the priced shape). It is Phase
F's export work, and until then online scores come from the bridge's own ledger,
which is the same referee by construction.

## E4 — checkpoint probes (2026-07-28)

`probes.py` — the shortcut-hunt gauge, and the overlay's future feed. Linear
probes (deliberately: one `nn.Linear` on standardised features, the same bar
Phase G will hold) over every bound neighbour token's state, joined to that
panda's ground truth through the corpus's `slots` block. Three questions —
`kind` (9-way macro-F1), the `flagship` sleeper-vs-knocked discrimination, and
`ttl` (ridge R² on log1p) — each read at two points (`feat`, the 96d the heads
see; `mem`, the 48d carried GRU state the overlay chip will read) and split
**visible vs held**, because a held token's observation is zeros-plus-`present`
and anything decodable there is being carried, not seen.

```sh
uv run python probes.py                       # the warm start, vs the untrained twin
uv run python probes.py --sweep runs/ppo-v1   # every ckpt-*.pt -> decodability trajectory
```

**The baseline is a twin, not zero, and it earns its keep immediately.** An
untrained random-init net probed identically scores flagship 0.68 / ttl 0.35 on
visible tokens (random recurrent features are a reservoir; OthelloGPT's
untrained nets probed 66% vs 89%), so a lone decodability number means nothing —
only the trained−untrained gap does. **First reading, on the 10M shakedown's
checkpoints: score climbed −90 → −21 while every probe stayed flat at or
slightly below the reservoir** — kind 0.19 vs 0.21, flagship 0.62 vs 0.68, held
tier indistinguishable, held-ttl actively *negative* R². The early score gains
are cheaper behaviour (walk less, get knocked less), not inference. That is the
plan's predicted opening position, and it is exactly the signature this
instrument exists to catch when it matters: an E5 run whose score rises while
these numbers do not move has found an exploit, not a world model.

## E5, iteration 1 (2026-07-28) — the loop found a trap, and it is C5's

The first day of real runs did not produce a candidate; it produced a diagnosis,
which is what the shortcut-hunt loop is for. Status: **stopped by rule, awaiting
a design decision** (see "where it stands" below).

**The instrument set** (all landed today): `eval_slot.py` scores any checkpoint
online — fresh worlds (corpus seed the training never saw), deployed timing,
softmax sampling, the gate's ledger — at ~10 s per checkpoint; `probes.py` reads
decodability; during a long run a background loop auto-scores each checkpoint as
it lands. The training log leads with `now` (this rollout's mean reward as
score/min) because the rolling episode average — episodes take ten minutes —
lagged a full policy-generation behind and painted the first run's
peak-then-decline as a smooth climb. Fixed after it fooled us once.

**What every run and arm did, on `natural` (anchors: expert +57.7, `still`
+23.9, E1 clone −61.7):**

| policy | score/min | knocks/min (proxy) |
|---|---|---|
| recurrent warm start (BC) | −76 | ~2.2 |
| any arm, ~2M steps (post-warmup) | −10 … +11 | ~1.0–1.3 |
| leash 1.0 (plan default), 13M | −23 … −30, still falling | ~1.3 |
| leash 0 / leash 0.1, 13M | plateau −5 … −25 | ~1.0–1.4 |
| leash 0.1, **58M** (run e5-b) | **−7.3 ± 3.6 vs −10.0 ± 3.9 at 4M — zero progress** | ~1.1 |

**Three findings.**
1. **All the money arrives immediately.** Warmup + a few conservative updates
   take the BC clone from −89/−76 to roughly break-even by nudging thin HOLD
   margins — it stops paying for aimless walking, and its knock rate drops
   *below the expert's* (~1.1 vs 1.27). Real, replicated across every arm.
2. **The plan's tight-early leash (coef 1.0) actively degrades from that peak**
   (to −25/−30 by 13M on both specs); coef 0.1 or 0 holds flat instead. The
   long run therefore carried `--leash 0:0.1,1:0.1`.
3. **Nothing climbs out of the plateau.** e5-b ran 58M steps under the gentle
   tether and moved 2.7 ± 5.3 — nothing — and was stopped by the pre-registered
   rule (flat at 60M ⇒ kill). The probes agree: decodability flat at the
   untrained-reservoir baseline throughout. **This is the trap C5 predicted**:
   since `knockPenalty` 40 → 20, "freezing loses everywhere but is no longer
   worthless," and the policy has found *still-with-reflexes* — safe, income-
   free, and a local optimum a conservative gradient cannot leave, because
   income-earning trajectories (walk to the anomaly, arrive early, dwell) are
   too rare under its own behaviour for the advantage signal to find them.

**Where it stands.** Two escalation arms ran as 10-minute shakedowns: **C**
(actor lr 3e-5 → 1e-4) and **D** (lr 1e-4 + the `dense` curriculum spec, the
plan's own lever — incident-rich worlds steepen the income gradient). Results
in `runs/arms-cd.log` / `runs/ppo-armC-lr1e4` / `runs/ppo-armD-dense`. If
either climbs above the plateau band, it earns the long run (same auto-sweep,
same kill rule). If both stay flat, the next levers are game-side and are a
design decision, not a hyperparameter: reward shaping toward approach
(potential-based, the plan's "only if reward starves" clause — it is starving),
a curriculum schedule (dense → wild), an exploration mechanism the KL anchor
currently suppresses, or a better-behaved anchor (the frozen recurrent warm
start rather than the E1 stacked clone). Checkpoint archives for all runs and
arms are under `runs/` and re-scoreable at any time.

## What is here

| File | Role |
|---|---|
| `corpus.py` | Reads a cut corpus from its manifest. The whole loader is `np.fromfile(...).reshape(-1, width)`, which is what B4 bought by making one file one episode. |
| `data.py` | Stacked-frame windows out of a rotating pool of episodes — 6.7 GB does not fit, and 27 GB of materialised windows fits even less. Also `SeqPool`, the same pool cut into contiguous windows for BPTT. |
| `model.py` | The Phase-D network (stacked frames), and the budget table that determined its shape. Still the anchor's architecture. |
| `train.py` | The BC run (Phase D / E1). |
| `slotnet.py` | **E2's pick as a trainable model**: the single-frame spatial transformer + per-slot GRU, plus the trainer-only value and aux heads. The Phase-E actor. |
| `warmstart.py` | **E3's opening move**: sequence-BC of the recurrent SlotNet on `train-wild`, delay 1 — the PPO init. |
| `ppo.py` | **E3**: the PPO trainer — critic-only warmup, KL-to-frozen-E1 with the leash schedule, setting-2 aux loss, delay-1 on-policy rollouts on the E0 bridge. |
| `probes.py` | **E4**: linear probes per checkpoint — kind/flagship/ttl decodability, visible vs held, always against the untrained-twin reservoir. |
| `metrics.py` | Scoring that is not dominated by HOLD. Read this before reading any number. |
| `eval.py` | Scores the *exported* model, so it measures the file the browser fetches. |
| `export.py` | float16 blob + JSON manifest into `policy/weights/`. |
| `reference.py` | The parity fixture: real frames, and PyTorch's logits for them. Writes to `trainer/parity/` — never beside the weights, because everything under `assets/pandas/` is a Quarto site resource and a local render would sweep 128 MB of fixture into `_site`. |
| `vecenv.py` | **E0**: the live sim as a Python `VecEnv` — spawns `node ../vec-serve.js` and speaks its binary stdio protocol. What `ppo.py` steps. `--bench` measures the bridge end to end (175k+ decisions/s at 8×64 on the dev machine). |

## Three things worth knowing before reading a number

**Raw action agreement is close to meaningless.** The expert holds on ~86% of
decisions — pacing is most of what it does — so always-HOLD scores 0.86 accuracy.
`metrics.py` reports `move_f1`, `dir_given`, `roll_recall` and macro-balanced recall
for this reason, always beside the always-HOLD baseline.

**The corpus must be `alignment: decision`.** A tick-aligned corpus (shard v1) pairs
each action with the frame it *produced*, and the hat panda's own token in that frame
carries the facing he just turned to: P(facing == step direction | stepped) is 93.3%
after the step against 48.9% before it. A clone trained that way reads its own body
instead of the world, scores better, and fails in the browser — where the only frame
available is the one before the action. `corpus.py` refuses v1 outright.

**The clone's ceiling is the imitation gap, not optimisation.** The expert reads the
incident feed; the network never will. It watches the expert set off across the room
for no visible reason and the only lesson available is "sometimes walk confidently at
nothing". That is a formal result, not a training bug, and Phase E's RL is what owns
every go/no-go decision. What the clone *can* learn, it does:

| question | clone | chance / baseline |
|---|---|---|
| which of 8 directions did the expert step? (`dir_given`) | **0.578** | 0.125 |
| did the expert dive-roll? (`roll_recall`) | **0.620** | 0.000 |
| did the expert move at all? (`move_f1`) | 0.301 | 0.000 |

…and what it cannot, it cannot for a stateable reason: *whether* to step this tick
depends on `moveTimer`, the expert's internal stride clock, which no observation
exposes.

## The export is the model

`export.py` rounds every weight to float16 before anything else, because 475 KB of
float32 is over the plan's ~400 KB wire budget and 238 KB is not. The rounded values
are then what *both* sides run: `reference.py` re-loads the exported pair rather than
using the checkpoint, so quantisation error can never show up as a JS-vs-PyTorch
disagreement. There is nothing left to disagree about — the file is the model and
Python and JS are two readers of it.

Measured: 24,000/24,000 actions agree, largest single logit difference 2.2e-5.
