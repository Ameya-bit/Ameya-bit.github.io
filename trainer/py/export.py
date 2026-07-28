"""Exporting the clone to the browser: one binary blob, one JSON manifest.

    uv run python export.py --checkpoint runs/bc/checkpoint.pt

## The format

`policy.bin` is every tensor concatenated, little-endian, no framing. `policy.json`
says what is where — shapes, offsets, dtype — plus the config the JS forward pass
needs and the fingerprints that say which sim and which sensor this policy was
trained against. Same reasoning as a corpus manifest: the readable file is the
authority and the bytes are addressed by it, never the other way round.

**Weights ship as float16, and the rounding happens here, before anything else.**
475 KB of float32 is over the plan's ~400 KB wire budget; float16 is 238 KB. So the
checkpoint is rounded to float16 *and the rounded values are what both sides run* —
the reference logits for the parity gate are produced by re-loading this file, not by
the unrounded checkpoint. Quantisation error therefore never shows up as a JS-vs-
PyTorch disagreement, because there is nothing left to disagree about: the exported
file is the model, and Python and JS are two readers of it.

**Linear weights keep PyTorch's `[out, in]` layout.** That is already the transpose
the JS kernel wants — it walks one output's weights contiguously and accumulates a
dot product, which measured 40% faster than the scatter-accumulate form. So the
export is a straight copy and no reshaping happens on either side.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from model import PandaNet, Config

HERE = Path(__file__).parent
FORMAT_VERSION = 1


def tensor_order(model: PandaNet) -> list[tuple[str, torch.Tensor]]:
    """Every parameter, in a fixed, readable order.

    Explicit rather than `state_dict()` order so that adding a parameter is a visible
    edit here and in `net.js` at once, instead of a silent renumbering of offsets.
    """
    cfg = model.cfg
    out: list[tuple[str, torch.Tensor]] = [
        ("embed.weight", model.embed.weight),
        ("embed.bias", model.embed.bias),
        ("pos", model.pos),
    ]
    for i in range(cfg.n_layers):
        b = model.blocks[i]
        out += [
            (f"block.{i}.ln1.weight", b.ln1.weight),
            (f"block.{i}.ln1.bias", b.ln1.bias),
            (f"block.{i}.qkv.weight", b.qkv.weight),
            (f"block.{i}.qkv.bias", b.qkv.bias),
            (f"block.{i}.proj.weight", b.proj.weight),
            (f"block.{i}.proj.bias", b.proj.bias),
            (f"block.{i}.ln2.weight", b.ln2.weight),
            (f"block.{i}.ln2.bias", b.ln2.bias),
            (f"block.{i}.fc1.weight", b.fc1.weight),
            (f"block.{i}.fc1.bias", b.fc1.bias),
            (f"block.{i}.fc2.weight", b.fc2.weight),
            (f"block.{i}.fc2.bias", b.fc2.bias),
        ]
    out += [
        ("ln_f.weight", model.ln_f.weight),
        ("ln_f.bias", model.ln_f.bias),
        ("head.weight", model.head.weight),
        ("head.bias", model.head.bias),
    ]
    return out


def quantise(model: PandaNet) -> None:
    """Round every parameter to float16 and back, in place.

    After this the model in memory holds exactly the values the browser will load, so
    anything measured from here on is a measurement of the shipped policy.
    """
    with torch.no_grad():
        for _, t in tensor_order(model):
            t.copy_(t.to(torch.float16).to(torch.float32))


def export(model: PandaNet, out_dir: Path, *, meta: dict) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    tensors, chunks, offset = [], [], 0
    for name, t in tensor_order(model):
        arr = t.detach().cpu().numpy().astype(np.float16)
        tensors.append({
            "name": name,
            "shape": list(arr.shape),
            "offset": offset,      # in elements, not bytes
            "count": int(arr.size),
        })
        chunks.append(arr.ravel())
        offset += int(arr.size)

    blob = np.concatenate(chunks).astype("<f2")
    (out_dir / "policy.bin").write_bytes(blob.tobytes())

    manifest = {
        "format": FORMAT_VERSION,
        "dtype": "float16",
        "elements": int(blob.size),
        "bytes": int(blob.nbytes),
        "digest": hashlib.sha256(blob.tobytes()).hexdigest()[:16],
        "config": model.cfg.dict(),
        "tensors": tensors,
        **meta,
    }
    (out_dir / "policy.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def load_exported(out_dir: Path) -> tuple[PandaNet, dict]:
    """Rebuild the model from the exported pair — the reference side of the gate.

    Reading back what was written, rather than trusting the in-memory model, is what
    makes "the exported file is the model" a checkable claim instead of a comment.
    """
    manifest = json.loads((out_dir / "policy.json").read_text())
    blob = np.fromfile(out_dir / "policy.bin", dtype="<f2").astype(np.float32)
    if blob.size != manifest["elements"]:
        raise ValueError(f"policy.bin has {blob.size} elements, manifest says {manifest['elements']}")

    model = PandaNet(Config(**manifest["config"]))
    by_name = dict(tensor_order(model))
    with torch.no_grad():
        for spec in manifest["tensors"]:
            chunk = blob[spec["offset"] : spec["offset"] + spec["count"]]
            by_name[spec["name"]].copy_(torch.from_numpy(chunk.reshape(spec["shape"]).copy()))
    model.eval()
    return model, manifest


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint", default=str(HERE / "runs" / "bc" / "checkpoint.pt"))
    p.add_argument("--corpus", default=str(HERE.parent / "corpora" / "train-bc.manifest.json"))
    p.add_argument("--out", default=str(HERE.parent.parent / "assets" / "pandas" / "engine" / "policy" / "weights"))
    args = p.parse_args()

    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    model = PandaNet(Config(**ckpt["cfg"]))
    model.load_state_dict(ckpt["model"])
    model.eval()

    before = {n: t.detach().clone() for n, t in tensor_order(model)}
    quantise(model)
    with torch.no_grad():
        worst = max(float((before[n] - t).abs().max()) for n, t in tensor_order(model))

    corpus = json.loads(Path(args.corpus).read_text())
    manifest = export(model, Path(args.out), meta={
        "trainedOn": corpus["name"],
        "step": int(ckpt.get("step", -1)),
        # The decision-delay contract this policy was trained under (data.py). The
        # page's worker driver runs delay=1 by construction; recording what the
        # weights expect is what makes a mismatch a visible warning, not a mystery.
        "delay": int(ckpt.get("delay", 0)),
        # What this policy is only valid against. The sensor is the important one:
        # the observation layout is what the first matrix multiplies.
        "engine": corpus["engine"],
        "encoder": corpus["encoder"],
        "observation": corpus["observation"],
        "actions": corpus["actions"],
    })

    print(f"exported {len(manifest['tensors'])} tensors, {manifest['elements']:,} elements, "
          f"{manifest['bytes'] / 1024:.1f} KB  ({manifest['digest']})")
    print(f"  float16 rounding moved a weight by at most {worst:.2e}")
    print(f"  {args.out}/policy.bin + policy.json")


if __name__ == "__main__":
    main()
