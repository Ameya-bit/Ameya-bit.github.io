"""The parity fixture: real frames, and the logits PyTorch produces for them.

    uv run python reference.py

Writes `trainer/parity/parity-fixture.json` — windows taken from the eval corpus,
paired with the exported model's logits. `engine/test/net.test.js` replays them
through the JS forward pass and compares. That is the Phase-D exit criterion made
checkable: **action agreement JS vs PyTorch > 99.9%**.

The parity artefacts live under `trainer/parity/`, NOT beside the weights: _quarto.yml
lists assets/pandas/ as a site resource, so anything written there is copied into
`_site` by a local render — and the bulk arrays are 128 MB of test fixture nobody's
browser should ever be offered. Only `policy.bin` + `policy.json` belong under assets.

Two decisions about what "parity" means here.

**The reference comes from the exported file, not the checkpoint.** `export.py` rounds
to float16 and the browser loads those halves; if the reference were produced by the
unrounded model, quantisation error would show up as a JS bug and be chased as one.
Re-loading the export makes the two sides readers of one artefact.

**Agreement is statistical, and that is the honest bar rather than a concession.**
Both sides do the same arithmetic in a different order — PyTorch's GEMM blocks and
reduces differently from a scalar dot product, and float addition is not associative
— so logits agree to ~1e-6 and an argmax whose top two are within that will
occasionally flip. What matters is that flips are rare and confined to near-ties,
which the fixture reports rather than hides: it carries the logit gap at every
disagreement so a real bug (which moves logits by far more than 1e-6) cannot look
like a tie.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from corpus import Corpus
from data import stack_windows
from export import load_exported

HERE = Path(__file__).parent
WEIGHTS = HERE.parent.parent / "assets" / "pandas" / "engine" / "policy" / "weights"
PARITY = HERE.parent / "parity"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--corpus", default=str(HERE.parent / "corpora" / "eval-bc.manifest.json"))
    p.add_argument("--weights", default=str(WEIGHTS))
    p.add_argument("--out", default=str(PARITY), help="where the parity artefacts land")
    p.add_argument("--cases", type=int, default=64, help="frames written to the fixture")
    p.add_argument("--episodes", type=int, default=4)
    p.add_argument("--agreement", type=int, default=20000, help="frames for the agreement figure")
    args = p.parse_args()

    model, manifest = load_exported(Path(args.weights))
    corpus = Corpus(args.corpus)
    frames = manifest["config"]["frames"]

    # A spread of real decisions rather than the first N: the opening seconds of an
    # episode are the entrance, where nothing is happening and every frame is alike.
    rng = np.random.default_rng(7)
    xs, ys, eps, rows = [], [], [], []
    for ep in range(args.episodes):
        obs, act = corpus.episode(ep)
        idx = np.sort(rng.choice(len(act), size=args.cases // args.episodes, replace=False))
        xs.append(stack_windows(obs, idx, frames))
        ys.append(act[idx])
        eps += [ep] * len(idx)
        rows += idx.tolist()
    x = np.concatenate(xs)
    y = np.concatenate(ys)

    with torch.no_grad():
        logits = model(torch.from_numpy(x)).numpy()

    fixture = {
        "note": "windows from the eval corpus and the exported model's logits for them",
        "corpus": corpus.manifest["name"],
        "weights": {"digest": manifest["digest"], "bytes": manifest["bytes"]},
        "config": manifest["config"],
        "cases": [
            {
                "episode": int(eps[i]),
                "row": int(rows[i]),
                "expert": int(y[i]),
                # (frames, tokens, width), most recent frame first — the layout
                # `makeNet().forward` receives as its ring buffer.
                "frames": [[round(float(v), 7) for v in tok] for f in x[i] for tok in f],
                "logits": [float(v) for v in logits[i]],
            }
            for i in range(len(y))
        ],
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "parity-fixture.json"
    out.write_text(json.dumps(fixture) + "\n")
    kb = out.stat().st_size / 1024
    print(f"wrote {out.name}: {len(fixture['cases'])} cases, {kb:.0f} KB")

    # …and a much larger agreement figure, which is too big to commit but is the
    # number the exit criterion actually asks about.
    big_x, big_y = [], []
    for ep in range(args.episodes, args.episodes + 4):
        obs, act = corpus.episode(ep)
        idx = np.arange(0, len(act), max(1, len(act) // (args.agreement // 4)))
        big_x.append(stack_windows(obs, idx, frames))
        big_y.append(act[idx])
    bx = np.concatenate(big_x)
    with torch.no_grad():
        big_logits = np.concatenate([
            model(torch.from_numpy(bx[i : i + 4096])).numpy() for i in range(0, len(bx), 4096)
        ])
    # Raw little-endian float32, same reasoning as a corpus shard: the loader on the
    # other side should be one read and a reshape, not an .npy header parser.
    d = out_dir
    bx.astype("<f4").tofile(d / "parity-frames.f32")
    big_logits.astype("<f4").tofile(d / "parity-logits.f32")
    (d / "parity-bulk.json").write_text(json.dumps({
        "frames": list(bx.shape),
        "logits": list(big_logits.shape),
        "expert": [int(v) for v in np.concatenate(big_y)],
        "weights": manifest["digest"],
    }) + "\n")
    print(f"wrote parity-frames.f32 / parity-logits.f32: {len(bx):,} frames "
          f"(gitignored — the committed fixture is the {len(fixture['cases'])}-case one)")


if __name__ == "__main__":
    main()
