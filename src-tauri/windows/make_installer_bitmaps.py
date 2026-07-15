#!/usr/bin/env python3
"""Запекание header.bmp (150x57) и sidebar.bmp (164x314) для NSIS-инсталлера.

Исходный арт в `art/header.png` / `art/sidebar.png` (эстетика 190×4 Kurogane:
марка на plate, вордмарк Orbitron, неон). NSIS требует 24-bit BMP без альфы —
здесь PNG плющатся на матовый чёрный фон и сохраняются BMP3.

Запускать руками когда меняется арт: положить новые PNG точных размеров в `art/`
и `python3 make_installer_bitmaps.py`. Лого не генерируем программно — арт рисуется
дизайн-инструментом. Старый процедурный генератор заменён этим запеканием.
"""
import argparse
import io
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(ROOT, "art")
INK_0 = (8, 8, 10)  # #08080A — матовый чёрный, общий фон обоих битмапов

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
    bg.paste(im, (0, 0), im)  # корректно сводим PNG-альфу на фон установщика
    buf = io.BytesIO()
    bg.save(buf, format="BMP")  # 24-bit BMP3, bottom-up — то что ждёт NSIS
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
