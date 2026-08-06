#!/usr/bin/env python3
"""Post-render: drop the Bootstrap Icons set, which this site does not use.

WHAT IT COSTS TO KEEP. Quarto links `bootstrap-icons.css` on every page and
ships `bootstrap-icons.woff` beside it — 97 KB of stylesheet (14 KB gzipped,
render-blocking, on every page) declaring 2,000-odd glyphs, plus a 176 KB font.
This site has no icons anywhere. Measured on the built output before this
script existed: ZERO `.bi-*` classes across all nine pages.

WHY THE FONT IS NOT THE POINT, even though it is the big number. A browser
fetches a webfont only when a rendered element matches a rule using it, so with
no `.bi-*` element on the page the 176 KB woff was never downloaded by anyone.
It was artifact weight, not reader weight. The stylesheet is the real cost: it
IS fetched, on every page, render-blocking, to define an icon set nothing asks
for. Removing the file too is just honesty about what the deploy contains.

WHY POST-RENDER. Quarto has no switch for this — the icon link is emitted by
the HTML format itself, and the alternative is forking the format. A build step
that removes a thing we can prove is unused is the smaller intervention, and it
re-checks the proof on every render rather than trusting a note.

THE TRIPWIRE IS THE POINT. This script does not strip blindly. It scans the
built HTML for icon usage first and REFUSES to remove anything if it finds any
— so the day a page legitimately wants an icon, the build tells us instead of
silently serving a page with a missing glyph. Same pattern as the rail's
ellipsis and the two-category cap on the filing row: where a guarantee depends
on what a future page declares, put the guarantee where the build can see it.

Runs after landmarks/img-attrs; stdlib only.
"""

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("QUARTO_PROJECT_OUTPUT_DIR", ROOT / "_site"))
if not OUT.is_absolute():
    OUT = ROOT / OUT

# The <link> as Quarto emits it, at whatever relative depth the page sits.
LINK = re.compile(
    r'[ \t]*<link[^>]+href="[^"]*bootstrap-icons\.css"[^>]*>\n?', re.I)

CLASS_ATTR = re.compile(r'class="([^"]*)"', re.I)

ASSETS = ("bootstrap-icons.css", "bootstrap-icons.woff")


def uses_icons(html: str) -> bool:
    """True if any element carries an icon class.

    Tokenised rather than pattern-matched on the raw text, because Bootstrap's
    sheet matches exactly `.bi`, `[class^="bi-"]` and `[class*=" bi-"]` — i.e.
    whole class tokens. A substring test would trip on any attribute value
    containing "bi-" and report usage that does not exist.
    """
    for attr in CLASS_ATTR.finditer(html):
        for token in attr.group(1).split():
            if token == "bi" or token.startswith("bi-"):
                return True
    return False


def main() -> None:
    pages = sorted(OUT.rglob("*.html"))
    if not pages:
        print("drop-icons: no built HTML — nothing to do")
        return

    # 1. Prove the set is unused before touching anything.
    users = [p for p in pages if uses_icons(p.read_text(encoding="utf-8"))]
    if users:
        rel = ", ".join(str(p.relative_to(OUT)) for p in users[:5])
        sys.exit(
            f"drop-icons: {len(users)} page(s) now use Bootstrap Icons "
            f"({rel}) — refusing to strip, because doing so would serve those "
            "pages a missing glyph. Either replace the icon with the site's "
            "own material, or remove this step from _quarto.yml and accept "
            "the stylesheet on every page.")

    # 2. Unlink the stylesheet from every page.
    stripped = 0
    for page in pages:
        html = page.read_text(encoding="utf-8")
        new, n = LINK.subn("", html)
        if n:
            page.write_text(new, encoding="utf-8")
            stripped += n

    # 3. Remove the files themselves, so the deployed artifact matches what the
    #    pages actually reference.
    freed = 0
    for name in ASSETS:
        f = OUT / "site_libs" / "bootstrap" / name
        if f.exists():
            freed += f.stat().st_size
            f.unlink()

    print(f"drop-icons: unlinked from {stripped} pages, "
          f"removed {freed / 1024:.0f} KB of unused icon set")


if __name__ == "__main__":
    main()
