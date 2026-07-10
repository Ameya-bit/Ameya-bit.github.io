"""Export niche_model.pt to a browser-friendly bundle for the "ask Niche" widget.

Produces two files in OUT_DIR:
  niche-web.bin   — all weights as little-endian fp16, concatenated
  niche-web.json  — manifest: config, tokenizer (stoi/itos), tensor table
                    (name/shape/offset), and parity test vectors

Parity vectors are computed with the weights round-tripped through fp16 first,
so the JS engine (fp32 math over fp16-stored weights) can match them tightly.

Usage:
  /Users/ameya/mech_interp/Niche/venv/bin/python export_niche_web.py [OUT_DIR]
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch

NICHE_ROOT = Path("/Users/ameya/mech_interp/Niche")
sys.path.insert(0, str(NICHE_ROOT / "interp"))

from niche_classes import load_model  # noqa: E402

PARITY_PROMPT = "The abyss gazes also into you, and the "
PARITY_GREEDY_CHARS = 60


def fp16_roundtrip_(model: torch.nn.Module) -> None:
    """Round every parameter through fp16 in place (matches what the JS sees)."""
    with torch.no_grad():
        for p in model.parameters():
            p.copy_(p.to(torch.float16).to(torch.float32))


def greedy_continuation(lm, prompt: str, n_chars: int) -> str:
    idx = lm.encode(prompt)
    block = lm.config.block_size
    for _ in range(n_chars):
        logits, _ = lm.model(idx[:, -block:])
        next_tok = logits[0, -1].argmax().view(1, 1)
        idx = torch.cat((idx, next_tok), dim=1)
    return lm.decode(idx[0, len(prompt):])


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("niche-web-out")
    out_dir.mkdir(parents=True, exist_ok=True)

    lm = load_model(str(NICHE_ROOT / "niche_model.pt"))
    fp16_roundtrip_(lm.model)

    tensor_table = []
    chunks = []
    offset = 0
    for name, tensor in lm.model.state_dict().items():
        if name.endswith(".mask"):
            continue  # causal-mask buffer; the JS engine implies causality
        arr = tensor.detach().cpu().numpy().astype("<f2")
        tensor_table.append({"name": name, "shape": list(arr.shape), "offset": offset})
        chunks.append(arr.tobytes())
        offset += arr.nbytes

    itos_list = [lm.itos[i] for i in range(lm.config.vocab_size)]

    with torch.no_grad():
        logits, _ = lm.model(lm.encode(PARITY_PROMPT))
        last_logits = [round(float(v), 5) for v in logits[0, -1]]
    greedy = greedy_continuation(lm, PARITY_PROMPT, PARITY_GREEDY_CHARS)

    manifest = {
        "config": {
            "vocab_size": lm.config.vocab_size,
            "n_embd": lm.config.n_embd,
            "n_head": lm.config.n_head,
            "n_layers": lm.config.n_layers,
            "block_size": lm.config.block_size,
        },
        "val_loss": lm.val_loss,
        "itos": itos_list,
        "tensors": tensor_table,
        "parity": {
            "prompt": PARITY_PROMPT,
            "last_logits": last_logits,
            "greedy": greedy,
            "greedy_chars": PARITY_GREEDY_CHARS,
        },
    }

    bin_path = out_dir / "niche-web.bin"
    bin_path.write_bytes(b"".join(chunks))
    json_path = out_dir / "niche-web.json"
    json_path.write_text(json.dumps(manifest))

    total_mb = bin_path.stat().st_size / 1e6
    n_params = sum(int(np.prod(t["shape"])) for t in tensor_table)
    print(f"wrote {bin_path} ({total_mb:.1f} MB, {n_params/1e6:.2f}M params fp16)")
    print(f"wrote {json_path} ({json_path.stat().st_size/1e3:.0f} kB)")
    print(f"parity prompt: {PARITY_PROMPT!r}")
    print(f"greedy continuation: {greedy!r}")


if __name__ == "__main__":
    main()
