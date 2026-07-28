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
        size: int = 48,
        seed: int = 0,
    ):
        self.corpus = corpus
        self.episodes = list(episodes)
        self.frames = frames
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
            xs[hit] = stack_windows(obs, idx, self.frames)
            ys[hit] = act[idx]
        return xs, ys


def whole_episodes(corpus: Corpus, episodes: list[int], frames: int, stride: int = 1):
    """Every window of the given episodes, in order, an episode at a time.

    Evaluation reads the distribution as it actually occurs — including the 86% of
    decisions that are HOLD — rather than a rebalanced sample of it.
    """
    for ep in episodes:
        obs, act = corpus.episode(ep)
        idx = np.arange(0, len(act), stride, dtype=np.int64)
        yield stack_windows(obs, idx, frames), act[idx]
