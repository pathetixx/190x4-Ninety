#!/usr/bin/env python3
"""Generate or verify deterministic BMP assets for the Kurogane Split NSIS UI."""

import argparse
import io

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]

SPLIT_ART = ROOT / "src/assets/split-atelier-v2.webp"
SAMURAI_MARK = ROOT / "src/assets/samurai-mark-v2.webp"

INK = (11, 11, 14)
PANEL = (11, 11, 14)
RED = (255, 49, 79)


def font(size: int, bold: bool = False):
    candidates = [
        Path("/usr/share/fonts/truetype/orbitron/orbitron_bold.ttf" if bold else "/usr/share/fonts/truetype/orbitron/orbitron_regular.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def bmp_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.convert("RGB").save(output, format="BMP")
    return output.getvalue()


def save_or_check(image: Image.Image, name: str, check: bool):
    path = HERE / name
    expected = bmp_bytes(image)
    if check:
        if not path.exists() or path.read_bytes() != expected:
            raise SystemExit(f"{name} is stale; run {Path(__file__).name}")
        print(f"OK {name}: {image.size} 24-bit")
        return
    path.write_bytes(expected)
    print(f"{name}: {image.size} 24-bit")


def draw_spaced(draw: ImageDraw.ImageDraw, xy, text, typeface, fill, spacing=5):
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=typeface, fill=fill)
        bbox = draw.textbbox((x, y), char, font=typeface)
        x = bbox[2] + spacing
    return x


def metallic_text(canvas, xy, text, typeface, spacing=0):
    x, y = xy
    if spacing:
        dummy = ImageDraw.Draw(canvas)
        widths = []
        for char in text:
            box = dummy.textbbox((0, 0), char, font=typeface)
            widths.append(box[2] - box[0])
        width = sum(widths) + spacing * (len(text) - 1)
        height = max(dummy.textbbox((0, 0), char, font=typeface)[3] for char in text)
        mask = Image.new("L", (width + 4, height + 8), 0)
        md = ImageDraw.Draw(mask)
        cursor = 2
        for char, char_width in zip(text, widths):
            md.text((cursor, 0), char, font=typeface, fill=255)
            cursor += char_width + spacing
    else:
        box = ImageDraw.Draw(canvas).textbbox((0, 0), text, font=typeface)
        mask = Image.new("L", (box[2] + 4, box[3] + 8), 0)
        ImageDraw.Draw(mask).text((2, 0), text, font=typeface, fill=255)

    gradient = Image.new("RGB", mask.size)
    gd = ImageDraw.Draw(gradient)
    h = max(1, mask.height - 1)
    for row in range(mask.height):
        t = row / h
        if t < 0.42:
            v = int(238 - 82 * (t / 0.42))
        else:
            v = int(156 + 58 * ((t - 0.42) / 0.58))
        gd.line((0, row, mask.width, row), fill=(v, v, min(255, v + 6)))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_mask = Image.new("L", canvas.size, 0)
    shadow_mask.paste(mask, (x + 1, y + 2))
    shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(1.2)))
    canvas.alpha_composite(shadow)
    canvas.paste(gradient, (x, y), mask)
    return x + mask.width


def make_button(size, text, *, primary=False, glyph=False):
    """Raster button chrome: Windows theming must never repaint it white."""
    out = Image.new("RGBA", size, (*PANEL, 255))
    draw = ImageDraw.Draw(out)
    if primary:
        for y in range(size[1]):
            t = y / max(1, size[1] - 1)
            color = (213 + int(17 * (1 - t)), 31 + int(12 * (1 - t)), 62 + int(14 * (1 - t)))
            draw.line((0, y, size[0] - 1, y), fill=color)
        border = (255, 78, 101)
        foreground = (249, 247, 248)
    else:
        for y in range(size[1]):
            value = 18 - int(5 * y / max(1, size[1] - 1))
            draw.line((0, y, size[0] - 1, y), fill=(value, value, value + 3))
        border = (58, 58, 65)
        foreground = (191, 191, 198)
    draw.rectangle((0, 0, size[0] - 1, size[1] - 1), outline=border)
    draw.line((1, 1, size[0] - 2, 1), fill=(88, 88, 95) if not primary else (255, 102, 122))

    if any("А" <= char <= "я" or char in "Ёё" for char in text):
        cyrillic = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
        face = ImageFont.truetype(str(cyrillic), 12) if cyrillic.exists() else font(12, bold=True)
    else:
        face = font(15 if glyph else 12, bold=not glyph)
    box = draw.textbbox((0, 0), text, font=face)
    x = (size[0] - (box[2] - box[0])) // 2
    y = (size[1] - (box[3] - box[1])) // 2 - box[1]
    draw.text((x, y), text, font=face, fill=foreground)
    return out


def make_left_panel():
    # Exact pixel sizes of the corresponding DLU controls in the Windows NSIS
    # resource at 100% scaling. SS_CENTERIMAGE never stretches a bitmap.
    size = (384, 538)
    art = Image.open(SPLIT_ART).convert("RGB")
    # Slightly oversized crop keeps the oni eye and horn exactly where the
    # concept places them while preserving circuitry at the outer edge.
    art = ImageOps.fit(art, size, method=Image.Resampling.LANCZOS, centering=(0.42, 0.46))
    panel = art.convert("RGBA")

    # Matte right edge and lower atelier falloff keep overlaid branding readable.
    veil = Image.new("RGBA", size, (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for x in range(size[0]):
        alpha = int(10 + 82 * (x / (size[0] - 1)) ** 2)
        vd.line((x, 0, x, size[1]), fill=(4, 4, 6, alpha))
    for y in range(285, size[1]):
        alpha = int(26 + 128 * ((y - 285) / (size[1] - 285)))
        vd.line((0, y, size[0], y), fill=(5, 3, 5, alpha))
    panel.alpha_composite(veil)

    draw = ImageDraw.Draw(panel)
    draw.line((size[0] - 1, 0, size[0] - 1, size[1]), fill=(49, 49, 54, 255), width=1)
    draw.line((size[0] - 3, 0, size[0] - 3, size[1]), fill=(20, 20, 24, 210), width=1)

    brand_end = metallic_text(panel, (219, 392), "190x", font(23, bold=True), spacing=0)
    draw.text((brand_end - 3, 392), "4", font=font(23, bold=True), fill=RED)
    draw_spaced(draw, (206, 435), "NINETY", font(17, bold=True), (230, 230, 234), spacing=8)
    draw.text((234, 479), "/  SETUP", font=font(10), fill=(223, 55, 79))
    return panel


def make_title_brand():
    # One-pixel overscan on every edge avoids the Static control exposing its
    # system-color background after DLU rounding on Windows.
    size = (264, 66)
    out = Image.new("RGBA", size, (*INK, 255))
    mark = Image.open(SAMURAI_MARK).convert("RGBA")
    mark.thumbnail((55, 55), Image.Resampling.LANCZOS)
    out.alpha_composite(mark, (0, 5))
    metallic_text(out, (66, 5), "NINETY", font(27, bold=True), spacing=1)
    draw = ImageDraw.Draw(out)
    draw_spaced(draw, (67, 39), "190x4  ·  VPN", font(9), (145, 145, 153), spacing=1)
    return out


def make_progress_frame():
    size = (460, 53)
    out = Image.new("RGBA", size, (*PANEL, 255))
    draw = ImageDraw.Draw(out)
    outer = [(2, 11), (12, 2), (444, 2), (458, 13), (458, 40), (446, 51), (12, 51), (2, 41)]
    middle = [(7, 13), (14, 7), (442, 7), (453, 15), (453, 38), (444, 46), (14, 46), (7, 39)]
    inner = [(13, 18), (19, 12), (438, 12), (447, 19), (447, 34), (440, 41), (19, 41), (13, 35)]
    draw.polygon(outer, fill=(20, 20, 24), outline=(98, 98, 105))
    draw.line(outer + [outer[0]], fill=(108, 108, 115), width=1)
    draw.polygon(middle, fill=(7, 7, 9), outline=(47, 47, 52))
    draw.polygon(inner, fill=(12, 12, 15), outline=(64, 64, 71))
    draw.line((19, 14, 438, 14), fill=(121, 27, 44), width=1)
    for x in range(28, 440, 21):
        draw.line((x, 31, x + 9, 31), fill=(34, 34, 39), width=1)
        draw.line((x, 35, x + 9, 35), fill=(23, 23, 27), width=1)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    save_or_check(make_left_panel(), "left-panel.bmp", args.check)
    save_or_check(make_title_brand(), "title-brand.bmp", args.check)
    save_or_check(make_progress_frame(), "progress-frame.bmp", args.check)
    save_or_check(make_button((44, 35), "−", glyph=True), "chrome-minimize.bmp", args.check)
    save_or_check(make_button((44, 35), "×", glyph=True), "chrome-close.bmp", args.check)
    save_or_check(make_button((104, 35), "Back"), "nav-back-en.bmp", args.check)
    save_or_check(make_button((104, 35), "Назад"), "nav-back-ru.bmp", args.check)
    save_or_check(make_button((118, 35), "Next", primary=True), "nav-next-en.bmp", args.check)
    save_or_check(make_button((118, 35), "Далее", primary=True), "nav-next-ru.bmp", args.check)
    save_or_check(make_button((118, 35), "Install", primary=True), "nav-install-en.bmp", args.check)
    save_or_check(make_button((118, 35), "Установить", primary=True), "nav-install-ru.bmp", args.check)
    save_or_check(make_button((118, 35), "Finish", primary=True), "nav-finish-en.bmp", args.check)
    save_or_check(make_button((118, 35), "Готово", primary=True), "nav-finish-ru.bmp", args.check)
    save_or_check(make_button((110, 35), "Cancel"), "nav-cancel-en.bmp", args.check)
    save_or_check(make_button((110, 35), "Отмена"), "nav-cancel-ru.bmp", args.check)


if __name__ == "__main__":
    main()
