#!/usr/bin/env python3
"""Render the homepage's share card to assets/og-card.png.

WHY THIS EXISTS. Every post declares its own `image:`, so a share of a post has
always produced a proper card. The index had none, so every share of the site
itself rendered as a text-only link (design/direction.md, open decision #5).

WHY IT IS GENERATED RATHER THAN DRAWN. The card has to be the site, and a card
hand-drawn once is a second design that starts drifting from the first the day
after it ships. So the values are not typed here: the ramp and the type stack are
READ OUT OF styles.scss at build time, and the face is the same Nunito the site
serves. Change a token, re-run this, and the card follows. If a token this script
needs ever disappears, it fails loudly rather than silently rendering last year's
palette.

WHY IT IS NOT A SCREENSHOT OF THE HERO. The hero is a 100svh composition with
four loaded corners; at 1200x630 with a name and a URL competing for the same
edges it crops badly. This is the same material recomposed for the frame — the
staircase steps shallower (7%/14% rather than 8.6%/17.2%) so the third line
clears the right edge.

WHY IT IS COMMITTED. A static PNG costs nothing at request time and cannot fail
in front of a crawler. This is a deliberate step, run when the hero copy or the
palette changes — not a render hook.

    python3 tools/og-card/build.py

Requires the Playwright CLI (npx playwright) for the one screenshot.
"""

import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
STYLES = ROOT / "styles.scss"
FONTS = ROOT / "design" / "fonts"
OUT = ROOT / "assets" / "og-card.png"

# Facebook and X both want 1200x630 for the large-summary card.
WIDTH, HEIGHT = 1200, 630

# The tokens the card is allowed to use. Deliberately few: a share card that
# needed the whole ramp would be a second design rather than a crop of this one.
NEEDED = ("--gray-100", "--gray-400", "--gray-1000", "--gray-1100", "--gray-1200")


def read_tokens() -> dict[str, str]:
    """Pull the named custom properties out of the stylesheet's :root block."""
    css = STYLES.read_text(encoding="utf-8")
    tokens = {}
    for name in NEEDED:
        # `--gray-100: #fdfdfc; // page bg` — value up to the semicolon.
        match = re.search(rf"^\s*{re.escape(name)}\s*:\s*([^;]+);", css, re.M)
        if not match:
            sys.exit(f"og-card: {name} is gone from styles.scss — card not rendered.")
        tokens[name] = match.group(1).strip()
    return tokens


def font_face(weight: int, filename: str) -> str:
    """A local @font-face, so the render needs no network and cannot drift to a
    fallback face without saying so."""
    path = FONTS / filename
    if not path.exists():
        sys.exit(f"og-card: {path} is missing — card not rendered.")
    return (
        "@font-face{font-family:'NunitoLocal';font-style:normal;"
        f"font-weight:{weight};src:url('{path.as_uri()}') format('truetype');}}"
    )


def card_html(t: dict[str, str]) -> str:
    faces = "".join(
        font_face(w, f) for w, f in ((400, "Nunito-Regular.ttf"), (500, "Nunito-Medium.ttf"), (600, "Nunito-SemiBold.ttf"))
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
{faces}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:{WIDTH}px;height:{HEIGHT}px}}
body{{
  background:{t['--gray-100']};
  color:{t['--gray-1200']};
  font-family:'NunitoLocal',sans-serif;
  padding:62px 67px;
  display:flex;flex-direction:column;justify-content:space-between;
  -webkit-font-smoothing:antialiased;
}}
.top{{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}}
.name{{font-size:25px;font-weight:600;letter-spacing:-.012em}}
.kicker{{
  font-size:15px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;
  color:{t['--gray-1000']};margin-bottom:14px;
}}
.hl{{font-size:52px;font-weight:600;line-height:1.12;letter-spacing:-.026em}}
.hl b{{display:block;font-weight:600}}
.foot{{
  display:flex;justify-content:space-between;align-items:flex-end;gap:24px;
  border-top:1px solid {t['--gray-400']};padding-top:24px;
}}
.ledger{{display:flex;gap:38px}}
.ledger span{{font-size:19px;font-weight:500}}
.ledger em{{
  font-style:normal;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  font-size:15px;font-weight:400;color:{t['--gray-1000']};margin-left:.85ch;
  font-variant-numeric:tabular-nums;
}}
.url{{font-size:17px;color:{t['--gray-1000']}}}
</style></head><body>
  <div class="top">
    <span class="name">Ameya Panchal</span>
  </div>
  <div>
    <div class="kicker">Now</div>
    <div class="hl"><b>CS, physics &amp; AI at Penn State.</b><b>Independent interpretability research.</b></div>
  </div>
  <div class="foot">
    <div class="ledger">
      <span>Writing<em>03</em></span>
      <span>Notes<em>03</em></span>
      <span>Instruments<em>05</em></span>
    </div>
    <span class="url">ameya-bit.github.io</span>
  </div>
</body></html>
"""


def main() -> None:
    tokens = read_tokens()
    with tempfile.TemporaryDirectory() as tmp:
        src = pathlib.Path(tmp) / "card.html"
        src.write_text(card_html(tokens), encoding="utf-8")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [
                "npx", "--yes", "playwright", "screenshot",
                f"--viewport-size={WIDTH},{HEIGHT}",
                "--wait-for-timeout=1200",  # let the local faces load before the shot
                src.as_uri(), str(OUT),
            ],
            capture_output=True, text=True,
        )
    if result.returncode != 0:
        sys.exit(f"og-card: playwright failed\n{result.stderr.strip()}")
    print(f"og-card: wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
