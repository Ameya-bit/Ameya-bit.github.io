#!/usr/bin/env python3
"""Generate the WebP delivery copy of every post figure.

WHY BOTH FORMATS EXIST. The PNG stays because it is the archival original and
because it is what the Open Graph card points at — social scrapers are the one
audience that still has spotty WebP support, and a broken share card was the
exact problem `open-graph: true` was added to solve. The WebP is what readers
actually download: lossless, so the pixels are identical, and roughly a third
smaller for these plots because matplotlib writes an alpha channel that an
opaque figure never uses.

Lossless is deliberate and not a default to be relaxed casually. These are
measurements, and a lossy codec deciding which pixels of an error bar matter is
not a trade this site gets to make quietly.

Run after regenerating any figure:  python3 tools/site/figures.py
Idempotent: skips a WebP that is already newer than its PNG.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POSTS = ROOT / "posts"


def convert(png: Path) -> tuple[int, int] | None:
    webp = png.with_suffix(".webp")
    if webp.exists() and webp.stat().st_mtime >= png.stat().st_mtime:
        return None
    proc = subprocess.run(
        ["cwebp", "-quiet", "-lossless", "-z", "9", str(png), "-o", str(webp)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"cwebp failed on {png}: {proc.stderr.strip()}")
    return png.stat().st_size, webp.stat().st_size


def main() -> None:
    if not subprocess.run(["which", "cwebp"], capture_output=True).returncode == 0:
        sys.exit("cwebp not found (brew install webp)")

    before = after = 0
    for png in sorted(POSTS.glob("*/figures/*.png")):
        result = convert(png)
        if result is None:
            continue
        src, dst = result
        before += src
        after += dst
        print(f"  {png.relative_to(ROOT)}  {src // 1024} KB -> {dst // 1024} KB")

    if before:
        print(f"\n{before / 1048576:.2f} MB -> {after / 1048576:.2f} MB "
              f"({100 - after * 100 // before}% smaller)")
    else:
        print("every figure already has a current WebP")


if __name__ == "__main__":
    main()
