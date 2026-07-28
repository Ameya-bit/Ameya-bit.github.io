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
uv run python reference.py                  # the parity fixture + bulk arrays
uv run python eval.py                       # score the exported model
```

Then, from `assets/pandas/engine`:

```sh
node --test test/net.test.js                # the committed 16-case parity fixture
node tools/parity-net.mjs                   # the 24k-frame agreement figure
```

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
| `reference.py` | The parity fixture: real frames, and PyTorch's logits for them. |

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
