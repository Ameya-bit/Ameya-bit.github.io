"""Scoring a clone, in terms that are not dominated by HOLD.

**Raw action agreement is close to worthless here.** The expert holds on 85.6% of
decisions on `wild` and 87.4% on `natural` — pacing is most of what it does — so a
network that emits HOLD unconditionally already "agrees" 86% of the time. Phase D's
exit criterion is JS-vs-PyTorch agreement, where that is fine (both sides run the same
weights on the same frames, so any disagreement is a numerical bug). As a measure of
whether the clone learned anything it is a trap, and these are the numbers to read
instead:

  move_f1     — HOLD vs not, as F1 on the "move" class. Does he step when the expert
                steps? This is the cadence.
  dir_acc     — of the decisions where the expert stepped, how often the clone's
                argmax names the same one of 8 directions. This is the part the
                misaligned corpus used to hand over for free (D0), so it is the number
                that would have looked good for the wrong reason.
  dir_given   — the same question with the cadence taken out: argmax restricted to
                the 8 step actions. `dir_acc` conflates "does he step now?" with
                "which way?", and the first is largely unanswerable — the expert's
                stride timer is not observable, so a clone correctly hedges toward
                HOLD and its unrestricted argmax is HOLD even when its directional
                belief is sharp. Deployment samples from the softmax rather than
                taking the argmax, so `dir_given` is the number that predicts what
                the page will look like; `dir_acc` predicts what argmax would.
  balanced    — macro recall over all 17 classes. Rolls are ~1% of decisions and
                unbalanced accuracy will never notice them.
  roll_recall — of the decisions where the expert dive-rolled, how often the clone
                does too (in any direction). The dodge, which is Phase D's stated bar.
"""

from __future__ import annotations

import numpy as np

HOLD = 0
STEP_BASE, ROLL_BASE, N_ACTIONS = 1, 9, 17

is_step = lambda a: (a >= STEP_BASE) & (a < ROLL_BASE)  # noqa: E731
is_roll = lambda a: a >= ROLL_BASE  # noqa: E731


def evaluate(pred: np.ndarray, true: np.ndarray, logits: np.ndarray | None = None) -> dict[str, float]:
    """Every number above, from a pair of action arrays.

    `logits` is optional and only `dir_given` needs it — without them that field is
    NaN rather than silently falling back to something else.
    """
    n = len(true)
    moved_t, moved_p = true != HOLD, pred != HOLD
    tp = int((moved_t & moved_p).sum())
    precision = tp / max(1, int(moved_p.sum()))
    recall = tp / max(1, int(moved_t.sum()))

    stepped = is_step(true)
    # Direction agreement is asked only where the expert stepped, and it credits a
    # step in the right direction — not a roll, which is a different decision.
    dir_hits = int((is_step(pred[stepped]) & (pred[stepped] == true[stepped])).sum())

    rolled = is_roll(true)
    recalls = []
    for a in range(N_ACTIONS):
        seen = true == a
        if seen.any():
            recalls.append(float((pred[seen] == a).mean()))

    # Direction with the cadence question removed: force a step, ask which one.
    dir_given = float("nan")
    if logits is not None and stepped.any():
        best_step = logits[stepped, STEP_BASE:ROLL_BASE].argmax(-1) + STEP_BASE
        dir_given = float((best_step == true[stepped]).mean())

    return {
        "n": float(n),
        "acc": float((pred == true).mean()),
        "hold_share": float((true == HOLD).mean()),
        "dir_given": dir_given,
        "move_f1": 0.0 if tp == 0 else 2 * precision * recall / (precision + recall),
        "move_precision": precision,
        "move_recall": recall,
        "dir_acc": dir_hits / max(1, int(stepped.sum())),
        "roll_recall": float(is_roll(pred[rolled]).mean()) if rolled.any() else float("nan"),
        "roll_share": float(rolled.mean()),
        "balanced": float(np.mean(recalls)),
    }


def always_hold(true: np.ndarray) -> dict[str, float]:
    """The do-nothing baseline every number here has to be read against."""
    return evaluate(np.zeros_like(true), true)


def format_row(label: str, m: dict[str, float]) -> str:
    return (
        f"  {label:<22} acc {m['acc']:.3f}  move-F1 {m['move_f1']:.3f}  "
        f"dir {m['dir_acc']:.3f}  dir|step {m['dir_given']:.3f}  "
        f"roll-recall {m['roll_recall']:.3f}  balanced {m['balanced']:.3f}"
    )
