"""Draw the induction-head post's figures from `_data.npz` / `_data.json`.

    python3 plot.py

Needs only numpy + matplotlib — `compute.py` has already done the model work.

The rules are in `design/figures.mplstyle` and `design/direction.md`:

  * ONE WIDTH. Every figure exports at 8.0in x 160dpi = 1280px and displays at
    846px, transformer-circuits' 1.5x rule. The previous set was exported at
    1128–2210px and displayed at one width, so the same 10pt label rendered
    between 8.1px and 15.9px depending on which figure you were looking at.
  * NO IN-FIGURE TITLES. The caption is the title.
  * ONE ACCENT. Vermillion #d55e00 means "this is the finding" and appears at
    most once per figure; everything else is the site's warm gray ramp. The old
    set spent four hues (blue, green, orange, vermillion) on decoration.
  * COLORMAPS BY MEANING. Attention weights are unsigned and live in [0, 1], so
    they take a sequential map from zero — never a diverging one, which would
    invent a midpoint at 0.5 and imply negative attention exists.

The two verdict tables are NOT figures here. They are tables, so they are
written as markdown and rendered by Quarto as real tables — selectable,
searchable, reachable by a screen reader, and legible without clicking.
"""

import json
from pathlib import Path

import matplotlib as mpl
import numpy as np

# Agg BEFORE pyplot, and this line is load-bearing rather than boilerplate. On
# macOS the default backend is `macosx`, which carries a 2x device-pixel ratio
# that savefig honours: the same 8.0in figure the style file pins to 1280px
# writes 2560px instead. It is silent — nothing warns and the figure looks
# correct — so the one-width rule breaks by a factor of two depending on which
# interpreter ran the script. This set happened to be drawn under a venv that
# had already fallen back to Agg; running it with the system python would have
# produced a different width from the same committed source.
mpl.use("Agg")

from matplotlib import font_manager                  # noqa: E402
from matplotlib import pyplot as plt                 # noqa: E402
from matplotlib.patches import Rectangle             # noqa: E402

HERE = Path(__file__).parent
DESIGN = HERE.parents[2] / "design"

# Nunito is the site's typeface but loads from Google Fonts, so it is not on the
# system font path. Register the static instances vendored in design/fonts/ and
# the figures speak the page's voice instead of falling back to DejaVu Sans.
for ttf in sorted((DESIGN / "fonts").glob("*.ttf")):
    font_manager.fontManager.addfont(str(ttf))

plt.style.use(str(DESIGN / "figures.mplstyle"))

# --- The site's tokens, straight from design/direction.md --------------------
INK = "#21201c"        # --gray-1200
SECONDARY = "#57544c"  # --gray-1100
TERTIARY = "#66625a"   # --gray-1000
BORDER = "#aca99f"     # --gray-800
RULE = "#d8d5cc"       # --gray-400
PAGE = "#eeece6"       # --gray-100
ACCENT = "#d55e00"     # marks
ACCENT_INK = "#b04d00" # accent text (5.28:1)

WIDTH = 8.0            # inches; 8.0 * 160dpi = 1280px. Never changes.
# DejaVu Sans Mono ships with matplotlib, so it is named first: the figures then
# render identically on any machine, which is the same reason the style file
# pins the canvas size rather than letting bbox="tight" decide it.
MONO = ["DejaVu Sans Mono", "Menlo", "monospace"]

d = np.load(HERE / "_data.npz", allow_pickle=True)
tables = json.loads((HERE / "_data.json").read_text())


def glyph(ch: str) -> str:
    """Printable label for a single character — a space is invisible otherwise."""
    return "␣" if ch == " " else ch


def save(fig, name: str) -> None:
    fig.savefig(HERE / f"{name}.png")
    print(f"  {name}.png")
    plt.close(fig)


# ===========================================================================
# FIG 1 — the OV diagonal, raw and norm-normalized.
# ===========================================================================
def fig_ov_diagonal():
    itos = list(d["itos"])
    raw, nor, rank = d["ov_raw"], d["ov_normed"], d["ov_rank"]
    by = {c: i for i, c in enumerate(itos)}

    TOP_N = 13
    order = [itos[i] for i in np.argsort(-nor)[:TOP_N]][::-1]  # largest ends up on top
    parens = ["(", ")"]

    # The brackets sit far outside the top block — '(' is rank 39 of 177 and ')'
    # is dead last, the most anti-copied token in the vocabulary. They ride below
    # the group as a reference so the bracket-grammar hypothesis can be read
    # straight off the diagonal.
    main_y = list(range(len(order)))
    paren_y = [-1.8 - i for i in range(len(parens))]
    chars, ys = order + parens, main_y + paren_y

    def colour(c):
        return ACCENT if c == '"' else SECONDARY if c in parens else BORDER

    fig, (axL, axR) = plt.subplots(1, 2, figsize=(WIDTH, 4.6), sharey=True)
    for ax, vals, fmt, label in (
        (axL, [raw[by[c]] for c in chars], "{:.1f}", r"self-copy logit  (attend $X \rightarrow$ boost $X$)"),
        (axR, [nor[by[c]] for c in chars], "{:+.2f}", "logit ÷ (‖embed‖·‖unembed‖) per token"),
    ):
        ax.barh(ys, vals, color=[colour(c) for c in chars], height=0.66,
                edgecolor=PAGE, linewidth=0.6, zorder=3)
        ax.axvline(0, color=BORDER, lw=0.8, zorder=1)
        ax.grid(axis="x", color=RULE, lw=0.8, zorder=0)
        ax.grid(axis="y", visible=False)
        ax.axhline((min(main_y) + max(paren_y)) / 2, color=RULE, lw=0.8,
                   ls=(0, (4, 3)), zorder=1)
        ax.set_xlabel(label, fontsize=9)
        pad = 0.02 * max(abs(v) for v in vals)
        for yi, val, c in zip(ys, vals, chars):
            ax.text(val + (pad if val >= 0 else -pad), yi, fmt.format(val),
                    va="center", ha="left" if val >= 0 else "right", fontsize=8,
                    color=ACCENT_INK if c == '"' else TERTIARY)
        ax.margins(x=0.16)
        ax.set_ylim(min(paren_y) - 0.8, max(main_y) + 0.7)

    axL.set_yticks(ys)
    axL.set_yticklabels([glyph(c) for c in chars], fontsize=9.5, fontfamily=MONO)
    for ax in (axL, axR):
        ax.tick_params(axis="y", length=0)

    # The reference group gets its note in the left panel, where the two short
    # bracket bars leave the row empty: the brackets are not self-copied at all,
    # which is what the bracket-grammar section later goes on to test.
    axL.text(5.5, paren_y[1],
             f"not self-copied at all —\n'(' ranks #{rank[by['(']]} of {len(itos)}, ')' ranks last",
             fontsize=8.5, color=TERTIARY, va="center", ha="left", linespacing=1.5)
    save(fig, "fig1_make_ov_diagonal")


# ===========================================================================
# FIG 2 — copying score for all 24 heads.
# ===========================================================================
def fig_copying_score():
    labels = [str(x) for x in d["head_labels"]]
    vals = d["copying_scores"]
    star = labels.index("B5H0")
    runner = float(np.sort(vals)[-2])

    fig, ax = plt.subplots(figsize=(WIDTH, 3.5))
    ax.bar(range(len(vals)), vals, width=0.7, edgecolor=PAGE, linewidth=0.6,
           color=[ACCENT if i == star else BORDER for i in range(len(vals))], zorder=3)
    ax.axhline(runner, color=BORDER, lw=0.9, ls=(0, (4, 3)), zorder=2)
    ax.text(0.3, runner + 0.012, f"next best = {runner:.2f}", va="bottom",
            ha="left", fontsize=8.5, color=TERTIARY)

    ax.set_xticks(range(len(vals)))
    ax.set_xticklabels(labels, rotation=90, fontsize=7.5, fontfamily=MONO)
    ax.get_xticklabels()[star].set_color(ACCENT_INK)
    ax.get_xticklabels()[star].set_fontweight("bold")
    ax.set_ylabel("copying score\n(Σ Re λ / Σ |λ|, top-64 eigenvalues)", fontsize=9)
    ax.set_ylim(0, float(vals.max()) * 1.2)
    ax.tick_params(axis="x", length=0)

    ax.annotate(f"B5H0 = {vals[star]:.3f}\nthe only contender",
                xy=(star, vals[star]), xytext=(star - 3.0, vals[star] + 0.055),
                fontsize=10, fontweight="semibold", color=ACCENT_INK, ha="right", va="center",
                arrowprops=dict(arrowstyle="-|>", color=ACCENT, lw=1.3,
                                connectionstyle="arc3,rad=-0.15"))
    save(fig, "fig2_spike_copying_score")


# ===========================================================================
# FIG 3 — the content swap: the induction cell tracks the swapped token.
# ===========================================================================
def fig_induction_stripe():
    fig, axes = plt.subplots(1, 2, figsize=(WIDTH, 4.5))
    im = None
    for ax, key in zip(axes, ("cat", "dog")):
        A = d[f"{key}_A"]
        sent, q, target = d[f"{key}_meta"]
        q, target = int(q), int(target)
        chars = list(sent)
        T = len(chars)

        # Attention is unsigned and lives in [0, 1]: sequential map, pinned to 0.
        im = ax.imshow(A, cmap="Blues", vmin=0, vmax=1, aspect="equal", zorder=2)
        ax.set_xticks(range(T))
        ax.set_yticks(range(T))
        ax.set_xticklabels([glyph(c) for c in chars], fontsize=5.6, fontfamily=MONO)
        ax.set_yticklabels([glyph(c) for c in chars], fontsize=5.6, fontfamily=MONO)
        ax.set_xlabel("key  (attended-to token)", fontsize=8.5)
        ax.set_ylabel("query  (token attending)", fontsize=8.5)
        ax.tick_params(length=0)
        ax.grid(visible=False)
        for s in ax.spines.values():
            s.set_visible(False)

        # The query row in gray, the induction cell in the one accent.
        ax.add_patch(Rectangle((-0.5, q - 0.5), T, 1, fill=False, edgecolor=BORDER,
                               lw=1.0, zorder=3))
        ax.add_patch(Rectangle((target - 0.5, q - 0.5), 1, 1, fill=False,
                               edgecolor=ACCENT, lw=1.8, zorder=4))
        for labels, i in ((ax.get_yticklabels(), q), (ax.get_xticklabels(), target)):
            labels[i].set_color(ACCENT_INK)
            labels[i].set_fontweight("bold")

        ax.annotate(f"{glyph(chars[q])} → {glyph(chars[target])}   w = {A[q, target]:.2f}",
                    xy=(target, q), xytext=(target + 3.5, q - 7.0), fontsize=9,
                    fontweight="semibold", color=ACCENT_INK, ha="left", va="center",
                    arrowprops=dict(arrowstyle="-|>", color=ACCENT, lw=1.3,
                                    connectionstyle="arc3,rad=0.2"))
        ax.set_title(f'"{sent}"', fontsize=8.5, loc="left", pad=6, fontfamily=MONO,
                     color=TERTIARY, fontweight="normal")

    cbar = fig.colorbar(im, ax=axes, fraction=0.022, pad=0.02, shrink=0.62)
    cbar.set_label("attention weight", fontsize=8.5, color=TERTIARY)
    cbar.ax.tick_params(labelsize=8, length=0)
    cbar.outline.set_visible(False)
    save(fig, "fig3_divert_induction_stripe")


# ===========================================================================
# The verdict tables — markdown, not pixels.
# ===========================================================================
def verdict_table(rows, path, note):
    """One row per prompt: the query, the three most-attended tokens, the call.

    Every cell that holds a character from the test string is set in backticks,
    so the table reads in the same monospace the test strings do and a literal
    space shows as ␣ rather than as an empty cell.
    """
    # Column widths come from the separator dashes — pandoc reads their relative
    # lengths — because the test-string column holds up to 64 characters and the
    # rest hold three or four. Left to itself pandoc gives all seven an equal
    # seventh of the table and the strings wrap four lines deep.
    head = ["Prompt", "Test string", "Query", "Top 1", "Top 2", "Top 3", "Verdict"]
    widths = [14, 40, 7, 10, 10, 10, 9]
    out = ["| " + " | ".join(head) + " |",
           "|" + "|".join(":" + "-" * w for w in widths) + "|"]
    for r in rows:
        # A pipe inside a cell would end the cell, and a bare @N is a pandoc
        # citation — `@54` came out as <span class="citation" data-cites="54">.
        sent = r["sentence"].replace("|", "\\|")
        cells = [f"**{r['label']}**", f"`{sent}`",
                 f"`{glyph(r['query_char'])}`&nbsp;\\@{r['q']}"]
        for pos, ch, w in r["ranked"]:
            cells.append(f"`{glyph(ch)}`&nbsp;\\@{pos} · {w:.2f}")
        cells.append(r["verdict"])
        out.append("| " + " | ".join(cells) + " |")
    out += ["", f": {note}", ""]
    path.write_text("\n".join(out) + "\n")
    print(f"  {path.name}  {len(rows)} rows")


if __name__ == "__main__":
    print(f"drawing -> {HERE}")
    fig_ov_diagonal()
    fig_copying_score()
    fig_induction_stripe()
    verdict_table(
        tables["quote"], HERE / "_quote-table.md",
        "The quote tests. `@N` is a token position and each weight is that "
        "token's share of B5H0's attention (softmax over keys). A verdict of "
        "*induction* means the top-attended token is the one that followed the "
        "query's own earlier occurrence; *sink* means position 0, where "
        "attention goes when nothing qualifies. {#tbl-quote}",
    )
    verdict_table(
        tables["paren"], HERE / "_paren-table.md",
        "The parenthesis tests, read the same way. {#tbl-paren}",
    )
