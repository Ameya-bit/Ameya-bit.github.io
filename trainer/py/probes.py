"""E4 — checkpoint probes: is the hidden state becoming decodable?

    uv run python probes.py --checkpoint runs/warmstart-slot/best.pt
    uv run python probes.py --sweep runs/ppo-v1

Linear probes over the network's per-token state, scored against the ground
truth the sensor refused to encode. **Instrumentation, not results** (the plan's
own words): the full control battery — interventions, shuffled labels,
egocentric bases — is Phase G's. What this answers per checkpoint, cheaply, is
the shortcut-hunt question: *is score climbing while decodability stays flat?*
And it feeds the overlay: the kind probe's weights over the carried memory are
exactly what a belief chip reads.

## What is probed

The model steps through labelled episodes exactly as deployed (memory from the
episode's first decision), and every *bound neighbour token* becomes a sample:
its features, paired through the corpus's `slots` join with that panda's truth
at the same row. Three questions, each asked of two read points — `feat` (the
normalised token state + memory, 96d, what the heads read) and `mem` (the
carried GRU state alone, 48d, what the overlay will read) — and each split by
**visible vs held**: a held token's observation is `present` and zeros, so
anything decodable there beyond the prior is being *carried*, not seen.

  kind       9-way (none + the 8 anomaly kinds), macro-F1. The fully-inferable
             tier; visible-kind is largely pose-readable (positive control),
             held-kind is object permanence.
  flagship   sleeper vs freshly-knocked, restricted to pandas lying in the fall
             cels — the certificate discrimination. The sensor encodes the two
             identically by pinned test, so *visible* decodability here is
             already memory at work.
  ttl        log1p time-remaining on anomalous pandas, ridge R². The
             statistically-inferable tier — the duration posterior.

## The baseline is a twin, not zero

An untrained random-init twin is probed identically, always. Random recurrent
features are a reservoir — they hold history and probe well above chance
(OthelloGPT's untrained nets probed 66% vs 89% trained) — so the number that
means anything is the **gap** trained − untrained, and the report prints both,
never a lone score.

Probes are deliberately linear (one nn.Linear, standardised features): the
claim worth tracking is "linearly decodable", the same bar Phase G will hold.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from corpus import Corpus
from slotnet import SlotNet, SlotConfig
from train import pick_device

HERE = Path(__file__).parent
CORPORA = HERE.parent / "corpora"

KIND_NONE = 0  # class 0 of the kind probe: no anomaly (wander/observing/entering/...)


# ---- feature collection ----

@torch.no_grad()
def collect(model: SlotNet, corpus: Corpus, episodes: list[int], device,
            stride: int = 2, batch_eps: int = 8) -> dict[str, np.ndarray]:
    """Run the checkpoint over labelled episodes; every bound neighbour token at
    every `stride`-th decision becomes one sample."""
    model.eval()
    sf = corpus.truth_fields("slots")
    ef = corpus.truth_fields("entities")
    mode_names = corpus.labels["mode"]
    kind_of_mode = np.full(len(mode_names), KIND_NONE, dtype=np.int64)
    for k, kind in enumerate(corpus.labels["anomalyKind"]):
        kind_of_mode[mode_names.index(kind)] = k + 1
    knocked_mode = mode_names.index("knocked")
    sleeper_mode = mode_names.index("sleeper")

    feats, kinds, modes, ttls, visibles, ep_ids = [], [], [], [], [], []
    for at in range(0, len(episodes), batch_eps):
        group = episodes[at : at + batch_eps]
        loaded = []
        for ep in group:
            rows, blocks = corpus.load(ep)
            o = blocks["obs"]
            obs = rows[:, o.at : o.at + o.size].reshape(-1, corpus.tokens, corpus.obs_width)
            s, e = blocks["slots"], blocks["entities"]
            slots = rows[:, s.at : s.at + s.size].reshape(-1, s.repeat, s.width)
            ents = rows[:, e.at : e.at + e.size].reshape(-1, e.repeat, e.width)
            loaded.append((obs, slots, ents))
        rows_n = min(len(o) for o, _, _ in loaded)
        obs_all = np.stack([o[:rows_n] for o, _, _ in loaded])

        mem = model.initial_memory(len(group), device=device)
        for i in range(rows_n):
            x = torch.from_numpy(obs_all[:, i]).to(device)
            _, _, feat, mem = model.step(x, mem)
            if i % stride:
                continue
            f = feat.cpu().numpy()  # (B, tokens, 96)
            for b, (_, slots, ents) in enumerate(loaded):
                bound = slots[i, :, sf["id"]] >= 0
                if not bound.any():
                    continue
                ids = slots[i, bound, sf["id"]].astype(np.int64)
                truth = ents[i, ids]
                feats.append(f[b, 1:][bound])  # token s+1 is slot s
                modes.append(truth[:, ef["mode"]].astype(np.int64))
                kinds.append(kind_of_mode[modes[-1]])
                ttls.append(truth[:, ef["ttl"]])
                visibles.append(slots[i, bound, sf["visible"]] > 0)
                ep_ids.append(np.full(bound.sum(), group[b], dtype=np.int64))
    model.train()
    out = {
        "feat": np.concatenate(feats),
        "mode": np.concatenate(modes),
        "kind": np.concatenate(kinds),
        "ttl": np.concatenate(ttls),
        "visible": np.concatenate(visibles),
        "episode": np.concatenate(ep_ids),
    }
    out["flagship"] = np.where(out["mode"] == sleeper_mode, 1,
                               np.where(out["mode"] == knocked_mode, 0, -1))
    return out


# ---- the probes ----

def _standardise(train: np.ndarray, test: np.ndarray):
    mu, sd = train.mean(0), train.std(0) + 1e-6
    return (train - mu) / sd, (test - mu) / sd


def probe_classify(x_tr, y_tr, x_te, y_te, n_classes: int, device,
                   epochs: int = 200, lr: float = 1e-2) -> float:
    """Multinomial logistic regression; returns macro-F1 on the test split."""
    x_tr, x_te = _standardise(x_tr, x_te)
    xt = torch.from_numpy(x_tr).float().to(device)
    yt = torch.from_numpy(y_tr).long().to(device)
    lin = nn.Linear(xt.shape[1], n_classes).to(device)
    opt = torch.optim.Adam(lin.parameters(), lr=lr, weight_decay=1e-4)
    # Class-balanced: the metric is macro-F1, so a probe must not be able to buy
    # its score with the majority class (knocked outnumbers sleeper ~5:1).
    counts = np.bincount(y_tr, minlength=n_classes).astype(np.float64)
    weight = torch.from_numpy(len(y_tr) / np.maximum(counts, 1) / n_classes).float().to(device)
    loss_fn = nn.CrossEntropyLoss(weight=weight)
    for _ in range(epochs):
        opt.zero_grad(set_to_none=True)
        loss_fn(lin(xt), yt).backward()
        opt.step()
    with torch.no_grad():
        pred = lin(torch.from_numpy(x_te).float().to(device)).argmax(-1).cpu().numpy()
    f1s = []
    for c in range(n_classes):
        tp = int(((pred == c) & (y_te == c)).sum())
        if (y_te == c).any():
            p = tp / max(1, int((pred == c).sum()))
            r = tp / int((y_te == c).sum())
            f1s.append(0.0 if tp == 0 else 2 * p * r / (p + r))
    return float(np.mean(f1s))


def probe_ridge(x_tr, y_tr, x_te, y_te, lam: float = 1e-2) -> float:
    """Ridge regression on log1p(target); returns R^2 on the test split."""
    x_tr, x_te = _standardise(x_tr, x_te)
    y_tr, y_te = np.log1p(y_tr), np.log1p(y_te)
    x = np.hstack([x_tr, np.ones((len(x_tr), 1))]).astype(np.float64)
    a = x.T @ x + lam * np.eye(x.shape[1])
    w = np.linalg.solve(a, x.T @ y_tr.astype(np.float64))
    pred = np.hstack([x_te, np.ones((len(x_te), 1))]) @ w
    ss_res = float(((y_te - pred) ** 2).sum())
    ss_tot = float(((y_te - y_te.mean()) ** 2).sum()) + 1e-12
    return 1.0 - ss_res / ss_tot


MIN_SAMPLES = 200  # below this a probe prints n/a rather than a number


def run_probes(data: dict[str, np.ndarray], device, holdout_frac: float = 0.25) -> dict:
    """Every (question x read-point x visibility) cell, split by episode."""
    eps = np.unique(data["episode"])
    test_eps = set(eps[int(len(eps) * (1 - holdout_frac)):].tolist())
    in_test = np.isin(data["episode"], list(test_eps))
    reads = {"feat": data["feat"], "mem": data["feat"][:, 48:]}

    report: dict = {"samples": int(len(data["feat"])), "episodes": len(eps)}
    for vis_name, vis_mask in [("visible", data["visible"]), ("held", ~data["visible"])]:
        cell: dict = {}
        for read_name, x in reads.items():
            entry: dict = {}
            for question, y, kind in [
                ("kind", data["kind"], "cls9"),
                ("flagship", data["flagship"], "cls2"),
                ("ttl", data["ttl"], "reg"),
            ]:
                if question == "flagship":
                    keep = vis_mask & (y >= 0)
                elif question == "ttl":
                    # Anomalous pandas only, and ttl >= 0: a -1 is the recorder's
                    # "ends with the episode" sentinel, not a duration.
                    keep = vis_mask & (data["kind"] != KIND_NONE) & (y >= 0)
                else:
                    keep = vis_mask
                tr = keep & ~in_test
                te = keep & in_test
                if tr.sum() < MIN_SAMPLES or te.sum() < MIN_SAMPLES // 4:
                    entry[question] = {"n": int(keep.sum()), "score": None}
                    continue
                if kind == "reg":
                    score = probe_ridge(x[tr], y[tr], x[te], y[te])
                else:
                    n_cls = 9 if kind == "cls9" else 2
                    score = probe_classify(x[tr], y[tr], x[te], y[te], n_cls, device)
                entry[question] = {"n": int(keep.sum()), "score": round(float(score), 4)}
            cell[read_name] = entry
        report[vis_name] = cell
    return report


# ---- checkpoints ----

def load_model(path: Path, device) -> SlotNet:
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    if ckpt.get("arch") != "slotnet":
        raise ValueError(f"{path} is not a slotnet checkpoint")
    model = SlotNet(SlotConfig.load(ckpt["cfg"])).to(device)
    model.load_state_dict(ckpt["model"])
    return model


def untrained_twin(device, seed: int = 20260728) -> SlotNet:
    torch.manual_seed(seed)
    return SlotNet(SlotConfig()).to(device)


def fmt(entry: dict) -> str:
    return "  ".join(
        f"{q} {v['score']:+.3f}" if v["score"] is not None else f"{q}   n/a "
        for q, v in entry.items())


def print_report(name: str, rep: dict) -> None:
    print(f"  {name} ({rep['samples']:,} samples, {rep['episodes']} eps)")
    for vis in ("visible", "held"):
        for read in ("feat", "mem"):
            print(f"    {vis:<8} {read:<5} {fmt(rep[vis][read])}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", default=str(HERE / "runs" / "warmstart-slot" / "best.pt"))
    p.add_argument("--sweep", default="", help="probe every ckpt-*.pt in a run dir instead")
    p.add_argument("--corpus", default=str(CORPORA / "eval-natural.manifest.json"))
    p.add_argument("--episodes", type=int, default=16)
    p.add_argument("--stride", type=int, default=2, help="sample every n-th decision")
    p.add_argument("--seed", type=int, default=20260728)
    p.add_argument("--device", default="auto")
    p.add_argument("--out", default="", help="report path (default: beside the checkpoint)")
    args = p.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = pick_device(args.device)
    corpus = Corpus(args.corpus)
    episodes = list(range(args.episodes))
    print(f"corpus {corpus}\ndevice {device}")

    if args.sweep:
        run_dir = Path(args.sweep)
        paths = sorted(run_dir.glob("ckpt-*.pt"),
                       key=lambda q: int(re.search(r"(\d+)M", q.name).group(1)))
        if not paths:
            raise FileNotFoundError(f"no ckpt-*.pt in {run_dir}")
    else:
        paths = [Path(args.checkpoint)]

    t0 = time.time()
    reports = {}
    twin = untrained_twin(device, args.seed)
    reports["untrained"] = run_probes(collect(twin, corpus, episodes, device, args.stride), device)
    print_report("untrained twin (the reservoir baseline)", reports["untrained"])
    for path in paths:
        data = collect(load_model(path, device), corpus, episodes, device, args.stride)
        reports[path.name] = run_probes(data, device)
        print_report(path.name, reports[path.name])

    out = Path(args.out) if args.out else (
        (Path(args.sweep) if args.sweep else paths[0].parent) / "probes.json")
    out.write_text(json.dumps({
        "corpus": corpus.manifest["name"], "episodes": args.episodes,
        "stride": args.stride, "seed": args.seed, "reports": reports,
    }, indent=2) + "\n")
    print(f"\nwrote {out} in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
