"""Draw the IOI post's figures from `_data.npz`.

    python3 plot.py

Needs only numpy + matplotlib — `compute.py` has already done the model work, so
the whole visual language can be reworked without a CPU rerun.

The rules being followed are in `design/figures.mplstyle` and `design/direction.md`:

  * ONE WIDTH. Every figure exports at 8.0in x 160dpi = 1280px and displays at
    846px, transformer-circuits' 1.5x rule. A shared width is what makes a set of
    figures read as a set; height is free to follow the content.
  * NO IN-FIGURE TITLES. The caption is the title. A bold headline inside the PNG
    competes with the h2 above it and duplicates the figcaption underneath.
  * ONE ACCENT. Vermillion #d55e00 means "this is the finding" and appears at most
    once per figure. Everything else is the site's warm gray ramp. The previous
    set used four different highlight colours across six figures.
  * COLORMAPS BY MEANING. Signed quantities get a diverging map pinned to zero;
    unsigned quantities get a sequential map from zero.
"""

from pathlib import Path

import matplotlib as mpl
import numpy as np
from matplotlib import font_manager
from matplotlib import pyplot as plt
from matplotlib.patches import Rectangle

HERE = Path(__file__).parent
DESIGN = HERE.parents[2] / "design"

# Nunito is the site's typeface but is loaded from Google Fonts, so it is not on
# the system font path. Register the three weights vendored in design/fonts/ and
# the figures speak the page's voice instead of falling back to DejaVu Sans.
# (They are static instances cut from the variable font at wght 400/500/600 —
# matplotlib cannot read variation axes, only named static faces.)
for ttf in sorted((DESIGN / "fonts").glob("*.ttf")):
    font_manager.fontManager.addfont(str(ttf))

plt.style.use(str(DESIGN / "figures.mplstyle"))

# --- The site's tokens, straight from design/direction.md --------------------
INK = "#21201c"        # --gray-1200
SECONDARY = "#57544c"  # --gray-1100
TERTIARY = "#66625a"   # --gray-1000
BORDER = "#aca99f"     # --gray-800
RULE = "#d8d5cc"       # --gray-400
SURFACE = "#e8e6df"    # --gray-200
PAGE = "#eeece6"       # --gray-100
ACCENT = "#d55e00"     # marks
ACCENT_INK = "#b04d00" # accent text (5.28:1)

WIDTH = 8.0            # inches; 8.0 * 160dpi = 1280px. Never changes.

data = np.load(HERE / "_data.npz", allow_pickle=True)
DLA = data["dla"].reshape(12, 12)
RESID = data["resid"]
HEADS = data["heads"]
L8H6, L9H9 = data["l8h6"], data["l9h9"]
TOKENS = [str(t) for t in data["str_tokens"]]
(CLEAN_LD, CORR_LD, ACCURACY,
 CLEAN_ONE, CORR_ONE, PATH_RESID, PATH_ALL_Q, PATH_L9H9) = data["scalars"]
N = int(data["n_prompts"])

# `<|endoftext|>` is 13 characters of tokenizer plumbing on an axis that has 15
# slots; the shorter form is what every circuits paper prints.
TOKENS = ["<bos>" if t.startswith("<|") else t.strip() or t for t in TOKENS]
S2_POS, END_POS = 10, 14


def finish(fig, name):
    """Save at the one width the whole set shares."""
    out = HERE / name
    fig.savefig(out, facecolor=PAGE)
    plt.close(fig)
    px = fig.get_size_inches() * fig.dpi
    print(f"  {name}  {int(px[0])}x{int(px[1])}px nominal")


def bare(ax):
    """Strip an axes to data and labels — no box, no default grid."""
    for side in ("top", "right", "left", "bottom"):
        ax.spines[side].set_visible(False)
    ax.grid(False)
    ax.tick_params(length=0, colors=TERTIARY)


def slim_colorbar(fig, im, ax, label, **kw):
    cbar = fig.colorbar(im, ax=ax, fraction=0.028, pad=0.02, aspect=28, **kw)
    cbar.outline.set_visible(False)
    cbar.ax.tick_params(length=0, colors=TERTIARY, labelsize=9)
    cbar.set_label(label, color=SECONDARY, fontsize=9)
    return cbar


# ---------------------------------------------------------------------------
# 1. Direct logit attribution — who writes the answer
#
# Horizontal bars, top 10, one vermillion bar. The old version put the highlight
# in tab10 blue and hung a two-line blue callout off it; the caption says the
# same thing in the page's own type, so the callout is gone and the colour is now
# the site accent.
# ---------------------------------------------------------------------------

def fig_dla():
    flat = DLA.flatten()
    order = flat.argsort()[::-1][:10]
    labels = [f"L{i // 12}H{i % 12}" for i in order]
    values = flat[order]

    fig, ax = plt.subplots(figsize=(WIDTH, 4.0))
    y = np.arange(len(order))[::-1]
    colors = [ACCENT if i == 0 else BORDER for i in range(len(order))]
    ax.barh(y, values, height=0.62, color=colors)

    for yi, v, c in zip(y, values, colors):
        ax.text(v + 0.06, yi, f"{v:+.2f}", va="center", fontsize=9,
                color=ACCENT_INK if c == ACCENT else TERTIARY)

    ax.set_yticks(y, labels, fontsize=9.5)
    ax.get_yticklabels()[0].set_color(ACCENT_INK)
    ax.set_xlabel(f"direct logit attribution to the (IO − S) direction, mean over {N} prompts",
                  color=SECONDARY)
    ax.set_xlim(0, values.max() * 1.12)
    bare(ax)
    ax.xaxis.grid(True, color=RULE, linewidth=0.8)
    ax.set_axisbelow(True)
    finish(fig, "fig1_dla_ranking.png")


# ---------------------------------------------------------------------------
# 2. Residual-stream patching over (layer, position)
#
# Recovery here is bounded below near zero (see the printed range), so this is
# the SEQUENTIAL case: a diverging map would invent a midpoint the data has no
# meaning for. The hand-off is marked with one horizontal accent rule instead of
# the old curved arrow, and the token labels are horizontal — at 1280px there is
# room for all fifteen, and rotating them 90 degrees was costing legibility for
# nothing.
# ---------------------------------------------------------------------------

def fig_resid():
    print(f"  resid recovery range [{RESID.min():+.3f}, {RESID.max():+.3f}]")
    fig, ax = plt.subplots(figsize=(WIDTH, 4.6))
    im = ax.imshow(RESID, cmap="Blues", origin="lower", aspect="auto",
                   vmin=0, vmax=max(1.0, RESID.max()))

    ax.set_xticks(range(len(TOKENS)), TOKENS, fontsize=9)
    ax.set_yticks(range(0, 12), [str(i) for i in range(12)], fontsize=9)
    ax.set_ylabel("layer", color=SECONDARY)
    bare(ax)

    for pos, name in ((S2_POS, "S2"), (END_POS, "END")):
        ax.get_xticklabels()[pos].set_color(ACCENT_INK)
        ax.get_xticklabels()[pos].set_fontweight("medium")
        ax.text(pos, 12.05, name, ha="center", va="bottom", fontsize=9,
                color=ACCENT_INK, fontweight="medium")

    # The hand-off: information stops mattering at S2 and starts mattering at END
    # at the same depth. One rule across the plot says it without an arrow.
    ax.axhline(7.5, color=ACCENT, linewidth=1.1)
    ax.text(-0.9, 7.5, "hand-off", ha="right", va="center", fontsize=9,
            color=ACCENT_INK, fontweight="medium")

    slim_colorbar(fig, im, ax, "normalized logit-diff recovery")
    finish(fig, "fig2_resid_patching.png")


# ---------------------------------------------------------------------------
# 3. Attention-head patching at END
#
# Signed, so RdBu_r pinned to zero — the negative name movers are the point of
# the figure and an autoscaled midpoint would misstate which cells are negative.
# The old version floated a three-colour legend in ~250px of empty canvas below
# the plot; the named cells now carry thin ink outlines and one text line sits
# directly under the axis. Two fewer colours, no dead space.
# ---------------------------------------------------------------------------

NAMED = {(8, 6): "S-inhibition", (8, 10): "S-inhibition", (9, 9): "name mover",
         (10, 7): "negative name mover", (11, 10): "negative name mover"}


def fig_heads():
    block = HEADS[8:]                       # layers 8-11; below that was not swept
    lim = np.abs(block).max()
    fig, ax = plt.subplots(figsize=(WIDTH, 3.5))
    im = ax.imshow(block, cmap="RdBu_r", origin="lower", aspect="auto",
                   vmin=-lim, vmax=lim)

    for (layer, head) in NAMED:
        ax.add_patch(Rectangle((head - 0.5, layer - 8 - 0.5), 1, 1,
                               fill=False, edgecolor=INK, linewidth=1.3))

    ax.set_xticks(range(12), [str(i) for i in range(12)], fontsize=9)
    ax.set_yticks(range(4), [str(8 + i) for i in range(4)], fontsize=9)
    ax.set_xlabel("head", color=SECONDARY)
    ax.set_ylabel("layer", color=SECONDARY)
    bare(ax)

    # The key goes in the title slot, not floating below the axis: constrained
    # layout reserves room for a title and does not for a stray ax.text, which is
    # how the first attempt cropped it off the canvas entirely.
    ax.set_title("outlined:   8.6 · 8.10  S-inhibition      9.9  name mover"
                 "      10.7 · 11.10  negative name movers",
                 loc="left", fontsize=9, color=TERTIARY, fontweight="normal", pad=10)

    slim_colorbar(fig, im, ax, "normalized logit-diff recovery")
    finish(fig, "fig3_head_patching.png")


# ---------------------------------------------------------------------------
# 4. The two labelled heads, one figure, one colorbar
#
# Was two separate figures at two different widths. They share axes, share a
# scale, and the post reads them as a pair — "L8H6 reads the repeat, L9H9 writes
# the answer" — so they are one figure.
#
# The BOS column is MASKED. It took ~0.6 of the mass on every row, which pinned
# the colour scale and forced two sentences of prose and two caption clauses
# telling the reader to look underneath it. Masking is honest (the column is
# drawn, in gray, and the caption gives the number) and it lets the remaining
# 14 columns use the full range, which is where the task actually lives.
# ---------------------------------------------------------------------------

def fig_attention():
    panels = [(L8H6, "L8H6", " John", TOKENS.index("John", 6)),
              (L9H9, "L9H9", " Mary", TOKENS.index("Mary"))]

    # The masked column has to be visibly a column, not a gap — SURFACE on PAGE is
    # a 1% difference and read as "nothing was plotted here".
    cmap = mpl.colormaps["Blues"].with_extremes(bad="#eceae7")
    vmax = max(np.max(p[:, 1:]) for p, *_ in panels)

    fig, axes = plt.subplots(1, 2, figsize=(WIDTH, 4.5),
                             gridspec_kw={"wspace": 0.12})

    for ax, (pattern, name, target, col) in zip(axes, panels):
        shown = np.ma.masked_invalid(np.where(
            np.arange(pattern.shape[1])[None, :] == 0, np.nan, pattern))
        im = ax.imshow(shown, cmap=cmap, vmin=0, vmax=vmax, aspect="equal")

        ax.add_patch(Rectangle((col - 0.5, END_POS - 0.5), 1, 1,
                               fill=False, edgecolor=ACCENT, linewidth=1.6))

        ax.set_xticks(range(len(TOKENS)), TOKENS, rotation=90, fontsize=8)
        ax.set_yticks(range(len(TOKENS)), TOKENS if ax is axes[0] else [], fontsize=8)
        ax.set_xlabel("source  (attended to)", color=SECONDARY, fontsize=9.5)
        bare(ax)

        ax.get_xticklabels()[0].set_color(BORDER)
        ax.get_xticklabels()[col].set_color(ACCENT_INK)
        ax.get_yticklabels()[END_POS].set_color(ACCENT_INK) if ax is axes[0] else None
        ax.text(0, 1.02, f"{name} → {target.strip()}", transform=ax.transAxes,
                ha="left", va="bottom", fontsize=10, color=INK, fontweight="medium")

    axes[0].set_ylabel("destination  (attending from)", color=SECONDARY, fontsize=9.5)
    slim_colorbar(fig, im, axes[1], "attention weight")
    finish(fig, "fig4_attention_patterns.png")


# ---------------------------------------------------------------------------
# 5. Path patching — narrowing the receiver
#
# Three bars, not two, and this is the correction. The published version showed
# 0.24 against 0.10 and read the gap as "the rest of the name-mover family".
# It is not: 0.24 was measured into block 9's whole RESIDUAL input — queries,
# keys, values, and everything layers 10 and 11 read downstream — while 0.10 was
# measured into one head's query. Two different interventions, so the difference
# between them was never attributable to anything.
#
# Holding the receiver type fixed and narrowing it (all queries -> one query) is
# the comparison that means something, and it is the middle bar that makes the
# figure honest.
# ---------------------------------------------------------------------------

def fig_path():
    rows = [
        ("the whole residual input to block 9\n(queries, keys, values, and every layer above)",
         PATH_RESID, BORDER, TERTIARY),
        ("every head in block 9, query side only", PATH_ALL_Q, BORDER, TERTIARY),
        ("L9H9's query alone  —  the single edge", PATH_L9H9, ACCENT, ACCENT_INK),
    ]

    fig, ax = plt.subplots(figsize=(WIDTH, 3.0))
    y = np.arange(len(rows))[::-1]
    ax.barh(y, [r[1] for r in rows], height=0.5, color=[r[2] for r in rows])
    for yi, (_, v, _, textc) in zip(y, rows):
        ax.text(v + 0.008, yi, f"{v:.2f}", va="center", fontsize=9.5, color=textc)

    ax.axvline(1.0, color=BORDER, linewidth=1, linestyle=(0, (3, 3)))
    ax.text(0.985, len(rows) - 1.35, "the full clean → corrupted swing",
            ha="right", va="center", fontsize=9, color=TERTIARY)

    ax.set_yticks(y, [r[0] for r in rows], fontsize=9.5)
    ax.get_yticklabels()[-1].set_color(ACCENT_INK)
    ax.set_xlim(0, 1.06)
    ax.set_xlabel("fraction of the swing that flows through that receiver alone",
                  color=SECONDARY)
    bare(ax)
    ax.xaxis.grid(True, color=RULE, linewidth=0.8)
    ax.set_axisbelow(True)
    finish(fig, "fig5_path_patching.png")


# ---------------------------------------------------------------------------
# 6. The blind spots, as geometry (new)
#
# The post's thesis is that each method is bright exactly where its own machinery
# is sensitive — and both methods have now been run per-head on the same 100
# prompts, so the claim can be plotted rather than asserted. DLA on x, patching
# recovery on y, every head in layers 8-11. The name movers sit far right and
# low; the S-inhibition heads sit high and at x≈0. Nothing new is measured here;
# it is figures 1 and 3 on one pair of axes.
# ---------------------------------------------------------------------------

def fig_blindspots():
    xs, ys, names = [], [], []
    for layer in range(8, 12):
        for head in range(12):
            xs.append(DLA[layer, head])
            ys.append(HEADS[layer, head])
            names.append((layer, head))

    xs, ys = np.array(xs), np.array(ys)
    marked = [i for i, n in enumerate(names) if n in NAMED]
    plain = [i for i in range(len(names)) if i not in marked]

    fig, ax = plt.subplots(figsize=(WIDTH, 4.4))
    ax.set_xlim(-3.0, 4.1)
    ax.set_ylim(-0.68, 0.47)
    ax.axhline(0, color=BORDER, linewidth=0.9)
    ax.axvline(0, color=BORDER, linewidth=0.9)
    ax.scatter(xs[plain], ys[plain], s=26, color=BORDER, linewidths=0)
    ax.scatter(xs[marked], ys[marked], s=42, color=ACCENT, linewidths=0)

    for i in marked:
        layer, head = names[i]
        ax.annotate(f"{layer}.{head}", (xs[i], ys[i]),
                    textcoords="offset points", xytext=(8, 4),
                    fontsize=9.5, color=ACCENT_INK, fontweight="medium")

    ax.set_xlabel("direct logit attribution   →   what DLA sees", color=SECONDARY)
    ax.set_ylabel("patching recovery at END\n→   what patching sees", color=SECONDARY)
    bare(ax)
    ax.grid(True, color=RULE, linewidth=0.8)
    ax.set_axisbelow(True)

    # Three notes, each sitting directly under the points it describes, so no
    # leader lines are needed. They exist because drawing this figure corrected
    # the claim it was made to illustrate: DLA is NOT blind to the upstream and
    # negative heads in general. Of the five named heads it ranks four at 1st,
    # 6th, 143rd and 144th of 144. Exactly one — L8H6, at 138th — is invisible to
    # it, and that is the whole disagreement.
    notes = [
        (-0.20, 0.29, "right", "8.6 — DLA ranks it 138th of 144.\nthe one head DLA misses"),
        (3.42, 0.19, "right", "DLA's headline result;\npatching understates it"),
        (-2.42, -0.46, "left", "DLA ranks these 144th and 143rd;\nboth methods agree on the sign"),
    ]
    for x, y, ha, text in notes:
        ax.annotate(text, (x, y), fontsize=9, color=TERTIARY, va="top", ha=ha)

    finish(fig, "fig6_blind_spots.png")


if __name__ == "__main__":
    print(f"prompts: {N}   clean {CLEAN_LD:+.2f}   corrupted {CORR_LD:+.2f}   "
          f"accuracy {ACCURACY:.0%}")
    fig_dla()
    fig_resid()
    fig_heads()
    fig_attention()
    fig_path()
    fig_blindspots()
