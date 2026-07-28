"""Phase D — behaviour-cloning the rules watcher.

    uv run python train.py --steps 12000
    uv run python train.py --steps 200 --pool 8 --smoke

What this is and is not: the clone's *ceiling* is set by the imitation gap, not by
optimisation. The expert reads the incident feed and the network never will, so the
network cannot know which distant panda is worth walking to; it sees the expert set
off across the room for no visible reason. That is the documented phenomenon (VPT,
PIRLNav, ADVISOR — and C3 measured its consequence in this very sim: the expert scores
0.16 on the flagship twin battery, walking most of the way to the *worthless* twin).
Phase E's RL owns every go/no-go decision. Phase D's bar is only "does he still dodge",
which is `roll_recall` and `move_f1`, and the pipeline behind it.

The loss is plain cross-entropy on the true action distribution — deliberately not
class-balanced. Re-weighting to make rolls look important would change the deployed
*cadence*: the 86% HOLD mass is the expert's pacing, and it is what makes sampling
from the softmax read as a panda rather than a metronome.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from corpus import Corpus
from data import Pool, whole_episodes
from metrics import evaluate, always_hold, format_row
from model import PandaNet, Config

HERE = Path(__file__).parent
CORPORA = HERE.parent / "corpora"


def pick_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


@torch.no_grad()
def score(model: PandaNet, corpus: Corpus, episodes: list[int], device, frames: int,
          stride: int = 4, batch: int = 4096, delay: int = 0) -> dict[str, float]:
    """Argmax predictions over whole episodes, in the order they happened."""
    model.eval()
    preds, trues = [], []
    for x, y in whole_episodes(corpus, episodes, frames, stride=stride, delay=delay):
        for i in range(0, len(y), batch):
            xb = torch.from_numpy(x[i : i + batch]).to(device)
            preds.append(model(xb).argmax(-1).cpu().numpy())
            trues.append(y[i : i + batch])
    model.train()
    return evaluate(np.concatenate(preds), np.concatenate(trues))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--train", default=str(CORPORA / "train-bc.manifest.json"))
    p.add_argument("--eval", default=str(CORPORA / "eval-bc.manifest.json"))
    p.add_argument("--steps", type=int, default=12000)
    p.add_argument("--batch", type=int, default=512)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--wd", type=float, default=0.01)
    p.add_argument("--warmup", type=int, default=300)
    p.add_argument("--pool", type=int, default=48, help="episodes held in memory")
    p.add_argument("--rotate", type=int, default=40, help="steps between swapping one episode out")
    p.add_argument("--holdout", type=int, default=40, help="training episodes kept back")
    p.add_argument("--eval-every", type=int, default=2000)
    p.add_argument("--eval-episodes", type=int, default=8)
    p.add_argument("--delay", type=int, default=0,
                   help="decision-delay contract: pair the window at row i-delay with "
                        "the action at row i (1 = the deployed Web Worker pipeline)")
    p.add_argument("--seed", type=int, default=20260728)
    p.add_argument("--device", default="auto")
    p.add_argument("--out", default=str(HERE / "runs" / "bc"))
    p.add_argument("--smoke", action="store_true", help="tiny run, for wiring only")
    args = p.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = pick_device(args.device)

    train_corpus = Corpus(args.train)
    eval_corpus = Corpus(args.eval)
    print(f"train {train_corpus}\neval  {eval_corpus}\ndevice {device}")
    cone = train_corpus.obs_layout["params"]["coneDeg"]
    if cone != 360:
        print(f"partial observation: coneDeg {cone} — the deployed sensor (Phase E trains on the cone)")

    cfg = Config(tokens=train_corpus.tokens, obs_width=train_corpus.obs_width,
                 n_actions=train_corpus.n_actions)
    model = PandaNet(cfg).to(device)
    print(f"model {model.n_params():,} params  ({model.n_params() * 2 / 1024:.0f} KB as float16)")

    n_train = len(train_corpus)
    holdout = list(range(n_train - args.holdout, n_train))
    training = list(range(n_train - args.holdout))
    if args.smoke:
        training, holdout = training[:8], holdout[:2]
    pool = Pool(train_corpus, training, frames=cfg.frames, delay=args.delay,
                size=args.pool, seed=args.seed)

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.wd,
                            betas=(0.9, 0.95))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: (
        (s + 1) / args.warmup if s < args.warmup
        else 0.5 * (1 + np.cos(np.pi * (s - args.warmup) / max(1, args.steps - args.warmup)))
    ))
    loss_fn = nn.CrossEntropyLoss()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    history: list[dict] = []
    t0 = time.time()
    running = 0.0

    for step in range(1, args.steps + 1):
        x, y = pool.batch(args.batch)
        xb = torch.from_numpy(x).to(device, non_blocking=True)
        yb = torch.from_numpy(y).to(device, non_blocking=True)

        loss = loss_fn(model(xb), yb)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()

        running += loss.item()
        if step % 100 == 0:
            rate = step * args.batch / (time.time() - t0)
            print(f"  step {step:>6}/{args.steps}  loss {running / 100:.4f}  "
                  f"lr {sched.get_last_lr()[0]:.2e}  {rate / 1000:.0f}k samples/s")
            running = 0.0
        if step % args.rotate == 0:
            pool.rotate()

        if step % args.eval_every == 0 or step == args.steps:
            held = score(model, train_corpus, holdout[: args.eval_episodes], device,
                         cfg.frames, delay=args.delay)
            nat = score(model, eval_corpus, list(range(args.eval_episodes)), device,
                        cfg.frames, delay=args.delay)
            print(f"\n  --- step {step} ---")
            print(format_row("held-out wild", held))
            print(format_row("eval natural", nat))
            history.append({"step": step, "wild": held, "natural": nat})
            torch.save({"cfg": cfg.dict(), "model": model.state_dict(), "step": step,
                        "delay": args.delay},
                       out / "checkpoint.pt")

    # The baseline every number above is read against, computed on the same episodes.
    _, y_nat = next(whole_episodes(eval_corpus, [0], cfg.frames, stride=4))
    print("\n  baseline, same distribution:")
    print(format_row("always-HOLD", always_hold(y_nat)))

    (out / "history.json").write_text(json.dumps(
        {"args": vars(args), "cfg": cfg.dict(), "params": model.n_params(), "history": history},
        indent=2) + "\n")
    print(f"\nwrote {out / 'checkpoint.pt'} and {out / 'history.json'} "
          f"in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
