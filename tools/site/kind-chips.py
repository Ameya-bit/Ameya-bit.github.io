#!/usr/bin/env python3
"""Post-render: move each listing's `kind` chip from the filing column to the title.

WHAT THE CHIP IS FOR. A reader landing cold on the homepage cannot tell that the
neutron-star piece is a manuscript and the IOI piece is a comparison of three
methods. The titles are good and they answer "what is this about"; nothing on the
page answers "what KIND of thing is this". transformer-circuits.pub — the closest
neighbour this site has in genre — marks every entry `paper` / `note` / `github`
for exactly that reason, and it is the cheapest useful thing an index can carry.

THE DATA IS THE POST'S OWN. Each post declares `kind:` in its front matter and
the homepage listing asks for it in `fields:`, so the chip is Quarto's own
extraction rather than a second list maintained here. Add a post with no `kind:`
and it simply renders without a chip; change the word in the front matter and the
chip changes. There is no taxonomy stored in this file, which is the point — a
label that lives in two places will eventually disagree with itself.

WHY THIS SCRIPT EXISTS AT ALL. Quarto renders every requested field into the
`.metadata` cell of the listing grid, which puts the chip in the far right column
under the date. That is the wrong place for it twice over: it is a third stacked
line in a filing column that was deliberately collapsed to one, and it sits ~40
characters from the title it qualifies, so the reader has to travel to it. The
chip belongs immediately before the title, where it is read as part of the same
phrase. CSS cannot reparent a node between two grid cells, so the move happens
here, at build time — which is strictly better than doing it in the browser: the
served HTML is already correct, and a reader with JS off sees the same page.

IDEMPOTENT AND LOUD. A chip already in place is left alone. If Quarto stops
emitting `listing-kind` — a renamed class, a dropped field — the run fails rather
than silently serving an index with the chips missing, because a missing chip
looks exactly like a post that never declared a kind.

Stdlib only, per the house rule.
"""

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("QUARTO_PROJECT_OUTPUT_DIR", ROOT / "_site"))
if not OUT.is_absolute():
    OUT = ROOT / OUT

# Quarto's shape for a custom field, e.g.
#   <div class="metadata-value listing-kind">\nPaper\n</div>
KIND = re.compile(
    r'[ \t]*<div class="metadata-value listing-kind">\s*(.*?)\s*</div>\n?',
    re.DOTALL,
)

# The title cell of the same row. Quarto wraps the title in an <a>; the chip goes
# INSIDE that anchor so it shares the row's single link target and can never
# become a second, smaller click surface next to it.
TITLE_OPEN = re.compile(
    r'(<h3 class="[^"]*listing-title">\s*<a\b[^>]*>)',
    re.IGNORECASE,
)


def relocate(html: str) -> tuple[str, int]:
    """Move every .listing-kind in `html` from its metadata cell into its title."""
    moved = 0
    out = []

    # Row by row, so a chip can never be attached to a neighbour's title. The
    # listing rows are flat siblings, so splitting on the row opener is enough.
    parts = html.split('<div class="quarto-post')
    for i, part in enumerate(parts):
        if i == 0:
            out.append(part)
            continue
        m = KIND.search(part)
        if not m:
            out.append('<div class="quarto-post' + part)
            continue
        label = m.group(1).strip()
        if not label:
            out.append('<div class="quarto-post' + part)
            continue
        stripped = KIND.sub("", part, count=1)
        chip = f'<span class="listing-kind-chip">{label}</span>'
        stripped, n = TITLE_OPEN.subn(r"\1" + chip, stripped, count=1)
        if n == 0:
            # A row with a kind but no title is a shape this script does not know.
            print(
                f"kind-chips: found a kind ({label!r}) with no listing-title to attach it to",
                file=sys.stderr,
            )
            sys.exit(1)
        moved += 1
        out.append('<div class="quarto-post' + stripped)

    return "".join(out), moved


def main() -> None:
    index = OUT / "index.html"
    if not index.exists():
        print(f"kind-chips: no {index} to process", file=sys.stderr)
        sys.exit(1)

    html = index.read_text(encoding="utf-8")

    if "listing-kind-chip" in html:
        print("kind-chips: already placed, nothing to do")
        return

    if 'class="metadata-value listing-kind"' not in html:
        print(
            "kind-chips: Quarto emitted no listing-kind fields. Either `kind` left the "
            "listing's `fields:` in index.qmd, or the posts lost their front-matter "
            "`kind:`, or Quarto renamed the class. Refusing to ship a chip-less index "
            "silently.",
            file=sys.stderr,
        )
        sys.exit(1)

    html, moved = relocate(html)
    index.write_text(html, encoding="utf-8")
    print(f"kind-chips: moved {moved} chip{'s' if moved != 1 else ''} to their titles")


if __name__ == "__main__":
    main()
