"""Recompute every number the IOI post plots, and cache it to `_data.npz`.

Run with the IOI repo's venv (it has transformer_lens + torch):

    ~/mech_interp/IOI/.venv/bin/python compute.py

Everything here is lifted from the four notebooks in github.com/Ameya-bit/IOI —
same dataset, same metric, same hooks — so the cache is a faithful replay rather
than a second experiment. `plot.py` reads the cache and needs only numpy +
matplotlib, which is what lets the figures be restyled without a GPU-less CPU
rerun of 2,000 forward passes.

One deliberate change from the notebooks: direct logit attribution is computed
on the SAME templated 100-prompt set as the two patching sweeps, instead of on
transformer_lens's own IOIDataset. Three methods compared against each other
have to be measured on one dataset or the comparison is not a comparison.
"""

import random
from functools import partial

import numpy as np
import torch
from transformer_lens.model_bridge import TransformerBridge

# ---------------------------------------------------------------------------
# Dataset — verbatim from the notebooks. Every prompt is the same template with
# single-token names/places/objects swapped in, so all 100 tokenize to 15 tokens
# and token positions stay aligned across the batch. That alignment is what lets
# the patching sweeps average into one (layer, position) grid.
# ---------------------------------------------------------------------------

NAMES = [
    "Mary", "John", "Tom", "James", "Dan", "Sid", "Martin", "Amy", "Anna", "Mark",
    "Paul", "Sarah", "Kevin", "Alex", "Bob", "Sam", "Jack", "Emma", "Lisa", "Mike",
    "Steve", "Adam", "Nick", "Jenny", "Peter", "Karen", "David", "Susan", "Frank", "Grace",
    "Henry", "Julia", "Kate", "Laura", "Nancy", "Oscar", "Rachel", "Simon", "Victor", "Walter",
    "Zoe", "Brian", "Carol", "Diana", "Eric", "Fiona", "George", "Helen", "Ian", "Jane",
    "Luke", "Nina", "Owen", "Rick", "Tina", "Wendy", "Josh", "Ryan", "Sean", "Neil",
    "Carl", "Roger", "Ralph", "Scott", "Craig", "Keith", "Gary", "Larry", "Terry",
]
PLACES = [
    "store", "park", "school", "hospital", "office", "garden", "restaurant", "station",
    "market", "library", "beach", "museum", "bar", "cafe", "gym", "hotel", "zoo", "farm",
    "church", "bank",
]
OBJECTS = [
    "drink", "ring", "kiss", "bone", "basketball", "computer", "necklace", "snack", "book",
    "ball", "pen", "cup", "gift", "note", "card", "coat", "hat", "key", "phone", "apple",
    "banana", "rose",
]

IOI_TEMPLATE = "When {io} and {s} went to the {place}, {subj} gave a {obj} to"

CANONICAL = {
    "prompt":     "When Mary and John went to the store, John gave a drink to",
    "answer":     "Mary",
    "distractor": "John",
    "corrupted":  "When Mary and John went to the store, Mary gave a drink to",
}


def build_ioi_dataset(n=100, seed=0):
    """n length-matched IOI examples: {prompt, corrupted, answer, distractor}."""
    rng = random.Random(seed)
    examples, seen = [], set()
    while len(examples) < n:
        io, s = rng.sample(NAMES, 2)
        place, obj = rng.choice(PLACES), rng.choice(OBJECTS)
        key = (io, s, place, obj)
        if key in seen:
            continue
        seen.add(key)
        examples.append({
            "prompt":    IOI_TEMPLATE.format(io=io, s=s, place=place, subj=s,  obj=obj),
            "corrupted": IOI_TEMPLATE.format(io=io, s=s, place=place, subj=io, obj=obj),
            "answer": io,
            "distractor": s,
        })
    return examples


DATASET = [CANONICAL] + [
    ex for ex in build_ioi_dataset(n=140, seed=0)
    if (ex["answer"], ex["distractor"]) != ("Mary", "John")
][:99]

print(f"dataset: {len(DATASET)} prompts")

model = TransformerBridge.boot_transformers("gpt2", device="cpu")
model.enable_compatibility_mode()

N_LAYERS, N_HEADS = model.cfg.n_layers, model.cfg.n_heads


def make_batch(chunk):
    """Tokenize a list of examples into aligned batch tensors (no padding)."""
    clean = torch.cat([model.to_tokens(d["prompt"]) for d in chunk], dim=0)
    corr = torch.cat([model.to_tokens(d["corrupted"]) for d in chunk], dim=0)
    assert clean.shape == corr.shape
    io = torch.tensor([model.to_single_token(" " + d["answer"]) for d in chunk])
    s = torch.tensor([model.to_single_token(" " + d["distractor"]) for d in chunk])
    return clean, corr, io, s


def logit_diff(logits, io_toks, s_toks):
    """Per-example (IO - S) at the final position -> [batch]."""
    final = logits[:, -1, :]
    idx = torch.arange(final.size(0))
    return final[idx, io_toks] - final[idx, s_toks]


# ---------------------------------------------------------------------------
# 1. Baselines and direct logit attribution
# ---------------------------------------------------------------------------

@torch.no_grad()
def baselines_and_dla(dataset, batch_size=20):
    """Mean clean/corrupted logit diff, accuracy, and mean per-head DLA [144]."""
    dla = torch.zeros(N_LAYERS * N_HEADS)
    clean_total = corr_total = 0.0
    n_correct = 0

    # `apply_ln_to_stack` reads the final LayerNorm scale out of the cache, so the
    # filter has to let it through alongside the head outputs.
    dla_hooks = lambda name: name.endswith("attn.hook_z") or name == "ln_final.hook_scale"

    for start in range(0, len(dataset), batch_size):
        chunk = dataset[start:start + batch_size]
        clean_tokens, corr_tokens, io_toks, s_toks = make_batch(chunk)

        clean_logits, cache = model.run_with_cache(clean_tokens, names_filter=dla_hooks)
        ld = logit_diff(clean_logits, io_toks, s_toks)
        clean_total += ld.sum().item()
        n_correct += (ld > 0).sum().item()
        del clean_logits

        corr_total += logit_diff(model(corr_tokens), io_toks, s_toks).sum().item()

        # Each head's write into the residual stream at the answer position,
        # pushed through W_O, LayerNorm-scaled, projected on (IO - S).
        contribs = []
        for layer in range(N_LAYERS):
            z = cache[f"blocks.{layer}.attn.hook_z"][:, -1]       # [batch, head, d_head]
            for head in range(N_HEADS):
                contribs.append(z[:, head] @ model.W_O[layer, head])   # [batch, d_model]
        contribs = torch.stack(contribs)                          # [144, batch, d_model]
        contribs = cache.apply_ln_to_stack(contribs, layer=-1, pos_slice=-1)

        # Per-example answer direction, then a per-head projection.
        answer_dir = model.W_U[:, io_toks] - model.W_U[:, s_toks]  # [d_model, batch]
        dla += torch.einsum("cbd,db->c", contribs, answer_dir)

        del cache
        print(f"  dla: {min(start + batch_size, len(dataset))}/{len(dataset)}")

    n = len(dataset)
    return clean_total / n, corr_total / n, n_correct / n, (dla / n)


# ---------------------------------------------------------------------------
# 2. Residual-stream patching over (layer, position)
# ---------------------------------------------------------------------------

@torch.no_grad()
def patch_resid_pre(dataset, batch_size=20):
    """Mean normalized recovery for each (layer, position) -> [n_layers, seq_len]."""
    seq_len = model.to_tokens(dataset[0]["prompt"]).size(1)
    totals = torch.zeros(N_LAYERS, seq_len)
    resid_only = lambda name: name.endswith("hook_resid_pre")

    def replace(activation, hook, pos, src):
        activation[:, pos, :] = clean_cache[src][:, pos, :]
        return activation

    for start in range(0, len(dataset), batch_size):
        chunk = dataset[start:start + batch_size]
        clean_tokens, corr_tokens, io_toks, s_toks = make_batch(chunk)

        clean_logits, clean_cache = model.run_with_cache(clean_tokens, names_filter=resid_only)
        clean_ld = logit_diff(clean_logits, io_toks, s_toks)
        del clean_logits
        corr_ld = logit_diff(model(corr_tokens), io_toks, s_toks)
        denom = clean_ld - corr_ld

        for layer in range(N_LAYERS):
            src = f"blocks.{layer}.hook_resid_pre"
            for pos in range(seq_len):
                patched = model.run_with_hooks(
                    corr_tokens, fwd_hooks=[(src, partial(replace, pos=pos, src=src))]
                )
                ld = logit_diff(patched, io_toks, s_toks)
                totals[layer, pos] += ((ld - corr_ld) / denom).sum()

        del clean_cache
        print(f"  resid: {min(start + batch_size, len(dataset))}/{len(dataset)}")

    return totals / len(dataset)


# ---------------------------------------------------------------------------
# 3. Attention-head patching at the END position
# ---------------------------------------------------------------------------

@torch.no_grad()
def patch_heads(dataset, layer_start=8, batch_size=20):
    """Mean normalized recovery for each (layer, head) at END -> [n_layers, n_heads].

    Rows below `layer_start` are left at zero (the single-prompt run put all the
    action at 8+, and skipping the bottom two thirds halves the runtime).
    """
    seq_len = model.to_tokens(dataset[0]["prompt"]).size(1)
    end = seq_len - 1
    totals = torch.zeros(N_LAYERS, N_HEADS)
    z_only = lambda name: name.endswith("attn.hook_z")

    def replace_head(activation, hook, head, src):
        activation[:, end, head, :] = clean_cache[src][:, end, head, :]
        return activation

    for start in range(0, len(dataset), batch_size):
        chunk = dataset[start:start + batch_size]
        clean_tokens, corr_tokens, io_toks, s_toks = make_batch(chunk)

        clean_logits, clean_cache = model.run_with_cache(clean_tokens, names_filter=z_only)
        clean_ld = logit_diff(clean_logits, io_toks, s_toks)
        del clean_logits
        corr_ld = logit_diff(model(corr_tokens), io_toks, s_toks)
        denom = clean_ld - corr_ld

        for layer in range(layer_start, N_LAYERS):
            src = f"blocks.{layer}.attn.hook_z"
            for head in range(N_HEADS):
                patched = model.run_with_hooks(
                    corr_tokens, fwd_hooks=[(src, partial(replace_head, head=head, src=src))]
                )
                ld = logit_diff(patched, io_toks, s_toks)
                totals[layer, head] += ((ld - corr_ld) / denom).sum()

        del clean_cache
        print(f"  heads: {min(start + batch_size, len(dataset))}/{len(dataset)}")

    return totals / len(dataset)


# ---------------------------------------------------------------------------
# 4. Path patching the S-inhibition -> name-mover edge (canonical prompt)
#
# Freeze every head and MLP to its clean value EXCEPT the sender (L8H6, set to
# corrupted), so the sender's effect propagates and nothing else moves. Grab what
# lands on block 9, then in a final clean run patch only that back in.
#
# THREE receivers, deliberately, because they are three different questions and
# the original writeup compared two of them as if they were one:
#
#   resid_pre  the whole residual-stream input to block 9. The sender reaches
#              layer 9's queries AND keys AND values, and everything layers 10
#              and 11 read as well. Broad; not an edge.
#   all q      every head in block 9, query side only.
#   L9H9 q     one head, query side only. This is the edge.
#
# Freezing everything but the sender is what turns a node measurement into an
# edge measurement; narrowing the receiver is what decides WHICH edge.
# ---------------------------------------------------------------------------

@torch.no_grad()
def path_patch():
    tokens = model.to_tokens(CANONICAL["prompt"])
    corr_tokens = model.to_tokens(CANONICAL["corrupted"])
    io = model.to_single_token(" " + CANONICAL["answer"])
    s = model.to_single_token(" " + CANONICAL["distractor"])

    def diff(logits):
        return (logits[0, -1, io] - logits[0, -1, s]).item()

    _, cache = model.run_with_cache(tokens)
    corr_logits, corr_cache = model.run_with_cache(corr_tokens)
    clean_base = diff(model(tokens))
    corr_base = diff(corr_logits)

    stash = {}

    def freeze_z(activation, hook):
        activation[...] = cache[hook.name]
        if hook.name == "blocks.8.attn.hook_z":
            activation[:, :, 6, :] = corr_cache[hook.name][:, :, 6, :]   # the sender
        return activation

    def freeze_mlp(activation, hook):
        activation[...] = cache[hook.name]
        return activation

    # In compatibility mode `hook.name` reports resid_pre as ".hook_in", so the
    # two receivers get their own grabbers rather than one keyed on hook.name.
    def grab_q(activation, hook):
        stash["q"] = activation.clone()          # [1, seq, head, d_head]
        return activation

    def grab_resid(activation, hook):
        stash["resid"] = activation.clone()      # [1, seq, d_model]
        return activation

    model.run_with_hooks(tokens, fwd_hooks=[
        (lambda n: n.endswith("attn.hook_z"), freeze_z),
        (lambda n: n.endswith("hook_mlp_out"), freeze_mlp),
        ("blocks.9.attn.hook_q", grab_q),
        ("blocks.9.hook_resid_pre", grab_resid),
    ])

    def patch_resid(activation, hook):
        activation[...] = stash["resid"]
        return activation

    def patch_all_q(activation, hook):
        activation[...] = stash["q"]
        return activation

    def patch_l9h9_q(activation, hook):
        activation[:, :, 9, :] = stash["q"][:, :, 9, :]
        return activation

    swing = clean_base - corr_base

    def recovered(hook_name, fn):
        patched = model.run_with_hooks(tokens, fwd_hooks=[(hook_name, fn)])
        return (clean_base - diff(patched)) / swing

    resid = recovered("blocks.9.hook_resid_pre", patch_resid)
    all_q = recovered("blocks.9.attn.hook_q", patch_all_q)
    l9h9_q = recovered("blocks.9.attn.hook_q", patch_l9h9_q)

    return clean_base, corr_base, resid, all_q, l9h9_q


# ---------------------------------------------------------------------------
# 5. Attention patterns for the two labelled heads (canonical prompt)
# ---------------------------------------------------------------------------

@torch.no_grad()
def attention_patterns():
    tokens = model.to_tokens(CANONICAL["prompt"])
    str_tokens = model.to_str_tokens(CANONICAL["prompt"])
    _, cache = model.run_with_cache(tokens)
    l8h6 = cache["blocks.8.attn.hook_pattern"][0, 6].numpy()
    l9h9 = cache["blocks.9.attn.hook_pattern"][0, 9].numpy()
    return str_tokens, l8h6, l9h9


if __name__ == "__main__":
    print("\n[1/5] baselines + direct logit attribution")
    clean_ld, corr_ld, accuracy, dla = baselines_and_dla(DATASET)

    print("\n[2/5] residual-stream patching")
    resid = patch_resid_pre(DATASET)

    print("\n[3/5] head patching at END")
    heads = patch_heads(DATASET)

    print("\n[4/5] path patching")
    clean_single, corr_single, path_resid, path_all_q, path_l9h9 = path_patch()

    print("\n[5/5] attention patterns")
    str_tokens, l8h6, l9h9 = attention_patterns()

    np.savez(
        "_data.npz",
        dla=dla.numpy(),
        resid=resid.numpy(),
        heads=heads.numpy(),
        l8h6=l8h6,
        l9h9=l9h9,
        str_tokens=np.array(str_tokens),
        scalars=np.array([
            clean_ld, corr_ld, accuracy,
            clean_single, corr_single,
            path_resid, path_all_q, path_l9h9,
        ]),
        n_prompts=len(DATASET),
    )

    print("\n--- summary -------------------------------------------------")
    print(f"mean clean logit diff      {clean_ld:+.3f}")
    print(f"mean corrupted logit diff  {corr_ld:+.3f}")
    print(f"accuracy                   {accuracy:.1%}")
    print(f"canonical clean / corrupt  {clean_single:+.3f} / {corr_single:+.3f}")
    print(f"path: block-9 resid_pre    {path_resid:.3f}")
    print(f"path: all block-9 queries  {path_all_q:.3f}")
    print(f"path: L9H9 query alone     {path_l9h9:.3f}")
    print("\ntop-10 direct logit attribution")
    order = dla.argsort(descending=True)
    for idx in order[:10]:
        print(f"  L{idx // N_HEADS}H{idx % N_HEADS}: {dla[idx]:+.3f}")
    print("\nhead patching extremes (layers 8+)")
    flat = heads[8:].flatten()
    for idx in flat.argsort(descending=True)[:4]:
        print(f"  L{8 + idx // N_HEADS}H{idx % N_HEADS}: {flat[idx]:+.3f}")
    for idx in flat.argsort()[:3]:
        print(f"  L{8 + idx // N_HEADS}H{idx % N_HEADS}: {flat[idx]:+.3f}")
    print(f"\nresid recovery range  [{resid.min():+.3f}, {resid.max():+.3f}]")
    print("wrote _data.npz")
