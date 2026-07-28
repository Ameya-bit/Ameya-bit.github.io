"""Sampling stacked-frame windows out of a corpus, without loading 6.7 GB of it.

A sample is `frames` consecutive decision frames ending at row i, plus the action at
row i. Materialising every window would cost `rows x frames x tokens x width` floats
— 27 GB for `train-bc` — so windows are cut on demand out of an in-memory pool of
whole episodes, and the pool rotates.

The pool is the unit because an episode is: windows never straddle a shard boundary,
which would splice two different worlds into one sample and teach a discontinuity
that cannot happen in the browser.

**Padding at the start of an episode repeats the earliest frame.** The first decision
of an episode has no history, in the corpus and on the page alike, so the rule has to
be one both sides implement identically — `net.js` primes its ring buffer the same
way. Zero-padding would be a different rule and a worse one: an all-zero frame is a
legal observation meaning "nothing present anywhere", which is a lie about the world
rather than an absence of information about it.

**`delay` trains the deployed timing.** On the page the forward pass runs in a Web
Worker on a pipelined schedule: the frame posted at decision k produces the action
applied at decision k+1. Under that contract the network answering for the action at
row i only ever saw the window ending at row i-1, so `delay=1` pairs the window at
`i - delay` with the action at `i`. D0 is the caution this option encodes: a one-tick
gap between what the net sees and when its action lands was worth most of the
direction label, so the deploy-time shift belongs in training, not discovered after
it. 0 keeps the synchronous pairing the Phase-D clone was trained with.
"""

from __future__ import annotations

import numpy as np

from corpus import Corpus


def stack_windows(obs: np.ndarray, idx: np.ndarray, frames: int) -> np.ndarray:
    """`(n, frames, tokens, width)` ending at each row in `idx`, most recent first.

    Rows before the episode's start are clamped to row 0 — the repeat-earliest rule.
    """
    # (n, frames) row indices: [i, i-1, ..., i-frames+1], floored at 0.
    back = np.arange(frames, dtype=np.int64)[None, :]
    rows = np.maximum(idx[:, None] - back, 0)
    return obs[rows]


class Pool:
    """A rotating pool of whole episodes to sample windows from."""

    def __init__(
        self,
        corpus: Corpus,
        episodes: list[int],
        *,
        frames: int,
        delay: int = 0,
        size: int = 48,
        seed: int = 0,
    ):
        if not (isinstance(delay, int) and delay >= 0):
            raise ValueError(f"delay must be a non-negative integer, got {delay!r}")
        self.corpus = corpus
        self.episodes = list(episodes)
        self.frames = frames
        self.delay = delay
        self.size = min(size, len(self.episodes))
        self.rng = np.random.default_rng(seed)
        self._order = self.rng.permutation(len(self.episodes))
        self._next = 0
        self._loaded: list[tuple[np.ndarray, np.ndarray]] = []
        for _ in range(self.size):
            self._loaded.append(self._take())

    def _take(self) -> tuple[np.ndarray, np.ndarray]:
        if self._next >= len(self._order):
            self._order = self.rng.permutation(len(self.episodes))
            self._next = 0
        ep = self.episodes[int(self._order[self._next])]
        self._next += 1
        return self.corpus.episode(ep)

    def rotate(self, n: int = 1) -> None:
        """Swap `n` episodes out for fresh ones."""
        for _ in range(n):
            self._loaded[int(self.rng.integers(len(self._loaded)))] = self._take()

    def batch(self, n: int) -> tuple[np.ndarray, np.ndarray]:
        """`(x, y)` — `(n, frames, tokens, width)` float32 and `(n,)` int64."""
        which = self.rng.integers(len(self._loaded), size=n)
        xs = np.empty((n, self.frames, self.corpus.tokens, self.corpus.obs_width), dtype=np.float32)
        ys = np.empty(n, dtype=np.int64)
        # Group by episode so each one is indexed once, vectorised, instead of n times.
        for ep in np.unique(which):
            obs, act = self._loaded[int(ep)]
            hit = np.nonzero(which == ep)[0]
            idx = self.rng.integers(len(act), size=hit.size)
            # Under the delay contract the window is `delay` rows behind the action,
            # clamped at the episode's start (those first decisions are driven by the
            # rules expert on the page while the pipeline fills, so the clamp is a
            # harmless simplification, not a distribution the deployed net will meet).
            xs[hit] = stack_windows(obs, np.maximum(idx - self.delay, 0), self.frames)
            ys[hit] = act[idx]
        return xs, ys


class SeqPool:
    """Contiguous decision windows for BPTT — Phase E's warm start samples these.

    A sample is `length` consecutive decisions: the frame the net saw at each one
    (`delay` rows behind the action, clamped at the episode start, exactly as
    `Pool.batch` pairs them) and the action taken. The recurrent net starts each
    window with zero memory, which is only *true* at an episode's first decision —
    everywhere else the honest fix is `burn`: the leading `burn` decisions run
    forward normally but are excluded from the loss, so the memory has warmed up
    before any gradient reads it (the R2D2 compromise, at corpus scale).
    """

    def __init__(
        self,
        corpus: Corpus,
        episodes: list[int],
        *,
        length: int,
        burn: int = 0,
        delay: int = 0,
        size: int = 48,
        seed: int = 0,
    ):
        self.pool = Pool(corpus, episodes, frames=1, delay=delay, size=size, seed=seed)
        self.length = length
        self.burn = burn
        self.delay = delay

    def rotate(self, n: int = 1) -> None:
        self.pool.rotate(n)

    def batch(self, n: int) -> tuple[np.ndarray, np.ndarray, int]:
        """`(x, y, burn)` — `(n, burn+length, tokens, width)`, `(n, burn+length)` int64.

        Loss belongs on `y[:, burn:]` only.
        """
        rng = self.pool.rng
        corpus = self.pool.corpus
        span = self.burn + self.length
        which = rng.integers(len(self.pool._loaded), size=n)
        xs = np.empty((n, span, corpus.tokens, corpus.obs_width), dtype=np.float32)
        ys = np.empty((n, span), dtype=np.int64)
        for ep in np.unique(which):
            obs, act = self.pool._loaded[int(ep)]
            hit = np.nonzero(which == ep)[0]
            starts = rng.integers(max(1, len(act) - span + 1), size=hit.size)
            idx = starts[:, None] + np.arange(span, dtype=np.int64)[None, :]
            idx = np.minimum(idx, len(act) - 1)  # short episodes: clamp the tail
            xs[hit] = obs[np.maximum(idx - self.delay, 0)]
            ys[hit] = act[idx]
        return xs, ys, self.burn


def whole_episodes(
    corpus: Corpus, episodes: list[int], frames: int, stride: int = 1, delay: int = 0
):
    """Every window of the given episodes, in order, an episode at a time.

    Evaluation reads the distribution as it actually occurs — including the 86% of
    decisions that are HOLD — rather than a rebalanced sample of it. `delay` is the
    deployed pairing (see the module header); evaluate with the same value trained.
    """
    for ep in episodes:
        obs, act = corpus.episode(ep)
        idx = np.arange(0, len(act), stride, dtype=np.int64)
        yield stack_windows(obs, np.maximum(idx - delay, 0), frames), act[idx]
