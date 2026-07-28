"""The Phase-D clone: a small per-panda-token transformer over stacked frames.

## Why this shape

Every dimension here was set by a measurement, not by taste.

**Tokens are pandas, not timesteps.** The plan asks for per-panda tokens so the
network gets an address for each neighbour, and B2 already gives slots persistent
identity. Temporal context then arrives by *stacking* `frames` decision frames into
each token's feature vector rather than by adding timesteps to the sequence — token
`j` is the same panda at t, t-1, t-2, …, because that is exactly what slot stickiness
buys. Velocity is a subtraction the first layer can do; approach and retreat stop
being the same picture.

That choice is what makes the browser budget reachable. Attention is quadratic in
tokens and the embedding is linear in stacked width, so a window costs a rounding
error here and 4x the whole model if it were laid out along the sequence:

    4 layers x  9 tokens x d64   0.82 ms      <- 1 frame,  tokens = slots
    4 layers x 18 tokens x d64   1.67 ms      <- 2 frames, laid out as sequence
    4 layers x 36 tokens x d64   3.50 ms      <- 4 frames, laid out as sequence
    4 layers x  9 tokens x d48   0.49 ms      <- 4 frames, stacked into the token

measured against 4.43 GFLOP/s for a hand-rolled `Float32Array` matmul in this engine
(dot-product form, four accumulators, weights stored transposed — 40% faster than the
scatter-accumulate form, and the shape does not matter much).

⚠️ **This is a Phase-D answer, not a Phase-E one.** Stacked frames are a fixed-length
memory handed to the network, not a belief it carries — fine for cloning a reactive
expert, and precisely the thing Phase E may not do, since the emergence claim is about
state the policy maintains itself. Phase E will want real temporal attention over a
100-200 token window and the table above says it cannot have that on the main thread
at this width. That is a known bill, not a surprise.

**Depth is 4** because the plan's floor is 4 (shallow models hold decodable-but-
causally-unused state), and width is 48 because 4 x d64 is 0.82 ms with one frame but
the weights land at 832 KB — over the 400 KB wire budget. d48 x 4 layers is ~122k
parameters: 486 KB as float32, 243 KB as float16, which is what ships.

**ReLU, not GELU.** The JS side has to reproduce this. ReLU is a comparison; GELU is a
transcendental, and `mathx.js` exists in this repo because Node and Chrome disagreed
on `Math.sin` by one ULP. Softmax still needs `exp`, which is why the policy path is
reproducible *within* an engine and not pinned across two — see `net.js`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict

import torch
from torch import nn


@dataclass(frozen=True)
class Config:
    tokens: int = 9  # 1 self + 8 neighbour slots — the encoder's frame
    obs_width: int = 37  # floats per token per frame
    frames: int = 4  # decision frames stacked into each token (t, t-1, t-2, t-3)
    d_model: int = 48
    n_layers: int = 4
    n_heads: int = 4
    d_ff: int = 192
    n_actions: int = 17
    ln_eps: float = 1e-5

    @property
    def d_in(self) -> int:
        return self.obs_width * self.frames

    @property
    def d_head(self) -> int:
        if self.d_model % self.n_heads:
            raise ValueError(f"d_model {self.d_model} not divisible by n_heads {self.n_heads}")
        return self.d_model // self.n_heads

    def dict(self) -> dict:
        return asdict(self)


class Block(nn.Module):
    """Pre-LN block: x + attn(ln(x)), then x + mlp(ln(x)).

    Attention is unmasked — the tokens are pandas standing in a room, not a sequence
    with a past. There is nothing to hide from anything.
    """

    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg = cfg
        self.ln1 = nn.LayerNorm(cfg.d_model, eps=cfg.ln_eps)
        self.qkv = nn.Linear(cfg.d_model, 3 * cfg.d_model)
        self.proj = nn.Linear(cfg.d_model, cfg.d_model)
        self.ln2 = nn.LayerNorm(cfg.d_model, eps=cfg.ln_eps)
        self.fc1 = nn.Linear(cfg.d_model, cfg.d_ff)
        self.fc2 = nn.Linear(cfg.d_ff, cfg.d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, d = x.shape
        h, dh = self.cfg.n_heads, self.cfg.d_head

        q, k, v = self.qkv(self.ln1(x)).split(d, dim=-1)
        # (b, h, t, dh)
        q = q.view(b, t, h, dh).transpose(1, 2)
        k = k.view(b, t, h, dh).transpose(1, 2)
        v = v.view(b, t, h, dh).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) * (1.0 / math.sqrt(dh))
        att = att.softmax(dim=-1)
        y = (att @ v).transpose(1, 2).reshape(b, t, d)
        x = x + self.proj(y)

        return x + self.fc2(torch.relu(self.fc1(self.ln2(x))))


class PandaNet(nn.Module):
    """Stacked frames in, 17 action logits out.

    Input is `(batch, frames, tokens, obs_width)` — most recent frame first. The
    readout is token 0, the hat panda's own token: the action is his, and every
    neighbour has already been mixed into it by attention.
    """

    def __init__(self, cfg: Config = Config()):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Linear(cfg.d_in, cfg.d_model)
        # One learned vector per slot — the "per-panda token address" the plan asks
        # for. It is per *slot*, not per panda: slot 3 means "the third-nearest thing
        # I am tracking", which is a stable role even as the panda in it changes.
        self.pos = nn.Parameter(torch.zeros(cfg.tokens, cfg.d_model))
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.n_layers))
        self.ln_f = nn.LayerNorm(cfg.d_model, eps=cfg.ln_eps)
        self.head = nn.Linear(cfg.d_model, cfg.n_actions)
        self.apply(self._init)

    @staticmethod
    def _init(m: nn.Module) -> None:
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, std=0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, f, t, w = x.shape
        cfg = self.cfg
        if (f, t, w) != (cfg.frames, cfg.tokens, cfg.obs_width):
            raise ValueError(f"expected (*, {cfg.frames}, {cfg.tokens}, {cfg.obs_width}), got {x.shape}")
        # (b, frames, tokens, width) -> (b, tokens, frames*width): each token keeps its
        # own history, contiguous, most recent first.
        x = x.permute(0, 2, 1, 3).reshape(b, t, cfg.d_in)
        x = self.embed(x) + self.pos
        for block in self.blocks:
            x = block(x)
        return self.head(self.ln_f(x[:, 0]))

    def n_params(self) -> int:
        return sum(p.numel() for p in self.parameters())
