"""Score a SlotNet checkpoint online, through the live sim and the gate's ledger.

    uv run python eval_slot.py --checkpoint runs/ppo-shakedown/latest.pt
    uv run python eval_slot.py --sweep runs/ppo-e5-a --episodes 64

The slot-GRU architecture has no JS kernel yet (Phase F's export work), so
`evaluate.js` cannot score these checkpoints — but the E0 bridge runs the same
engine and the same referee, so this is the same measurement by construction:
episodes stepped at the deployed timing (delay 1, expert pipeline-fill on each
episode's first decision), actions sampled from the softmax exactly as the page
will sample, returns read off the ledger.

Numbers to read against (C5 economy, `natural`, delay 1): expert **57.7**
score/min, `still` **23.9**, the E1 stacked clone **−61.7**.

Knocks are reported as a *proxy*: the wire carries only the ledger delta, and
the only single-decision charge below −10 in the game is the knock penalty
(20), so `reward < −10` counts knockdowns to within the odd coincident-cost
tick. Labelled a proxy in the output for that reason.
"""

from __future__ import annotations

import argparse
import re
import time
from pathlib import Path

import numpy as np
import torch

from probes import load_model
from train import pick_device
from vecenv import VecEnv, EXPERT_ACTION

HERE = Path(__file__).parent
DECISIONS_PER_MIN = 600
KNOCK_PROXY_THRESHOLD = -10.0


@torch.no_grad()
def score_checkpoint(model, env: VecEnv, device, episodes_wanted: int,
                     temperature: float = 1.0) -> dict:
    """Run the fleet until `episodes_wanted` episodes finish; per-episode
    score/min and the knock proxy, under the deployed delay-1 pipeline."""
    model.eval()
    n = env.envs
    cfg = model.cfg
    frame = env.reset().copy()
    mem = torch.zeros(n, cfg.tokens, cfg.d_mem, device=device)
    pend = np.full(n, EXPERT_ACTION, dtype=np.int64)  # pipeline filling everywhere
    ep_len = np.zeros(n, dtype=np.int64)
    ep_knocks = np.zeros(n, dtype=np.int64)
    finished: list[tuple[float, int, int]] = []

    while len(finished) < episodes_wanted:
        obs_new, rewards, dones, _, returns = env.step(pend.astype(np.int8))
        ep_len += 1
        ep_knocks += (rewards < KNOCK_PROXY_THRESHOLD).astype(np.int64)
        fresh = dones.astype(bool)
        if fresh.any():
            for i in np.nonzero(fresh)[0]:
                finished.append((float(returns[i]), int(ep_len[i]), int(ep_knocks[i])))
            ep_len[fresh] = 0
            ep_knocks[fresh] = 0
            mask = torch.from_numpy(fresh).to(device).float().view(-1, 1, 1)
            mem = mem * (1 - mask)
        # Decide from the held frame; fresh envs sit out while their pipeline fills.
        live = ~fresh
        pend[fresh] = EXPERT_ACTION
        if live.any():
            logits, _, _, mem_new = model.step(torch.from_numpy(frame).to(device), mem)
            keep = torch.from_numpy(fresh).to(device).float().view(-1, 1, 1)
            mem = keep * mem + (1 - keep) * mem_new
            act = torch.distributions.Categorical(logits=logits / temperature).sample()
            pend[live] = act.cpu().numpy()[live]
        frame[:] = obs_new

    spm = np.array([r / (l / DECISIONS_PER_MIN) for r, l, _ in finished])
    kpm = np.array([k / (l / DECISIONS_PER_MIN) for _, l, k in finished])
    return {
        "episodes": len(finished),
        "score_per_min": float(spm.mean()),
        "score_se": float(spm.std() / np.sqrt(len(spm))),
        "knocks_per_min_proxy": float(kpm.mean()),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", default=str(HERE / "runs" / "ppo-shakedown" / "latest.pt"))
    p.add_argument("--sweep", default="", help="score every ckpt-*.pt in a run dir instead")
    p.add_argument("--spec", default="natural", help="the eval distribution")
    p.add_argument("--episodes", type=int, default=96)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--envs", type=int, default=32)
    p.add_argument("--ticks", type=int, default=12000)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--corpus-seed", type=int, default=20260101,
                   help="deliberately NOT the training seed — evaluation worlds are fresh")
    p.add_argument("--rules", default="")
    p.add_argument("--device", default="auto")
    args = p.parse_args()

    device = pick_device(args.device)
    if args.sweep:
        run_dir = Path(args.sweep)
        paths = sorted(run_dir.glob("ckpt-*.pt"),
                       key=lambda q: int(re.search(r"(\d+)M", q.name).group(1)))
        if (run_dir / "latest.pt").exists():
            paths.append(run_dir / "latest.pt")
    else:
        paths = [Path(args.checkpoint)]

    print(f"spec {args.spec}, {args.episodes} episodes x {args.ticks} ticks, "
          f"T={args.temperature:g}, corpus-seed {args.corpus_seed}, device {device}")
    print(f"anchors (natural, delay 1): expert +57.7  still +23.9  E1 clone -61.7\n")
    for path in paths:
        env = VecEnv(workers=args.workers, envs_per_worker=args.envs, spec=args.spec,
                     corpus_seed=args.corpus_seed, ticks=args.ticks, rules=args.rules)
        t0 = time.time()
        r = score_checkpoint(load_model(path, device), env, device,
                             args.episodes, args.temperature)
        env.close()
        print(f"  {path.name:<18} score/min {r['score_per_min']:+7.2f} ± {r['score_se']:.2f}   "
              f"knocks/min ~{r['knocks_per_min_proxy']:.2f} (proxy)   "
              f"({r['episodes']} eps, {time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
