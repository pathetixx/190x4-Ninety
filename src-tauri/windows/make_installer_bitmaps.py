#!/usr/bin/env python3
"""Запекание header.bmp (150x57) и sidebar.bmp (164x314) для NSIS-инсталлера.

Исходники — хэндофф-арт Claude Design в `art/header.png` / `art/sidebar.png`
(эстетика 190×4 Kurogane: марка на plate, вордмарк Orbitron, неон). NSIS требует
24-bit BMP без альфы — здесь PNG плющатся на матовый чёрный фон и сохраняются BMP3.

Запускать руками когда меняется арт: положить новые PNG точных размеров в `art/`
и `python3 make_installer_bitmaps.py`. НЕ генерируем лого программно — арт рисуется
в Claude Design (см. handoff). Старый процедурный генератор заменён этим запеканием.
"""
from PIL import Image
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(ROOT, "art")
INK_0 = (8, 8, 10)  # #08080A — матовый чёрный, общий фон обоих битмапов

TARGETS = [
    ("header", (150, 57)),
    ("sidebar", (164, 314)),
]


def bake(name, size):
    src = os.path.join(ART, f"{name}.png")
    if not os.path.exists(src):
        sys.exit(f"нет исходника {src}")
    im = Image.open(src).convert("RGBA")
    if im.size != size:
        sys.exit(f"{name}.png размер {im.size}, ожидался {size}")
    bg = Image.new("RGB", size, INK_0)
    bg.paste(im, (0, 0), im)  # альфа хэндоффа = 255 → потерь нет
    out = os.path.join(ROOT, f"{name}.bmp")
    bg.save(out, format="BMP")  # 24-bit BMP3, bottom-up — то что ждёт NSIS
    print(f"{name}.bmp {bg.size} 24-bit")


if __name__ == "__main__":
    for name, size in TARGETS:
        bake(name, size)
