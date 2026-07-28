"""E3 — the PPO trainer: the emergence run's engine.

    uv run python ppo.py --init runs/warmstart-slot/checkpoint.pt
    uv run python ppo.py --smoke

The locked recipe (design/panda-policy-net.md, "Model & training"), piece by piece:

- **The reward is the game.** `VecEnv` pays the delta of the C1-C5 ledger per
  decision; the summed rewards of an episode are its gate score. Nothing here
  invents a reward; `--rules` passes economy knobs through to the same referee
  the gate runs.
- **Critic-only warmup.** A fresh critic's advantages would tear the BC policy
  apart (PIRLNav's measurement), so for `--warmup-updates` the actor's learning
  rate is zero and only the value head (and aux heads) learn, on rollouts driven
  by the frozen warm start. Then the actor unfreezes at `--lr` — set ~10x under
  the heads' rate, per the plan.
- **KL-to-frozen-BC replaces the entropy bonus.** The anchor is E1's *exported*
  clone (the file the browser fetches, loaded through `export.load_exported` —
  the stacked-frame architecture, run on a 4-frame ring exactly as `net.js` runs
  it). Its distribution is the believability prior; the penalty coefficient is
  **the leash**, and the leash is a schedule, not a constant: tight early for
  stability, deliberately annealed loose mid-training because information-seeking
  is exactly what the anchor never does, re-tightened late. `--leash` is
  piecewise-linear `frac:coef` points; every update's coefficient lands in the
  history file.
- **Setting 2's auxiliary loss**: action-conditioned prediction of his own future
  observations, per token, at horizons 1/2/4 decisions (`slotnet.aux_predict`).
  No labels, no privileged state — the target is the sensor's own later frames.
  `--aux-coef 0` is setting 1, the purist arm; the flag is the one-loss-term
  difference the plan promises.
- **Conservative PPO**: clip 0.15, 1-2 epochs per batch, advantages normalised
  over the batch, gradients clipped. Deliberately boring.

## The delay contract, on-policy

The page's worker computes from frame k and the result lands at decision k+1, so
the rollout here does exactly that: the net processes each frame once, its sampled
action is *held* and stepped at the next decision, and the first decision of every
episode is handed to the rules expert (`-1`) while the pipeline fills — the
deploy-time behaviour, bit for bit. Those expert decisions land in the buffer as
`skip` slots: no forward pass happened, so the replay runs a dummy step whose
memory update is discarded (`SlotNet.sequence(skips=...)`) and every loss masks
them out.

## Recurrent replay without the recompute bill

PPO needs the new policy's logits for old states, and a recurrent net's state at
decision k is the product of the whole episode before it. Recomputing from each
episode's start would be exact and unaffordable; the standard compromise (R2D2,
sb3-contrib) is stored state: the rollout snapshots the carried memory at every
`--bptt` boundary, and the learner replays fixed-length chunks from those
snapshots. After the first gradient step the snapshots are one policy version
stale — accepted, bounded by the clip. `--bptt` also bounds the horizon credit
can flow over (64 decisions = 6.4 s at 10 Hz), which must stay longer than the
knock-to-classification span or the flagship discrimination cannot be *learned*
even if it can be carried.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from export import load_exported
from slotnet import SlotNet, SlotConfig
from train import pick_device
from vecenv import VecEnv, EXPERT_ACTION

HERE = Path(__file__).parent
ANCHOR = HERE.parent.parent / "assets" / "pandas" / "engine" / "policy" / "weights"

DECISIONS_PER_MIN = 600  # 10 Hz decisions


def parse_leash(spec: str) -> list[tuple[float, float]]:
    """`frac:coef` points, e.g. `0:1.0,0.3:1.0,0.6:0.1,0.85:0.1,1:0.3`."""
    pts = []
    for part in spec.split(","):
        frac, coef = part.split(":")
        pts.append((float(frac), float(coef)))
    if not pts or pts[0][0] != 0.0:
        raise ValueError(f"leash must start at 0: {spec!r}")
    if any(b[0] <= a[0] for a, b in zip(pts, pts[1:])):
        raise ValueError(f"leash fractions must increase: {spec!r}")
    return pts


def leash_at(points: list[tuple[float, float]], frac: float) -> float:
    frac = min(max(frac, 0.0), 1.0)
    for (f0, c0), (f1, c1) in zip(points, points[1:]):
        if frac <= f1:
            return c0 + (c1 - c0) * (frac - f0) / (f1 - f0)
    return points[-1][1]


class AnchorRing:
    """The E1 clone's eyes: a per-env ring of the last `frames` frames.

    Primed by repetition at each episode start — `net.js`'s own rule — and pushed
    exactly when the actor processes a frame, so the anchor answers for the same
    decision from the same evidence the actor saw (both live under delay 1).
    """

    def __init__(self, envs: int, frames: int, tokens: int, width: int):
        self.buf = np.zeros((envs, frames, tokens, width), dtype=np.float32)

    def prime(self, idx: np.ndarray, frame: np.ndarray) -> None:
        self.buf[idx] = frame[idx][:, None]

    def push(self, frame: np.ndarray) -> None:
        self.buf[:, 1:] = self.buf[:, :-1]
        self.buf[:, 0] = frame


class Rollout:
    """One update's worth of decisions: (T, N) lanes plus BPTT-chunk memory."""

    def __init__(self, T: int, N: int, cfg: SlotConfig, bptt: int):
        if T % bptt:
            raise ValueError(f"--steps-per-update {T} must divide by --bptt {bptt}")
        self.T, self.N, self.bptt = T, N, bptt
        self.obs = np.zeros((T, N, cfg.tokens, cfg.obs_width), dtype=np.float32)
        self.act = np.zeros((T, N), dtype=np.int64)
        self.logp = np.zeros((T, N), dtype=np.float32)
        self.value = np.zeros((T, N), dtype=np.float32)
        self.anchor_logp = np.zeros((T, N, cfg.n_actions), dtype=np.float32)
        self.reward = np.zeros((T, N), dtype=np.float32)
        self.done = np.zeros((T, N), dtype=bool)
        self.skip = np.zeros((T, N), dtype=bool)  # expert-driven: no forward ran
        self.reset = np.zeros((T, N), dtype=bool)  # memory zeroed before this slot
        self.limited = np.zeros((T, N), dtype=bool)  # chosen != applied (the body's brakes)
        self.mem0 = np.zeros((T // bptt, N, cfg.tokens, cfg.d_mem), dtype=np.float32)


class Collector:
    """Drives the fleet under the deployed timing and fills a Rollout.

    Persistent across updates: the held frame, the carried memory, the anchor
    ring, and the *pending* decision — sampled from the frame before, stepped
    now. `pend_skip[i]` marks envs whose next decision belongs to the expert.
    """

    def __init__(self, env: VecEnv, model: SlotNet, anchor, device):
        self.env, self.model, self.anchor, self.device = env, model, anchor, device
        cfg = model.cfg
        n = env.envs
        self.frame = env.reset().copy()  # the held frame — the next decision's evidence
        self.mem = torch.zeros(n, cfg.tokens, cfg.d_mem, device=device)
        self.ring = AnchorRing(n, anchor.cfg.frames, cfg.tokens, cfg.obs_width)
        self.ring.prime(np.arange(n), self.frame)
        # Pending decision lanes — all expert at the very start (empty pipeline).
        self.pend_skip = np.ones(n, dtype=bool)
        self.pend_reset = np.ones(n, dtype=bool)
        self.pend_obs = self.frame.copy()
        self.pend_act = np.full(n, EXPERT_ACTION, dtype=np.int64)
        self.pend_logp = np.zeros(n, dtype=np.float32)
        self.pend_value = np.zeros(n, dtype=np.float32)
        self.pend_anchor = np.zeros((n, cfg.n_actions), dtype=np.float32)
        self.pend_mem0 = np.zeros((n, cfg.tokens, cfg.d_mem), dtype=np.float32)
        self.ep_len = np.zeros(n, dtype=np.int64)
        self.finished: list[tuple[float, int]] = []  # (return, decisions)

    @torch.no_grad()
    def _decide(self, fresh: np.ndarray, want_mem0: bool) -> None:
        """Sample the next pending decision from the *held* frame — the delay
        contract's compute half: the frame received at decision k produces the
        action applied at k+1. `fresh[i]` marks envs whose episode just ended:
        their memory was zeroed, their pending decision is the expert's, and the
        net does not run for them this turn — the pipeline is filling."""
        if want_mem0:
            self.pend_mem0[:] = self.mem.cpu().numpy()
        self.pend_obs[:] = self.frame
        self.pend_reset[:] = fresh
        self.pend_skip[:] = fresh
        self.pend_act[fresh] = EXPERT_ACTION
        live = ~fresh
        if not live.any():
            return
        self.ring.push(self.frame)
        obs_t = torch.from_numpy(self.frame).to(self.device)
        logits, value, _, mem_new = self.model.step(obs_t, self.mem)
        # Envs mid-pipeline-fill keep their zeroed memory; the rest advance.
        keep = torch.from_numpy(fresh).to(self.device).float().view(-1, 1, 1)
        self.mem = keep * self.mem + (1 - keep) * mem_new
        dist = torch.distributions.Categorical(logits=logits)
        act = dist.sample()
        logp = dist.log_prob(act)
        a_logp = torch.log_softmax(
            self.anchor(torch.from_numpy(self.ring.buf).to(self.device)), dim=-1)
        act, logp = act.cpu().numpy(), logp.cpu().numpy()
        self.pend_act[live] = act[live]
        self.pend_logp[live] = logp[live]
        self.pend_value[live] = value.cpu().numpy()[live]
        self.pend_anchor[live] = a_logp.cpu().numpy()[live]

    def collect(self, roll: Rollout) -> dict:
        t0 = time.time()
        for t in range(roll.T):
            if t % roll.bptt == 0:
                roll.mem0[t // roll.bptt] = self.pend_mem0
            out = self.env.step(self.pend_act.astype(np.int8))
            obs_new, rewards, dones, applied, returns = out
            roll.obs[t] = self.pend_obs
            roll.act[t] = np.where(self.pend_skip, 0, self.pend_act)
            roll.logp[t] = self.pend_logp
            roll.value[t] = np.where(self.pend_skip, 0.0, self.pend_value)
            roll.anchor_logp[t] = self.pend_anchor
            roll.reward[t] = rewards
            roll.done[t] = dones.astype(bool)
            roll.skip[t] = self.pend_skip
            roll.reset[t] = self.pend_reset
            roll.limited[t] = ~self.pend_skip & (applied.astype(np.int64) != self.pend_act)

            self.ep_len += 1
            fresh = dones.astype(bool)
            if fresh.any():
                for i in np.nonzero(fresh)[0]:
                    self.finished.append((float(returns[i]), int(self.ep_len[i])))
                self.ep_len[fresh] = 0
                mask = torch.from_numpy(fresh).to(self.device).float().view(-1, 1, 1)
                self.mem = self.mem * (1 - mask)
            # Decide from the frame received *last* iteration (fresh envs sit this
            # one out), and only then advance the held frame — for a fresh env
            # `obs_new` is already the next episode's first frame.
            self._decide(fresh, want_mem0=(t + 1) % roll.bptt == 0)
            if fresh.any():
                self.ring.prime(np.nonzero(fresh)[0], obs_new)
            self.frame[:] = obs_new

        # Bootstrap for GAE: the pending decision's value estimate (0 for envs
        # mid-pipeline-fill, whose last stored slot is terminal anyway).
        next_value = np.where(self.pend_skip, 0.0, self.pend_value).astype(np.float32)
        return {"next_value": next_value, "seconds": time.time() - t0}


def compute_gae(roll: Rollout, next_value: np.ndarray, gamma: float, lam: float):
    T, N = roll.T, roll.N
    adv = np.zeros((T, N), dtype=np.float32)
    lastgae = np.zeros(N, dtype=np.float32)
    for t in reversed(range(T)):
        nonterminal = 1.0 - roll.done[t].astype(np.float32)
        nextv = roll.value[t + 1] if t < T - 1 else next_value
        delta = roll.reward[t] + gamma * nextv * nonterminal - roll.value[t]
        lastgae = delta + gamma * lam * nonterminal * lastgae
        adv[t] = lastgae
    return adv, adv + roll.value


def aux_valid(roll: Rollout, horizon: int) -> np.ndarray:
    """(T, N) — slots whose t+horizon target exists inside this rollout's episode."""
    T = roll.T
    ok = ~roll.skip.copy()
    ok[T - horizon :] = False
    for j in range(horizon):
        ok[: T - horizon] &= ~roll.done[j : T - horizon + j]
    return ok


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--init", default=str(HERE / "runs" / "warmstart-slot" / "best.pt"),
                   help="the warm-start checkpoint (warmstart.py's best-by-eval)")
    p.add_argument("--anchor", default=str(ANCHOR),
                   help="exported clone dir — the frozen KL anchor (E1)")
    p.add_argument("--out", default=str(HERE / "runs" / "ppo"))
    # the fleet
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--envs", type=int, default=64, help="envs per worker")
    p.add_argument("--spec", default="wild")
    p.add_argument("--rules", default="", help="JSON game-rule overrides, passed to the referee")
    p.add_argument("--ticks", type=int, default=12000)
    p.add_argument("--corpus-seed", type=int, default=20260728)
    # the schedule
    p.add_argument("--total-steps", type=int, default=300_000_000)
    p.add_argument("--steps-per-update", type=int, default=128, help="decisions per env per update")
    p.add_argument("--bptt", type=int, default=64, help="replay chunk length (credit horizon)")
    p.add_argument("--warmup-updates", type=int, default=25, help="critic-only updates")
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--minibatch-envs", type=int, default=256)
    # the losses
    p.add_argument("--lr", type=float, default=3e-5, help="actor, after unfreeze")
    p.add_argument("--lr-heads", type=float, default=3e-4, help="value + aux heads")
    p.add_argument("--clip", type=float, default=0.15)
    p.add_argument("--gamma", type=float, default=0.995)
    p.add_argument("--lam", type=float, default=0.95)
    p.add_argument("--value-coef", type=float, default=0.5)
    p.add_argument("--aux-coef", type=float, default=0.5, help="setting 2's weight; 0 = setting 1")
    p.add_argument("--leash", default="0:1.0,0.3:1.0,0.6:0.1,0.85:0.1,1:0.3",
                   help="KL-to-anchor coefficient as frac:coef points, piecewise linear")
    p.add_argument("--grad-clip", type=float, default=1.0)
    # bookkeeping
    p.add_argument("--max-minutes", type=float, default=0,
                   help="stop cleanly after this wall-clock budget (0 = run to --total-steps). "
                        "The shakedown knob: run the real config, truncated — schedules still "
                        "span --total-steps, so 10 minutes of a 300M run behaves exactly like "
                        "the first 10 minutes of the real thing")
    p.add_argument("--save-every-steps", type=int, default=2_000_000)
    p.add_argument("--log-every", type=int, default=1)
    p.add_argument("--seed", type=int, default=20260728)
    p.add_argument("--device", default="auto")
    p.add_argument("--smoke", action="store_true", help="tiny fleet, three updates, wiring only")
    args = p.parse_args()

    if args.smoke:
        args.workers, args.envs = 2, 8
        args.steps_per_update, args.bptt = 32, 16
        args.total_steps = 3 * args.steps_per_update * args.workers * args.envs
        args.warmup_updates = 1
        args.minibatch_envs = 8

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = pick_device(args.device)
    leash = parse_leash(args.leash)

    # -- the actor --
    ckpt = torch.load(args.init, map_location="cpu", weights_only=True) if Path(args.init).exists() else None
    if ckpt is not None:
        if ckpt.get("arch") != "slotnet":
            raise ValueError(f"--init {args.init} is not a slotnet checkpoint")
        cfg = SlotConfig.load(ckpt["cfg"])
        model = SlotNet(cfg).to(device)
        model.load_state_dict(ckpt["model"])
        init_from = f"{args.init} (step {ckpt.get('step')})"
    elif args.smoke:
        cfg = SlotConfig()
        model = SlotNet(cfg).to(device)
        init_from = "random (smoke)"
    else:
        raise FileNotFoundError(
            f"--init {args.init} not found — run warmstart.py first (the recipe starts from BC)")

    # -- the frozen anchor: the exported E1 clone, the file the browser fetches --
    anchor, anchor_manifest = load_exported(Path(args.anchor))
    anchor = anchor.to(device)
    for prm in anchor.parameters():
        prm.requires_grad_(False)
    if anchor_manifest.get("delay") != 1 and not args.smoke:
        raise ValueError(f"anchor at {args.anchor} was trained delay={anchor_manifest.get('delay')}; "
                         "the rollout runs the deployed delay-1 timing")

    # -- the fleet --
    env = VecEnv(workers=args.workers, envs_per_worker=args.envs, spec=args.spec,
                 corpus_seed=args.corpus_seed, ticks=args.ticks, rules=args.rules)
    N = env.envs
    T = args.steps_per_update
    steps_per_update = T * N
    total_updates = max(1, args.total_steps // steps_per_update)
    print(f"actor  {model.n_params():,} params (policy path {model.n_policy_params():,}), from {init_from}")
    print(f"anchor {args.anchor} ({anchor_manifest.get('digest')}, trainedOn {anchor_manifest.get('trainedOn')})")
    print(f"fleet  {N} envs ({args.workers}x{args.envs}) on '{args.spec}'  device {device}")
    print(f"plan   {total_updates} updates x {steps_per_update:,} decisions "
          f"({args.total_steps / 1e6:.0f}M total), warmup {args.warmup_updates}, "
          f"bptt {args.bptt}, leash {args.leash}")

    heads = [*model.value.parameters(), *model.act_embed.parameters(), *model.aux.parameters()]
    actor_params = model.policy_parameters()
    opt = torch.optim.AdamW(
        [{"params": actor_params, "lr": 0.0},  # frozen through the warmup
         {"params": heads, "lr": args.lr_heads}],
        betas=(0.9, 0.95), weight_decay=0.0)

    collector = Collector(env, model, anchor, device)
    roll = Rollout(T, N, cfg, args.bptt)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    history_path = out / "history.jsonl"
    horizons = list(cfg.aux_horizons) if args.aux_coef > 0 else []

    env_steps = 0
    next_save = args.save_every_steps
    t_start = time.time()

    def save(tag: str) -> None:
        torch.save({"cfg": cfg.dict(), "model": model.state_dict(),
                    "opt": opt.state_dict(), "update": update, "env_steps": env_steps,
                    "delay": 1, "arch": "slotnet", "args": vars(args)},
                   out / f"{tag}.pt")

    for update in range(1, total_updates + 1):
        info = collector.collect(roll)
        env_steps += steps_per_update
        adv, ret = compute_gae(roll, info["next_value"], args.gamma, args.lam)
        valid = ~roll.skip
        adv_t = torch.from_numpy(adv)
        v_valid = torch.from_numpy(valid)
        adv_mean = float(adv[valid].mean())
        adv_std = float(adv[valid].std() + 1e-8)

        frac = update / total_updates
        kl_coef = leash_at(leash, frac)
        warming = update <= args.warmup_updates
        opt.param_groups[0]["lr"] = 0.0 if warming else args.lr

        # aux validity masks + flattened action-condition windows, once per update
        aux_masks = {k: torch.from_numpy(aux_valid(roll, k)) for k in horizons}

        obs_all = torch.from_numpy(roll.obs)
        act_all = torch.from_numpy(roll.act)
        logp_all = torch.from_numpy(roll.logp)
        anchor_all = torch.from_numpy(roll.anchor_logp)
        ret_all = torch.from_numpy(ret)
        resets_all = torch.from_numpy(roll.reset)
        skips_all = torch.from_numpy(roll.skip)
        stats = {"policy": 0.0, "value": 0.0, "kl_anchor": 0.0, "aux": 0.0,
                 "approx_kl": 0.0, "entropy": 0.0, "clipfrac": 0.0}
        n_grad_steps = 0

        for _epoch in range(args.epochs):
            order = np.random.permutation(N)
            for mb_at in range(0, N, args.minibatch_envs):
                mb = order[mb_at : mb_at + args.minibatch_envs]
                mb_t = torch.from_numpy(mb)
                for c in range(T // args.bptt):
                    lo, hi = c * args.bptt, (c + 1) * args.bptt
                    obs_mb = obs_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    resets_mb = resets_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    skips_mb = skips_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    mem0 = torch.from_numpy(roll.mem0[c][mb]).to(device)

                    logits, values, feats, _ = model.sequence(obs_mb, mem0, resets_mb, skips_mb)
                    mask = v_valid[lo:hi, mb_t].transpose(0, 1).to(device)
                    n_valid = mask.sum().clamp(min=1)

                    dist = torch.distributions.Categorical(logits=logits)
                    act_mb = act_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    new_logp = dist.log_prob(act_mb)
                    old_logp = logp_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    a = ((adv_t[lo:hi, mb_t].transpose(0, 1).to(device)) - adv_mean) / adv_std

                    ratio = (new_logp - old_logp).exp()
                    surr = torch.min(ratio * a, ratio.clamp(1 - args.clip, 1 + args.clip) * a)
                    policy_loss = -(surr * mask).sum() / n_valid

                    v_target = ret_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    value_loss = (((values - v_target) ** 2) * mask).sum() / n_valid

                    log_probs = torch.log_softmax(logits, dim=-1)
                    anchor_mb = anchor_all[lo:hi, mb_t].transpose(0, 1).to(device)
                    kl_anchor = ((log_probs.exp() * (log_probs - anchor_mb)).sum(-1) * mask).sum() / n_valid

                    # Setting 2: from the features at each valid slot, predict the
                    # observation `k` decisions later, conditioned on the actions
                    # actually executed in between. Targets and actions come from
                    # the full buffer, so a target past this chunk's edge is fine.
                    aux_loss = torch.zeros((), device=device)
                    for ki, k in enumerate(horizons):
                        m = aux_masks[k][lo:hi, mb_t].transpose(0, 1)
                        if not m.any():
                            continue
                        b_idx, t_idx = torch.nonzero(m, as_tuple=True)
                        rows, cols = lo + t_idx, mb_t[b_idx]
                        src = feats[b_idx.to(device), t_idx.to(device)]  # (n, tokens, d_feat)
                        acts = torch.stack([act_all[rows + j, cols] for j in range(k)], dim=1).to(device)
                        tgt = obs_all[rows + k, cols].to(device)
                        n_src = src.shape[0]
                        a_emb = model.act_embed(acts).reshape(n_src, 1, k * cfg.d_act_embed)
                        pred = model.aux[ki](torch.cat([src, a_emb.expand(-1, cfg.tokens, -1)], dim=-1))
                        aux_loss = aux_loss + ((pred - tgt) ** 2).mean()

                    loss = (policy_loss + args.value_coef * value_loss
                            + kl_coef * kl_anchor + args.aux_coef * aux_loss)
                    opt.zero_grad(set_to_none=True)
                    loss.backward()
                    nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
                    opt.step()

                    with torch.no_grad():
                        logratio = new_logp - old_logp
                        stats["policy"] += float(policy_loss)
                        stats["value"] += float(value_loss)
                        stats["kl_anchor"] += float(kl_anchor)
                        stats["aux"] += float(aux_loss)
                        stats["approx_kl"] += float((((ratio - 1) - logratio) * mask).sum() / n_valid)
                        stats["entropy"] += float((dist.entropy() * mask).sum() / n_valid)
                        stats["clipfrac"] += float((((ratio - 1).abs() > args.clip).float() * mask).sum() / n_valid)
                    n_grad_steps += 1

        for k in stats:
            stats[k] /= max(1, n_grad_steps)

        if update % args.log_every == 0 or update == total_updates:
            recent = collector.finished[-64:]
            if recent:
                spm = [r / (l / DECISIONS_PER_MIN) for r, l in recent]
                ep_line = f"return {np.mean([r for r, _ in recent]):+8.1f}  score/min {np.mean(spm):+7.2f}"
            else:
                ep_line = "no episodes finished yet"
            sps = env_steps / (time.time() - t_start)
            print(f"upd {update:>5}/{total_updates}  {env_steps / 1e6:7.2f}M steps  {sps / 1000:5.1f}k/s  "
                  f"{ep_line}  pi {stats['policy']:+.4f}  v {stats['value']:.3f}  "
                  f"klA {stats['kl_anchor']:.4f}(c{kl_coef:.2f})  aux {stats['aux']:.4f}  "
                  f"ent {stats['entropy']:.3f}  aklP {stats['approx_kl']:.4f}  "
                  f"lim {float(roll.limited[valid].mean()):.3f}{'  [warmup]' if warming else ''}")
            with history_path.open("a") as f:
                f.write(json.dumps({
                    "update": update, "env_steps": env_steps, "kl_coef": kl_coef,
                    "warming": warming, **{k: round(v, 6) for k, v in stats.items()},
                    "episodes": len(collector.finished),
                    "mean_return": float(np.mean([r for r, _ in recent])) if recent else None,
                    "mean_score_per_min": float(np.mean(spm)) if recent else None,
                    "limited_frac": float(roll.limited[valid].mean()),
                }) + "\n")

        if env_steps >= next_save or update == total_updates:
            save("latest")
            save(f"ckpt-{env_steps // 1_000_000:05d}M")
            next_save += args.save_every_steps

        if args.max_minutes and (time.time() - t_start) / 60 >= args.max_minutes:
            save("latest")
            save(f"ckpt-{env_steps // 1_000_000:05d}M")
            print(f"\nstopping at the --max-minutes budget ({args.max_minutes:g} min), "
                  f"update {update}/{total_updates}")
            break

    env.close()
    print(f"\ndone: {env_steps / 1e6:.1f}M env steps in {(time.time() - t_start) / 60:.1f} min; "
          f"checkpoints + history in {out}")


if __name__ == "__main__":
    main()
