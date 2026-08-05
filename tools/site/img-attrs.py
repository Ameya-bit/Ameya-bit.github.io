#!/usr/bin/env python3
"""Post-render: give every rendered figure its intrinsic size and a load policy.

THE PROBLEM. Quarto emits `<img src="..." class="img-fluid figure-img">` and
nothing else. With no width/height the browser cannot reserve the figure's box
before the bytes arrive, so every figure shoves the paragraphs below it down as
it lands — cumulative layout shift, on a site whose entire claim is composure.
And with no loading policy all five figures of a post compete with the text for
the first paint.

WHY POST-RENDER RATHER THAN IN THE MARKDOWN. The alternative is writing
`{width=1980 height=838}` beside all sixteen figures by hand, which is sixteen
more numbers that can drift from the file they describe — the same failure the
lens figure's generated data exists to prevent. Here the dimensions are read out
of the image itself at build time, so they cannot be wrong.

THE LOAD POLICY. The first figure of a page stays eager: the title card can
place it near the fold on a short viewport, and lazy-loading something that
turns out to be the LCP element is a self-inflicted wound. Everything after it
is lazy. All figures decode off the main thread.

Stdlib only (the house rule) — PNG and WebP headers are a dozen lines each.
Idempotent: an <img> that already carries width= is left alone.
"""

import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("QUARTO_PROJECT_OUTPUT_DIR", ROOT / "_site"))
if not OUT.is_absolute():
    OUT = ROOT / OUT

IMG = re.compile(r"<img\b[^>]*>", re.IGNORECASE | re.DOTALL)
SRC = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
HAS_WIDTH = re.compile(r"\bwidth\s*=", re.IGNORECASE)


def png_size(b: bytes) -> tuple[int, int] | None:
    if len(b) < 24 or b[:8] != b"\x89PNG\r\n\x1a\n" or b[12:16] != b"IHDR":
        return None
    return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")


def webp_size(b: bytes) -> tuple[int, int] | None:
    if len(b) < 30 or b[:4] != b"RIFF" or b[8:12] != b"WEBP":
        return None
    chunk = b[12:16]
    if chunk == b"VP8X":  # extended
        return (
            int.from_bytes(b[24:27], "little") + 1,
            int.from_bytes(b[27:30], "little") + 1,
        )
    if chunk == b"VP8L":  # lossless — 14 bits each, packed after the 0x2F signature
        bits = int.from_bytes(b[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 ":  # lossy
        return (
            int.from_bytes(b[26:28], "little") & 0x3FFF,
            int.from_bytes(b[28:30], "little") & 0x3FFF,
        )
    return None


def intrinsic(path: Path) -> tuple[int, int] | None:
    try:
        head = path.read_bytes()[:64]
    except OSError:
        return None
    return png_size(head) or webp_size(head)


def process(html: Path) -> int:
    text = html.read_text(encoding="utf-8")
    seen = 0
    missing = []

    def fix(m: re.Match) -> str:
        nonlocal seen
        tag = m.group(0)
        if HAS_WIDTH.search(tag):
            return tag
        src_m = SRC.search(tag)
        if not src_m:
            return tag
        src = src_m.group(1)
        parsed = urlparse(src)
        if parsed.scheme or src.startswith("//") or src.startswith("data:"):
            return tag  # remote or inline — no local file to measure
        target = (html.parent / unquote(parsed.path)).resolve()
        dims = intrinsic(target)
        if dims is None:
            missing.append(src)
            return tag
        w, h = dims
        seen += 1
        # First figure on the page stays eager; the rest defer.
        policy = 'decoding="async"' if seen == 1 else 'loading="lazy" decoding="async"'
        return f'{tag[:-1].rstrip()} width="{w}" height="{h}" {policy}>'

    new = IMG.sub(fix, text)
    if missing:
        print(f"  ! {html.relative_to(OUT)}: could not size {', '.join(missing)}", file=sys.stderr)
    if new != text:
        html.write_text(new, encoding="utf-8")
    return seen


def main() -> None:
    if not OUT.exists():
        sys.exit(f"output dir not found: {OUT}")
    total = pages = 0
    for html in sorted(OUT.rglob("*.html")):
        n = process(html)
        if n:
            pages += 1
            total += n
    print(f"img-attrs: sized {total} figures across {pages} pages")


if __name__ == "__main__":
    main()
