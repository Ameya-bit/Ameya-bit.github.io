#!/usr/bin/env python3
"""Post-render: put listings.json where Quarto's own script looks for it.

THE BUG, which is upstream and not ours. Quarto writes the site's listing
manifest to /listings.json, and quarto.js then fetches it at a path relative to
the CURRENT PAGE — so every post requests /posts/<slug>/listings.json and gets a
404. Harmless (the fetch is caught) but it puts a red error in the console of
every article on a site whose readers open devtools for fun.

THE FIX. Copy the real manifest, unchanged, into each directory that contains a
listed page. The paths inside it are already site-absolute, so a copy is as
correct as the original — this is not a stub to silence a warning, it is the
same file at the second address the script asks for.

Runs after landmarks/img-attrs; stdlib only.
"""

import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("QUARTO_PROJECT_OUTPUT_DIR", ROOT / "_site"))
if not OUT.is_absolute():
    OUT = ROOT / OUT


def main() -> None:
    manifest = OUT / "listings.json"
    if not manifest.exists():
        print("listings-shim: no listings.json at the site root — nothing to do")
        return

    try:
        listings = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"listings.json is not valid JSON: {e}")

    # Every page named by any listing is a page whose own directory will be
    # asked for the manifest.
    targets = {
        (OUT / item.lstrip("/")).parent
        for entry in listings
        for item in entry.get("items", [])
    }

    copied = 0
    for d in sorted(targets):
        if not d.is_dir() or d == OUT:
            continue
        shutil.copyfile(manifest, d / "listings.json")
        copied += 1
    print(f"listings-shim: manifest placed in {copied} listed directories")


if __name__ == "__main__":
    main()
