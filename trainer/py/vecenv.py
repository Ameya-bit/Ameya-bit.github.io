"""The vec fleet's Python client — E0's other half.

    from vecenv import VecEnv
    env = VecEnv(workers=8, envs_per_worker=64)
    obs = env.reset()                       # (envs, tokens, width) float32
    obs, rewards, dones, applied, returns = env.step(actions)   # actions: (envs,) int8
    env.close()

Spawns `node trainer/vec-serve.js` and speaks its stdio protocol: one JSON line
of handshake, then fixed-size binary records both ways. The reader is
`np.frombuffer` and a reshape — the corpus-shard philosophy on a pipe.

Actions are 0..16, or EXPERT_ACTION (−1) to hand a decision to the rules expert
(the deploy-time fallback, and what drives while a delayed policy's pipeline
fills). Episode ends auto-reset inside the fleet: `dones[i]` marks the boundary,
`returns[i]` carries the finished episode's ledger total, and the observation
already belongs to the next episode — standard VecEnv semantics.

The decision-delay contract lives on the *policy* side, exactly as in data.py:
the network answering for decision k acts on the frame from k−1. A PPO loop
implements that by feeding the previous observation to its forward pass (and
sending EXPERT_ACTION for an episode's first delayed decisions); the env stays
synchronous and agnostic.

Bench:  uv run python vecenv.py --bench --workers 8 --envs 64 --steps 300
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
SERVE = HERE.parent / "vec-serve.js"

EXPERT_ACTION = -1


class VecEnv:
    def __init__(
        self,
        workers: int = 4,
        envs_per_worker: int = 32,
        spec: str = "wild",
        corpus_seed: int = 20260728,
        ticks: int = 12000,
        rules: str = "",
        stagger: bool = True,
        node: str = "node",
    ):
        cmd = [
            node, str(SERVE),
            "--workers", str(workers),
            "--envs", str(envs_per_worker),
            "--spec", spec,
            "--corpus-seed", str(corpus_seed),
            "--ticks", str(ticks),
            "--stagger", "1" if stagger else "0",
        ]
        if rules:
            cmd += ["--rules", rules]
        # stderr passes through: the fleet's diagnostics belong on the console.
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

        header = self.proc.stdout.readline()
        if not header:
            raise RuntimeError("vec-serve produced no handshake — see stderr above")
        self.spec_info = json.loads(header)
        if self.spec_info["protocol"] != 1:
            raise RuntimeError(f"protocol {self.spec_info['protocol']}, expected 1")

        hs = self.spec_info
        self.envs: int = hs["envs"]
        self.tokens: int = hs["tokens"]
        self.width: int = hs["width"]
        self.n_actions: int = hs["nActions"]
        r = hs["record"]
        self._lanes = [
            ("obs", r["obs"], np.float32),
            ("rewards", r["rewards"], np.float32),
            ("dones", r["dones"], np.uint8),
            ("applied", r["applied"], np.int8),
            ("returns", r["returns"], np.float32),
        ]
        self._record_bytes = sum(size for _, size, _ in self._lanes)
        self._first = self._read_record()

    def _read_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.proc.stdout.read(n - len(buf))
            if not chunk:
                raise RuntimeError("vec-serve closed the pipe mid-record")
            buf.extend(chunk)
        return bytes(buf)

    def _read_record(self):
        raw = self._read_exact(self._record_bytes)
        out, at = [], 0
        for _, size, dtype in self._lanes:
            out.append(np.frombuffer(raw, dtype=dtype, count=size // np.dtype(dtype).itemsize, offset=at))
            at += size
        obs, rewards, dones, applied, returns = out
        return obs.reshape(self.envs, self.tokens, self.width), rewards, dones, applied, returns

    def reset(self) -> np.ndarray:
        """The initial frames. Valid once, before the first step."""
        if self._first is None:
            raise RuntimeError("reset() after step() — the fleet auto-resets; read `dones` instead")
        obs = self._first[0]
        self._first = None
        return obs

    def step(self, actions: np.ndarray):
        """One decision for every env. Returns (obs, rewards, dones, applied, returns)."""
        self._first = None
        a = np.asarray(actions, dtype=np.int8)
        if a.shape != (self.envs,):
            raise ValueError(f"actions must be ({self.envs},), got {a.shape}")
        self.proc.stdin.write(a.tobytes())
        self.proc.stdin.flush()
        return self._read_record()

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait(timeout=10)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def bench(args) -> None:
    with VecEnv(workers=args.workers, envs_per_worker=args.envs, spec=args.spec,
                ticks=args.ticks, corpus_seed=args.corpus_seed) as env:
        print(f"fleet: {env.envs} envs ({args.workers}×{args.envs}), spec {args.spec}, "
              f"obs {env.tokens}×{env.width}")
        obs = env.reset()
        assert obs.shape == (env.envs, env.tokens, env.width) and np.isfinite(obs).all()

        rng = np.random.default_rng(0)
        episodes, total_return = 0, 0.0
        for name, acts in [
            ("expert-driven", np.full(env.envs, EXPERT_ACTION, dtype=np.int8)),
            ("random-driven", None),
        ]:
            t0 = time.time()
            for _ in range(args.steps):
                a = rng.integers(0, env.n_actions, env.envs, dtype=np.int8) if acts is None else acts
                obs, rewards, dones, applied, returns = env.step(a)
                episodes += int(dones.sum())
                total_return += float(returns.sum())
            dt = time.time() - t0
            rate = args.steps * env.envs / dt
            print(f"  {name:14s}  {rate / 1000:6.1f}k decisions/s  "
                  f"({args.steps} steps × {env.envs} envs in {dt:.1f}s)")
        if episodes:
            print(f"  {episodes} episodes finished, mean return {total_return / episodes:+.1f}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--bench", action="store_true")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--envs", type=int, default=32, help="envs per worker")
    p.add_argument("--spec", default="wild")
    p.add_argument("--ticks", type=int, default=12000)
    p.add_argument("--corpus-seed", type=int, default=20260728)
    p.add_argument("--steps", type=int, default=300)
    args = p.parse_args()
    if args.bench:
        bench(args)
    else:
        p.error("nothing to do — pass --bench (the library use is `from vecenv import VecEnv`)")
