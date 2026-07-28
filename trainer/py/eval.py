"""Scoring the exported clone offline, in the terms `metrics.py` argues for.

    uv run python eval.py
    uv run python eval.py --episodes 16 --split natural

Reads the *exported* model, so this measures the file the browser fetches. Reports
the always-HOLD baseline beside every number, because without it none of them mean
anything: the expert holds on ~86% of decisions and that alone scores 0.86 accuracy.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from corpus import Corpus
from data import whole_episodes
from export import load_exported
from metrics import evaluate, always_hold, format_row

HERE = Path(__file__).parent
WEIGHTS = HERE.parent.parent / "assets" / "pandas" / "engine" / "policy" / "weights"


@torch.no_grad()
def run(model, corpus: Corpus, episodes: list[int], frames: int, stride: int = 2,
        batch: int = 4096, delay: int = 0) -> dict[str, float]:
    logits, trues = [], []
    for x, y in whole_episodes(corpus, episodes, frames, stride=stride, delay=delay):
        for i in range(0, len(y), batch):
            logits.append(model(torch.from_numpy(x[i : i + batch])).numpy())
        trues.append(y)
    lg = np.concatenate(logits)
    tr = np.concatenate(trues)
    return evaluate(lg.argmax(-1), tr, logits=lg)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--weights", default=str(WEIGHTS))
    p.add_argument("--episodes", type=int, default=8)
    p.add_argument("--holdout", type=int, default=40)
    args = p.parse_args()

    model, manifest = load_exported(Path(args.weights))
    frames = manifest["config"]["frames"]
    # Score under the pairing the policy was trained with — the manifest records it.
    delay = int(manifest.get("delay", 0))
    print(f"clone {manifest['digest']} trained on {manifest['trainedOn']}, "
          f"step {manifest['step']}, delay {delay}\n")

    # The corpora must match the sensor the weights were trained against: a cone-120
    # model scored on the 360° corpora would be reading a distribution it never saw.
    trained_on = manifest["trainedOn"]
    eval_pair = {"train-wild": "eval-natural", "train-bc": "eval-bc"}[trained_on]
    for name, path in [("held-out wild", trained_on), ("eval natural", eval_pair)]:
        corpus = Corpus(HERE.parent / "corpora" / f"{path}.manifest.json")
        eps = (list(range(len(corpus) - args.holdout, len(corpus) - args.holdout + args.episodes))
               if path == trained_on else list(range(args.episodes)))
        m = run(model, corpus, eps, frames, delay=delay)
        print(format_row(name, m))
        _, y = next(whole_episodes(corpus, eps[:1], frames, stride=2))
        base = always_hold(y)
        print(format_row("  always-HOLD", base))
        # Chance for the direction question, stated so 0.125 is not read as a result.
        print(f"    (dir|step at chance = 0.125; roll share of decisions = {m['roll_share']:.3f})\n")


if __name__ == "__main__":
    main()
