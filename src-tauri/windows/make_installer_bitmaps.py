#!/usr/bin/env python3
"""Baking header.bmp (150x57) and sidebar.bmp (164x314) for the NSIS installer.

The source art is in `art/header.png` / `art/sidebar.png` (the 190×4 Kurogane aesthetic:
the mark on a plate, the Orbitron wordmark, neon). NSIS requires a 24-bit BMP without alpha —
here the PNGs are flattened onto a matte black background and saved as BMP3.

Run by hand when the art changes: put new PNGs of the exact sizes into `art/`
and run `python3 make_installer_bitmaps.py`. The logo isn't generated programmatically — the art is drawn
in a design tool. The old procedural generator was replaced by this baking.
"""
import argparse
import io
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(ROOT, "art")
INK_0 = (8, 8, 10)  # #08080A — matte black, the shared background of both bitmaps

TARGETS = [
    ("header", (150, 57)),
    ("sidebar", (164, 314)),
]


def render_bmp(name, size):
    src = os.path.join(ART, f"{name}.png")
    if not os.path.exists(src):
        sys.exit(f"source asset is missing: {src}")
    im = Image.open(src).convert("RGBA")
    if im.size != size:
        sys.exit(f"{name}.png has size {im.size}, expected {size}")
    bg = Image.new("RGB", size, INK_0)
    bg.paste(im, (0, 0), im)  # correctly composite the PNG alpha onto the installer background
    buf = io.BytesIO()
    bg.save(buf, format="BMP")  # 24-bit BMP3, bottom-up — what NSIS expects
    return buf.getvalue()


def bake(name, size, check=False):
    expected = render_bmp(name, size)
    out = os.path.join(ROOT, f"{name}.bmp")
    if check:
        actual = open(out, "rb").read() if os.path.exists(out) else b""
        if actual != expected:
            sys.exit(f"{name}.bmp is stale; run make_installer_bitmaps.py")
        print(f"OK {name}.bmp {size} 24-bit synchronized")
        return
    with open(out, "wb") as f:
        f.write(expected)
    print(f"{name}.bmp {size} 24-bit")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="проверить, что BMP синхронизированы с PNG-исходниками",
    )
    args = parser.parse_args()
    for name, size in TARGETS:
        bake(name, size, check=args.check)
