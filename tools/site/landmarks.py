#!/usr/bin/env python3
"""Post-render: fix the accessibility defects in Quarto's own chrome.

These are all in markup Quarto emits, not in anything written by hand, which is
why they are corrected here rather than in a template. Every one was found by
the 2026-08-05 audit (axe-core, three engines, five widths).

1. THREE NAVIGATION LANDMARKS, TWO UNNAMED. A post page emits nav.navbar (the
   masthead), nav#quarto-sidebar, and nav#TOC. Only the TOC has an accessible
   name, so a screen-reader user gets an undifferentiated list of "navigation".
   The masthead gets a name. The sidebar gets role="presentation": it is a bare
   wrapper whose only child is the TOC, so it should not be a landmark at all —
   presentation drops its own semantics and leaves every descendant intact.

2. TABLES DRAG THE PAGE SIDEWAYS. Quarto emits a bare <table> with no
   responsive wrapper. The IOI post's three-column comparison table cannot
   compress below 303px, so at a 320px viewport it made the whole document
   scroll horizontally — 29px, in all three engines. The site's standing rule is
   that wide content scrolls inside its own box and the page body never does
   (the same rule .katex-display already follows), so the table gets a box.
   Keyboard reachability for that box is handled at runtime by
   assets/site/scroll-boxes.html, which only makes it focusable when it is
   actually scrollable.

Stdlib only. Idempotent: re-running over an already-processed file is a no-op.
"""

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("QUARTO_PROJECT_OUTPUT_DIR", ROOT / "_site"))
if not OUT.is_absolute():
    OUT = ROOT / OUT

NAVBAR = re.compile(r"<nav\b(?![^>]*\baria-label=)([^>]*\bclass=\"[^\"]*\bnavbar\b[^\"]*\"[^>]*)>")
SIDEBAR = re.compile(r"<nav\b(?![^>]*\brole=)([^>]*\bid=\"quarto-sidebar\"[^>]*)>")
TABLE_OPEN = re.compile(r"<table\b[^>]*>", re.IGNORECASE)


def wrap_tables(html: str) -> tuple[str, int]:
    """Wrap each top-level <table> in a horizontal scroll box.

    Matches the closing tag by counting rather than with a lazy regex, so a
    nested table cannot silently truncate the wrapper.
    """
    out = []
    pos = wrapped = 0
    while True:
        m = TABLE_OPEN.search(html, pos)
        if not m:
            out.append(html[pos:])
            break
        # Already wrapped by a previous run (or by Bootstrap)? Leave it.
        if html.rfind("<div class=\"table-scroll\"", max(0, m.start() - 40), m.start()) != -1:
            out.append(html[pos : m.end()])
            pos = m.end()
            continue

        depth, i = 1, m.end()
        while depth and i < len(html):
            nxt_open = html.find("<table", i)
            nxt_close = html.find("</table>", i)
            if nxt_close == -1:
                break
            if nxt_open != -1 and nxt_open < nxt_close:
                depth += 1
                i = nxt_open + 6
            else:
                depth -= 1
                i = nxt_close + 8
        out.append(html[pos : m.start()])
        out.append('<div class="table-scroll">')
        out.append(html[m.start() : i])
        out.append("</div>")
        wrapped += 1
        pos = i
    return "".join(out), wrapped


def main() -> None:
    if not OUT.exists():
        sys.exit(f"output dir not found: {OUT}")
    navs = tables = 0
    for html in sorted(OUT.rglob("*.html")):
        text = original = html.read_text(encoding="utf-8")

        text, n1 = NAVBAR.subn(r'<nav aria-label="Site"\1>', text)
        text, n2 = SIDEBAR.subn(r'<nav role="presentation"\1>', text)
        navs += n1 + n2

        text, n3 = wrap_tables(text)
        tables += n3

        if text != original:
            html.write_text(text, encoding="utf-8")
    print(f"landmarks: named/demoted {navs} nav landmarks, wrapped {tables} tables")


if __name__ == "__main__":
    main()
