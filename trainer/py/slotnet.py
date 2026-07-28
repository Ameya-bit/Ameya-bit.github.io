"""The Phase-E network: E2's pick, `gru-slot`, as a trainable model.

## What this is

The same single-frame spatial transformer as the Phase-D clone (4 layers x 9 panda
tokens x d48 — `model.py`'s geometry minus frame-stacking), plus the thing Phase E
exists to study: **memory the network carries itself.** Every token owns a d48 GRU
state, updated once per decision and fed back as part of that token's input at the
next one. Memory with a per-panda address — the lit review's emergence criterion
(Sokoban's cell<->square bijection, our slot<->panda binding), the natural probe
target for Phase G, and the overlay's natural feed (the belief chip for slot j
reads h_j).

Stacked frames are gone on purpose. `model.py`'s own warning: a fixed window handed
to the network is not a belief it maintains, and the emergence claim is about the
latter. Here the only route to "that fallen panda was knocked, not sleeping" is
state the GRU chose to keep.

## The parts the browser will never see

RL needs two heads BC never did, and setting 2 of the purity dial needs a third:

- **value** — the critic. Trainer-only; exported never.
- **aux** — action-conditioned prediction of *his own future observations*, per
  token, at horizons 1/2/4 decisions. No labels, no privileged state: the target
  is the sensor's own next frames, which is why it stays on the emergence side of
  the line (the plan's setting 2). Also trainer-only.

The policy path (embed -> blocks -> ln -> gru -> head) is the shipped artefact, and
it is written to be portable to a hand-rolled JS forward pass: ReLU everywhere, the
GRU is the exact arithmetic of `tools/bench-kernels.js` (z/r/candidate gates on the
concatenated input, `h' = (1-z)*h + z*tanh(...)` — note this is *not* torch's
GRUCell convention, whose z is the complement and whose candidate bias sits inside
the reset product), and every Linear keeps PyTorch's `[out, in]` layout that
`net.js`'s kernel walks contiguously.

One deliberate improvement over the bench kernel: the blocks' output is layer-normed
(`ln_f`) *before* the GRU and the heads read it. The bench fed the raw pre-LN
residual stream to its GRU — fine for pricing flops, unstable for training, since a
pre-LN residual stream grows with depth. Costs one LayerNorm; the JS port will match.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import torch
from torch import nn

from model import Block, Config as BlockConfig


@dataclass(frozen=True)
class SlotConfig:
    tokens: int = 9  # 1 self + 8 neighbour slots
    obs_width: int = 37  # floats per token per frame
    d_mem: int = 48  # per-slot GRU state
    d_model: int = 48
    n_layers: int = 4
    n_heads: int = 4
    d_ff: int = 192
    n_actions: int = 17
    ln_eps: float = 1e-5
    # aux head (setting 2): predict own observation at t+delta, per token,
    # conditioned on the executed actions in between. () disables it (setting 1).
    aux_horizons: tuple[int, ...] = (1, 2, 4)
    d_act_embed: int = 16
    d_aux_hidden: int = 128

    @property
    def d_in(self) -> int:
        return self.obs_width + self.d_mem

    @property
    def d_feat(self) -> int:
        return self.d_model + self.d_mem

    def dict(self) -> dict:
        d = asdict(self)
        d["aux_horizons"] = list(self.aux_horizons)
        return d

    @staticmethod
    def load(d: dict) -> "SlotConfig":
        d = dict(d)
        d["aux_horizons"] = tuple(d.get("aux_horizons", ()))
        return SlotConfig(**d)


class JsGru(nn.Module):
    """The GRU cell of `tools/bench-kernels.js`, batched.

    z = sigmoid(Wz.[x, h] + bz)
    r = sigmoid(Wr.[x, h] + br)
    n = tanh(Wh.[x, r*h] + bh)
    h' = (1 - z) * h + z * n

    Kept as three plain Linears on the concatenated input so the eventual export is
    a straight copy of six tensors, in this order, into the same arithmetic.
    """

    def __init__(self, d_in: int, d_h: int):
        super().__init__()
        self.wz = nn.Linear(d_in + d_h, d_h)
        self.wr = nn.Linear(d_in + d_h, d_h)
        self.wh = nn.Linear(d_in + d_h, d_h)

    def forward(self, x: torch.Tensor, h: torch.Tensor) -> torch.Tensor:
        cat = torch.cat([x, h], dim=-1)
        z = torch.sigmoid(self.wz(cat))
        r = torch.sigmoid(self.wr(cat))
        n = torch.tanh(self.wh(torch.cat([x, r * h], dim=-1)))
        return (1 - z) * h + z * n


class SlotNet(nn.Module):
    """One decision: frame (tokens x obs_width) + carried memory -> logits, value.

    `step` is the deployed shape (one decision, memory in and out); `sequence` is
    the training shape (BPTT over a window, resets applied where episodes end).
    """

    def __init__(self, cfg: SlotConfig = SlotConfig()):
        super().__init__()
        self.cfg = cfg
        bc = BlockConfig(d_model=cfg.d_model, n_layers=cfg.n_layers, n_heads=cfg.n_heads,
                         d_ff=cfg.d_ff, n_actions=cfg.n_actions, tokens=cfg.tokens,
                         obs_width=cfg.obs_width, ln_eps=cfg.ln_eps)
        self.embed = nn.Linear(cfg.d_in, cfg.d_model)
        self.pos = nn.Parameter(torch.zeros(cfg.tokens, cfg.d_model))
        self.blocks = nn.ModuleList(Block(bc) for _ in range(cfg.n_layers))
        self.ln_f = nn.LayerNorm(cfg.d_model, eps=cfg.ln_eps)
        self.gru = JsGru(cfg.d_model, cfg.d_mem)
        self.head = nn.Linear(cfg.d_feat, cfg.n_actions)
        # -- trainer-only heads --
        self.value = nn.Linear(cfg.d_feat, 1)
        self.act_embed = nn.Embedding(cfg.n_actions, cfg.d_act_embed)
        self.aux = nn.ModuleList(
            nn.Sequential(
                nn.Linear(cfg.d_feat + k * cfg.d_act_embed, cfg.d_aux_hidden),
                nn.ReLU(),
                nn.Linear(cfg.d_aux_hidden, cfg.obs_width),
            )
            for k in cfg.aux_horizons
        )
        self.apply(self._init)
        # Near-zero heads: the warm start owns the policy head's scale, and a
        # zero-init critic is the standard PPO opening position.
        nn.init.normal_(self.head.weight, std=0.01)
        nn.init.zeros_(self.value.weight)

    @staticmethod
    def _init(m: nn.Module) -> None:
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, std=0.02)
            if isinstance(m, nn.Linear) and m.bias is not None:
                nn.init.zeros_(m.bias)

    def initial_memory(self, batch: int, device=None) -> torch.Tensor:
        cfg = self.cfg
        return torch.zeros(batch, cfg.tokens, cfg.d_mem, device=device)

    def step(self, obs: torch.Tensor, mem: torch.Tensor):
        """One decision. obs (B, tokens, obs_width), mem (B, tokens, d_mem).

        Returns (logits (B, actions), value (B,), feat (B, tokens, d_feat), mem').
        `feat` is what the aux heads and Phase-G probes read: the normalised token
        states concatenated with that token's *updated* memory.
        """
        cfg = self.cfg
        b, t, w = obs.shape
        if (t, w) != (cfg.tokens, cfg.obs_width):
            raise ValueError(f"expected (*, {cfg.tokens}, {cfg.obs_width}), got {obs.shape}")
        x = self.embed(torch.cat([obs, mem], dim=-1)) + self.pos
        for block in self.blocks:
            x = block(x)
        y = self.ln_f(x)
        mem = self.gru(y.reshape(b * t, -1), mem.reshape(b * t, -1)).view(b, t, cfg.d_mem)
        feat = torch.cat([y, mem], dim=-1)
        logits = self.head(feat[:, 0])
        value = self.value(feat[:, 0]).squeeze(-1)
        return logits, value, feat, mem

    def sequence(self, obs: torch.Tensor, mem: torch.Tensor,
                 resets: torch.Tensor | None = None, skips: torch.Tensor | None = None):
        """BPTT over a window. obs (B, T, tokens, width), resets/skips (B, T) bool.

        `resets[:, t]` zeroes the memory *before* decision t is processed — the
        frame at t is the first of a new episode, exactly the rollout's rule.
        `skips[:, t]` marks slots where the rollout ran no forward pass (the
        expert-driven pipeline-fill decision at an episode's start): the step is
        computed anyway — a batch cannot branch per row — but the memory update is
        discarded, so the carried state stays exactly what the rollout carried, and
        the caller masks the outputs out of every loss.

        Returns (logits (B, T, actions), values (B, T), feats (B, T, tokens, d_feat),
        final mem).
        """
        logits, values, feats = [], [], []
        for t in range(obs.shape[1]):
            if resets is not None:
                mem = mem * (~resets[:, t]).float().view(-1, 1, 1)
            lg, v, f, new_mem = self.step(obs[:, t], mem)
            if skips is not None:
                keep = skips[:, t].float().view(-1, 1, 1)
                new_mem = keep * mem + (1 - keep) * new_mem
            mem = new_mem
            logits.append(lg)
            values.append(v)
            feats.append(f)
        return (torch.stack(logits, dim=1), torch.stack(values, dim=1),
                torch.stack(feats, dim=1), mem)

    def aux_predict(self, feat: torch.Tensor, act_seqs: list[torch.Tensor]) -> list[torch.Tensor]:
        """Setting 2: predicted observation per token at each horizon.

        feat (N, tokens, d_feat); act_seqs[i] (N, horizons[i]) — the actions
        actually executed over the next `horizons[i]` decisions, hat's own,
        broadcast to every token. Returns one (N, tokens, obs_width) per horizon.
        """
        out = []
        for head, acts in zip(self.aux, act_seqs):
            n, k = acts.shape
            a = self.act_embed(acts).reshape(n, 1, k * self.cfg.d_act_embed)
            a = a.expand(-1, self.cfg.tokens, -1)
            out.append(head(torch.cat([feat, a], dim=-1)))
        return out

    def policy_parameters(self):
        """Everything the exported policy runs — the actor, excluding every
        trainer-only head. What stays frozen through the critic-only warmup."""
        heads = {id(p) for m in (self.value, self.act_embed, self.aux) for p in m.parameters()}
        return [p for p in self.parameters() if id(p) not in heads]

    def n_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def n_policy_params(self) -> int:
        return sum(p.numel() for p in self.policy_parameters())
