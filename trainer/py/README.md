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

## What is here

| File | Role |
|---|---|
| `corpus.py` | Reads a cut corpus from its manifest. The whole loader is `np.fromfile(...).reshape(-1, width)`, which is what B4 bought by making one file one episode. |
| `data.py` | Stacked-frame windows out of a rotating pool of episodes — 6.7 GB does not fit, and 27 GB of materialised windows fits even less. |
| `model.py` | The network, and the budget table that determined its shape. |
| `train.py` | The BC run. |
| `metrics.py` | Scoring that is not dominated by HOLD. Read this before reading any number. |
| `eval.py` | Scores the *exported* model, so it measures the file the browser fetches. |
| `export.py` | float16 blob + JSON manifest into `policy/weights/`. |
| `reference.py` | The parity fixture: real frames, and PyTorch's logits for them. Writes to `trainer/parity/` — never beside the weights, because everything under `assets/pandas/` is a Quarto site resource and a local render would sweep 128 MB of fixture into `_site`. |
| `vecenv.py` | **E0**: the live sim as a Python `VecEnv` — spawns `node ../vec-serve.js` and speaks its binary stdio protocol. What E3's PPO loop steps. `--bench` measures the bridge end to end (175k+ decisions/s at 8×64 on the dev machine). |

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
