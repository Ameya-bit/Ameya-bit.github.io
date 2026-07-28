"""Phase E's opening move: sequence-BC of the recurrent SlotNet.

    uv run python warmstart.py --steps 6000
    uv run python warmstart.py --steps 60 --smoke

The PPO recipe starts from a BC policy — a fresh actor's first advantage estimates
would tear a random policy apart, and the KL anchor needs a distribution worth
anchoring to. But E1's clone is the *stacked-frame* architecture, and Phase E's
model carries its memory in per-slot GRU state instead (`slotnet.py`); the weights
do not transfer. So the warm start is re-learned in the new body: the same corpus
(`train-wild` — cone-masked, decision-aligned), the same delay contract, plain
cross-entropy — but over *windows* stepped in order (`data.SeqPool`), because a
recurrent net only exists across time. The leading `--burn` decisions of every
window warm the memory up and are excluded from the loss.

The bar is the same as every clone's: match E1's offline numbers, roughly — what a
clone *can* learn from this expert is visible-reflex, and the recurrent body should
learn at least what the stacked window did (its 4-frame history is a subset of what
memory can carry). This checkpoint is `ppo.py`'s `--init`; it is not the KL anchor
(that is E1's exported clone, per the plan) and it is not shipped.
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
from data import SeqPool
from metrics import evaluate, always_hold, format_row
from slotnet import SlotNet, SlotConfig
from train import pick_device

HERE = Path(__file__).parent
CORPORA = HERE.parent / "corpora"


@torch.no_grad()
def score_recurrent(model: SlotNet, corpus: Corpus, episodes: list[int], device,
                    delay: int, batch_eps: int = 8) -> dict[str, float]:
    """Argmax over whole episodes, memory carried from each episode's first decision.

    No stride: a recurrent net's state at decision k is the product of every
    decision before it, so the whole episode is stepped even though that costs
    6000 forwards. Episodes are batched together (they share a row count per
    corpus, ticks being spec-fixed) to keep the GPU fed.
    """
    model.eval()
    all_logits, trues = [], []
    for at in range(0, len(episodes), batch_eps):
        group = episodes[at : at + batch_eps]
        pairs = [corpus.episode(ep) for ep in group]
        rows = min(len(a) for _, a in pairs)
        obs = np.stack([o[:rows] for o, _ in pairs])  # (B, rows, tokens, width)
        act = np.stack([a[:rows] for _, a in pairs])
        mem = model.initial_memory(len(group), device=device)
        for i in range(rows):
            x = torch.from_numpy(obs[:, max(i - delay, 0)]).to(device)
            logits, _, _, mem = model.step(x, mem)
            all_logits.append(logits.cpu().numpy())
            trues.append(act[:, i])
    model.train()
    logits = np.concatenate(all_logits)
    return evaluate(logits.argmax(-1), np.concatenate(trues), logits)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--train", default=str(CORPORA / "train-wild.manifest.json"))
    p.add_argument("--eval", default=str(CORPORA / "eval-natural.manifest.json"))
    p.add_argument("--steps", type=int, default=6000)
    p.add_argument("--batch", type=int, default=64, help="windows per step")
    p.add_argument("--length", type=int, default=48, help="decisions per window, after burn-in")
    p.add_argument("--burn", type=int, default=16, help="memory warm-up decisions, no loss")
    p.add_argument("--lr", type=float, default=1.5e-4,
                   help="half of train.py's: BPTT through 64 GRU steps blows up at 3e-4 "
                        "(measured — the first run's loss spiked 0.6 -> 2.0 at step 1550 "
                        "and settled in a near-HOLD basin)")
    p.add_argument("--clip", type=float, default=0.5)
    p.add_argument("--wd", type=float, default=0.01)
    p.add_argument("--warmup", type=int, default=200)
    p.add_argument("--pool", type=int, default=64, help="episodes held in memory")
    p.add_argument("--rotate", type=int, default=20, help="steps between swapping one episode out")
    p.add_argument("--holdout", type=int, default=40)
    p.add_argument("--eval-every", type=int, default=1500)
    p.add_argument("--eval-episodes", type=int, default=8)
    p.add_argument("--delay", type=int, default=1,
                   help="decision-delay contract (1 = the deployed worker pipeline)")
    p.add_argument("--seed", type=int, default=20260728)
    p.add_argument("--device", default="auto")
    p.add_argument("--out", default=str(HERE / "runs" / "warmstart-slot"))
    p.add_argument("--smoke", action="store_true")
    args = p.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = pick_device(args.device)

    train_corpus = Corpus(args.train)
    eval_corpus = Corpus(args.eval)
    print(f"train {train_corpus}\neval  {eval_corpus}\ndevice {device}")

    cfg = SlotConfig(tokens=train_corpus.tokens, obs_width=train_corpus.obs_width,
                     n_actions=train_corpus.n_actions)
    model = SlotNet(cfg).to(device)
    print(f"model {model.n_params():,} params, policy path {model.n_policy_params():,} "
          f"({model.n_policy_params() * 2 / 1024:.0f} KB as float16)")

    n_train = len(train_corpus)
    holdout = list(range(n_train - args.holdout, n_train))
    training = list(range(n_train - args.holdout))
    if args.smoke:
        training, holdout = training[:8], holdout[:2]
    pool = SeqPool(train_corpus, training, length=args.length, burn=args.burn,
                   delay=args.delay, size=args.pool, seed=args.seed)

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
        x, y, burn = pool.batch(args.batch)
        xb = torch.from_numpy(x).to(device, non_blocking=True)
        yb = torch.from_numpy(y).to(device, non_blocking=True)

        mem = model.initial_memory(xb.shape[0], device=device)
        logits, _, _, _ = model.sequence(xb, mem)
        loss = loss_fn(logits[:, burn:].reshape(-1, cfg.n_actions), yb[:, burn:].reshape(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
        opt.step()
        sched.step()

        running += loss.item()
        if step % 50 == 0:
            labels = step * args.batch * args.length
            rate = labels / (time.time() - t0)
            print(f"  step {step:>6}/{args.steps}  loss {running / 50:.4f}  "
                  f"lr {sched.get_last_lr()[0]:.2e}  {rate / 1000:.0f}k labels/s")
            running = 0.0
        if step % args.rotate == 0:
            pool.rotate()

        if step % args.eval_every == 0 or step == args.steps:
            held = score_recurrent(model, train_corpus, holdout[: args.eval_episodes],
                                   device, args.delay)
            nat = score_recurrent(model, eval_corpus, list(range(args.eval_episodes)),
                                  device, args.delay)
            print(f"\n  --- step {step} ---")
            print(format_row("held-out wild", held))
            print(format_row("eval natural", nat))
            history.append({"step": step, "wild": held, "natural": nat})
            ckpt = {"cfg": cfg.dict(), "model": model.state_dict(), "step": step,
                    "delay": args.delay, "arch": "slotnet"}
            torch.save(ckpt, out / "checkpoint.pt")
            # A BPTT run can be knocked into a worse basin and stay there (the
            # first run was, at step ~1550), so the checkpoint that ships forward
            # is the best one *measured*, not the last one trained.
            fit = lambda m: (m["move_f1"] + m["dir_given"] + m["roll_recall"]) / 3  # noqa: E731
            if fit(nat) >= max(fit(h["natural"]) for h in history):
                torch.save(ckpt, out / "best.pt")
                print(f"  best so far (fitness {fit(nat):.3f}) -> best.pt")

    _, y_nat = eval_corpus.episode(0)
    print("\n  baseline, same distribution:")
    print(format_row("always-HOLD", always_hold(y_nat)))

    (out / "history.json").write_text(json.dumps(
        {"args": vars(args), "cfg": cfg.dict(), "params": model.n_params(),
         "history": history}, indent=2) + "\n")
    print(f"\nwrote {out / 'checkpoint.pt'} and {out / 'history.json'} "
          f"in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
