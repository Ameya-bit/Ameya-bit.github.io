"""Reading a cut corpus, from its manifest alone.

The whole loader is `np.fromfile(path, '<f4').reshape(-1, width)` — that is the
property B4 bought by making the unit of a file one episode, and this module exists
mostly to keep it true. Everything else here is the manifest's own description of
its bytes: block offsets, the observation layout, the action vocabulary.

Two things are checked rather than assumed, because both fail silently otherwise:

  * the shard's byte length matches `rows x width x 4` from the manifest, and
  * `rollout.alignment` is `decision` (D0). A v1 corpus has `obs` taken *after* the
    step that applied `action`, which trains a clone to read its own facing instead
    of the world. It looks like an ordinary corpus and scores better. Refuse it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SHARD_VERSION = 2
ALIGNMENT = "decision"


@dataclass(frozen=True)
class Block:
    """One named region of a row: `repeat` sub-rows of `width` floats."""

    name: str
    at: int
    repeat: int
    width: int

    @property
    def size(self) -> int:
        return self.repeat * self.width


class Corpus:
    """A cut corpus: the manifest, its shards, and where things sit in a row."""

    def __init__(self, manifest_path: str | Path):
        self.path = Path(manifest_path)
        self.manifest = json.loads(self.path.read_text())
        m = self.manifest

        if m["version"] != SHARD_VERSION:
            raise ValueError(
                f"{self.path.name}: shard version {m['version']}, expected {SHARD_VERSION}. "
                "Re-cut it (node cut.js ...) — the row's meaning changed, not just its layout."
            )
        align = m["rollout"].get("alignment")
        if align != ALIGNMENT:
            raise ValueError(
                f"{self.path.name}: alignment {align!r}, expected {ALIGNMENT!r}. "
                "A tick-aligned corpus pairs each action with the frame it produced, "
                "which hands a clone its own facing as the label."
            )

        self.dir = self.path.parent / m["dir"]
        self.obs_layout = m["observation"]
        self.tokens = self.obs_layout["tokens"]
        self.obs_width = self.obs_layout["width"]
        self.frame_len = self.obs_layout["length"]
        self.action_names = m["actions"]["names"]
        self.n_actions = m["actions"]["count"]
        self.stride = m["rollout"]["stride"]
        self.field = {f["name"]: (f["at"], f["size"]) for f in self.obs_layout["fields"]}
        # Truth label vocabularies (mode names, anomaly kinds) — {} on a --no-truth cut.
        self.labels = m.get("truth", {}).get("labels", {})

    # ---- the row template, resolved ----

    def blocks(self, panda_count: int) -> dict[str, Block]:
        """Block offsets for a shard with `panda_count` pandas in it.

        Row width is not constant across a corpus — panda count is a per-episode
        draw — so offsets are resolved per shard, from the same template the writer
        used. `pandaCount` is the one repeat the episode decides.
        """
        out: dict[str, Block] = {}
        at = 0
        for spec in self.manifest["row"]["blocks"]:
            repeat = panda_count if spec["repeat"] == "pandaCount" else int(spec["repeat"])
            block = Block(spec["name"], at, repeat, int(spec["width"]))
            out[block.name] = block
            at += block.size
        return out

    # ---- the shards ----

    @property
    def shards(self) -> list[dict]:
        return self.manifest["shards"]

    def load(self, index: int) -> tuple[np.ndarray, dict[str, Block]]:
        """One episode as `(rows, width)` float32, plus its block offsets."""
        entry = self.shards[index]
        raw = np.fromfile(self.dir / entry["file"], dtype="<f4")
        expected = entry["rows"] * entry["width"]
        if raw.size != expected:
            raise ValueError(
                f"{entry['file']}: {raw.size} floats, manifest says {expected} "
                f"({entry['rows']} rows x {entry['width']}). Re-cut or re-verify the corpus."
            )
        return raw.reshape(entry["rows"], entry["width"]), self.blocks(entry["pandaCount"])

    def truth_fields(self, block: str) -> dict[str, int]:
        """Column name -> index for a truth block (`slots` / `entities` / `global`)."""
        for spec in self.manifest["row"]["blocks"]:
            if spec["name"] == block and "fields" in spec:
                return {name: i for i, name in enumerate(spec["fields"])}
        raise KeyError(f"no fields recorded for block {block!r} — was this corpus cut --no-truth?")

    def truth(self, index: int) -> tuple[np.ndarray, np.ndarray]:
        """`(slots, entities)` for one episode — the labels a policy never sees.

        slots is `(rows, 8, 4)` (which panda each obs token addressed — the join
        Phase G's probes need); entities is `(rows, pandaCount, 32)` with sub-row
        k pinned to panda id k. Column names come from `truth_fields`.
        """
        rows, blocks = self.load(index)
        s, e = blocks["slots"], blocks["entities"]
        slots = rows[:, s.at : s.at + s.size].reshape(-1, s.repeat, s.width)
        ents = rows[:, e.at : e.at + e.size].reshape(-1, e.repeat, e.width)
        return slots, ents

    def episode(self, index: int) -> tuple[np.ndarray, np.ndarray]:
        """`(obs, action)` for one episode.

        obs is `(rows, tokens, obs_width)`; action is `(rows,)` int64. Both are the
        decision record: row i is the frame he chose from and the action he took.
        """
        rows, blocks = self.load(index)
        obs = blocks["obs"]
        frames = rows[:, obs.at : obs.at + obs.size].reshape(-1, self.tokens, self.obs_width)
        act = rows[:, blocks["action"].at].astype(np.int64)
        if act.min() < 0 or act.max() >= self.n_actions:
            raise ValueError(f"episode {index}: action out of range [{act.min()}, {act.max()}]")
        return frames, act

    def __len__(self) -> int:
        return len(self.shards)

    def __repr__(self) -> str:
        m = self.manifest
        return (
            f"<Corpus {m['name']} spec={m['spec']} {len(self)} episodes "
            f"{m['totals']['samples']:,} rows tokens={self.tokens}x{self.obs_width} "
            f"cone={self.obs_layout['params']['coneDeg']}>"
        )
