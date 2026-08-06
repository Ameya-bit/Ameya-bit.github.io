"""Recompute every number the induction-head post shows, and cache it here.

Run with the Niche repo's venv (it has torch and the model):

    ~/mech_interp/Niche/venv/bin/python compute.py

Everything below is lifted from `interp/figures/make_figures.py` in
github.com/Ameya-bit/Niche, which in turn lifted it verbatim from
`niche_attention_analysis.ipynb` — same weights, same eigenvalue truncation,
same prompts — so this cache is a faithful replay rather than a second
experiment. `plot.py` reads `_data.npz` and needs only numpy + matplotlib,
which is what lets the figures be restyled without loading a model at all.

Two things are computed here that the original script drew straight into a PNG:
the verdict tables. They are written to `_data.json` and rendered as real HTML
tables by `plot.py`, because a table of characters, positions and weights is
text, and text baked into a 2210px image is unselectable, unsearchable,
unreadable to a screen reader, and illegible at the column width it displays at.
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).parent
NICHE = Path(os.environ.get("NICHE_REPO", Path.home() / "mech_interp" / "Niche"))

sys.path.insert(0, str(NICHE / "interp"))
from niche_classes import load_model  # noqa: E402

m = load_model(str(NICHE / "niche_model.pt"), map_location="cpu")

BLOCK, HEAD = 5, 0  # B5H0 — the head the whole post is about


# ---------------------------------------------------------------------------
# Analysis functions — verbatim from the notebook.
# ---------------------------------------------------------------------------

def independent_weights(attention_block, attention_head):
    w_e = m.model.token_embedding.weight.transpose(-1, -2).detach()
    w_u = m.model.last_layer.weight.detach()
    qkv = m.model.blocks[attention_block].comp_full_attend.qkv.weight.detach()
    q, k, v = tuple(t.view(m.config.n_head, m.config.n_embd // m.config.n_head, -1).detach()
                    for t in qkv.split(m.config.n_embd))
    w_o = torch.stack(m.model.blocks[attention_block].comp_full_attend.lin_proj.weight.split(
        m.config.n_embd // m.config.n_head, dim=-1)).detach()
    return w_e, w_u, q, k, v, w_o


def identify_copying_ov(w_u, w_o, v, w_e, attention_block, attention_head):
    w_ov_h = w_u @ w_o[attention_head] @ v[attention_head] @ w_e
    w_ov_h_eigen = torch.linalg.eig(w_ov_h)
    w_ov_h_rank = m.config.n_embd // m.config.n_head
    ov_evalues = w_ov_h_eigen.eigenvalues
    ov_evalues_mag = torch.abs(ov_evalues)
    ov_evalues_indsort = torch.argsort(ov_evalues_mag, descending=True)
    ov_evalues_sorted = ov_evalues[ov_evalues_indsort][:w_ov_h_rank]
    copying_score = sum(ov_evalues_sorted.real) / sum(torch.abs(ov_evalues_sorted))
    return float(copying_score.real)


def identify_copying_qk(attention_block, attention_head, sentence, token, iterate):
    chars = [i for i, s in enumerate(sentence) if s == token]
    idx = torch.tensor([[m.stoi[c] for c in sentence]])
    with torch.no_grad():
        m.model(idx, store_attn=True)
    A = torch.squeeze(m.model.blocks[attention_block].comp_full_attend.attn_weights[:, attention_head])
    q = chars[iterate]
    topk = torch.topk(A[q], 5)
    ranked = [(p, sentence[p], round(w, 4))
              for p, w in zip(topk.indices.tolist(), topk.values.tolist())]
    return q, chars, ranked, A


def case(label, sentence, token, iterate=-1):
    """`run_case` from the notebook, returning a record instead of printing."""
    q, occs, ranked, A = identify_copying_qk(BLOCK, HEAD, sentence, token, iterate)
    targets = {p + 1 for p in occs if p < q}
    amax_pos, _, _ = ranked[0]
    verdict = ("induction" if amax_pos in targets else
               "previous-token" if amax_pos == q - 1 else
               "sink" if amax_pos <= 1 else "other")
    return {
        "label": label, "sentence": sentence, "q": q, "query_char": sentence[q],
        "verdict": verdict, "ranked": [list(r) for r in ranked[:3]],
    }


# ---------------------------------------------------------------------------
# FIG 1 — the OV diagonal, raw and norm-normalized.
# ---------------------------------------------------------------------------

w_e, w_u, _, _, v, w_o = independent_weights(BLOCK, HEAD)
w_ov_h = w_u @ w_o[HEAD] @ v[HEAD] @ w_e
norms = torch.linalg.norm(w_u, dim=1) * torch.linalg.norm(w_e, dim=0)
ov_raw = torch.diagonal(w_ov_h).numpy()
ov_normed = (torch.diagonal(w_ov_h) / norms).numpy()
itos = np.array([m.itos[i] for i in range(m.config.vocab_size)], dtype=object)

# Rank of every token by normalized self-copy logit, 1 = most copied. The post
# quotes '(' and ')' ranks out of the full vocabulary, so they are derived here
# rather than typed into a caption where they could go stale.
ov_rank = (-ov_normed).argsort().argsort() + 1

# ---------------------------------------------------------------------------
# FIG 2 — copying score for all 24 heads.
# ---------------------------------------------------------------------------

head_labels, copying_scores = [], []
for b in range(m.config.n_layers):
    for h in range(m.config.n_head):
        we, wu, _, _, vv, wo = independent_weights(b, h)
        head_labels.append(f"B{b}H{h}")
        copying_scores.append(identify_copying_ov(wu, wo, vv, we, b, h))

# ---------------------------------------------------------------------------
# FIG 3 — the content-swap pair: the induction cell tracks the swapped token.
# ---------------------------------------------------------------------------

panels = {}
for key, (sent, tok) in {"cat": ("the cat sat on the mat, the cat ran", "c"),
                         "dog": ("the dog sat on the mat, the dog ran", "d")}.items():
    q, occs, _, A = identify_copying_qk(BLOCK, HEAD, sent, tok, iterate=1)
    panels[key] = dict(A=A.numpy(), sentence=sent, q=q, target=occs[0] + 1)

# ---------------------------------------------------------------------------
# The two verdict tables. P1–P5 test quote grammar, P6–C8 parenthesis grammar.
# ---------------------------------------------------------------------------

quote_cases = [
    case("P1-A xylophone", 'The man said, "xylophone do I write?". He then spoke, "Grashoper', '"'),
    case("P1-B what",      'The man said, "what do I write?". He then spoke, "Grashoper', '"'),
    case("P2-A cat", 'the cat sat on the mat, the cat ran', 'c', iterate=1),
    case("P2-B dog", 'the dog sat on the mat, the dog ran', 'd', iterate=1),
    case("P3-A repeat", 'Zarathustra spoke. Later, Zarathustra', 'Z', iterate=1),
    # The sole Z sits mid-string with real prior context, so a sink verdict is a
    # meaningful null — the head declines to fire absent an earlier match, rather
    # than the degenerate first-token case where pos 0 can only attend to itself.
    case("P3-B norepeat", 'the crowd below heard Zarathustra', 'Z', iterate=0),
    case("P4-A apple-last",  '"apple" ... "banana" ... "apple', '"'),
    case("P4-B banana-last", '"banana" ... "apple" ... "banana', '"'),
    case("P5-A prior-opens", 'He said "one. She said "two. He said "', '"'),
    case("P5-B prior-closes", 'one" and two" and three" and', '"'),
]

paren_cases = [
    case("P6-A paren-succ",  'x(ab x(cd', 'x'),
    case("P6-B letter-succ", 'xzab xzcd', 'x'),
    case("P7-A unmatched", 'So (the cat naps',  's'),
    case("P7-B matched",   'So (the cat) naps', 's'),
    case("C8 open-vs-closed", 'A (B (C) D', 'D'),
]

np.savez_compressed(
    HERE / "_data.npz",
    itos=itos, ov_raw=ov_raw, ov_normed=ov_normed, ov_rank=ov_rank,
    head_labels=np.array(head_labels), copying_scores=np.array(copying_scores),
    cat_A=panels["cat"]["A"], dog_A=panels["dog"]["A"],
    cat_meta=np.array([panels["cat"]["sentence"], panels["cat"]["q"], panels["cat"]["target"]], dtype=object),
    dog_meta=np.array([panels["dog"]["sentence"], panels["dog"]["q"], panels["dog"]["target"]], dtype=object),
)
(HERE / "_data.json").write_text(json.dumps(
    {"quote": quote_cases, "paren": paren_cases}, indent=1) + "\n")

print(f"cached {len(head_labels)} head scores, {len(itos)} vocab entries, "
      f"{len(quote_cases) + len(paren_cases)} verdict rows")
