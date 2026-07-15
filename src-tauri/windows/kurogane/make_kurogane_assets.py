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
RED_DARK = (124, 18, 38)


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


def make_left_panel():
    size = (330, 463)
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
    draw.line((329, 0, 329, 463), fill=(49, 49, 54, 255), width=1)
    draw.line((327, 0, 327, 463), fill=(20, 20, 24, 210), width=1)

    metallic_text(panel, (188, 337), "190x", font(20, bold=True), spacing=0)
    draw.text((268, 337), "4", font=font(20, bold=True), fill=RED)
    draw_spaced(draw, (177, 374), "NINETY", font(15, bold=True), (230, 230, 234), spacing=7)
    draw.text((201, 411), "/  SETUP", font=font(9), fill=(223, 55, 79))
    return panel


def make_title_brand():
    size = (225, 55)
    out = Image.new("RGBA", size, (*INK, 255))
    mark = Image.open(SAMURAI_MARK).convert("RGBA")
    mark.thumbnail((47, 47), Image.Resampling.LANCZOS)
    out.alpha_composite(mark, (0, 4))
    metallic_text(out, (56, 4), "NINETY", font(23, bold=True), spacing=1)
    draw = ImageDraw.Draw(out)
    draw_spaced(draw, (57, 33), "190x4  ·  VPN", font(8), (145, 145, 153), spacing=1)
    return out


def make_progress_frame():
    size = (396, 45)
    out = Image.new("RGBA", size, (*PANEL, 255))
    draw = ImageDraw.Draw(out)
    outer = [(2, 9), (10, 2), (382, 2), (394, 11), (394, 34), (384, 43), (10, 43), (2, 35)]
    middle = [(6, 11), (12, 6), (380, 6), (390, 13), (390, 32), (382, 39), (12, 39), (6, 33)]
    inner = [(11, 15), (16, 10), (376, 10), (385, 16), (385, 29), (378, 35), (16, 35), (11, 30)]
    draw.polygon(outer, fill=(20, 20, 24), outline=(98, 98, 105))
    draw.line(outer + [outer[0]], fill=(108, 108, 115), width=1)
    draw.polygon(middle, fill=(7, 7, 9), outline=(47, 47, 52))
    draw.polygon(inner, fill=(12, 12, 15), outline=(64, 64, 71))
    draw.line((16, 12, 376, 12), fill=(121, 27, 44), width=1)
    for x in range(24, 378, 18):
        draw.line((x, 26, x + 8, 26), fill=(34, 34, 39), width=1)
        draw.line((x, 30, x + 8, 30), fill=(23, 23, 27), width=1)
    return out


def make_progress_fill():
    size = (368, 13)
    out = Image.new("RGB", size, RED_DARK)
    draw = ImageDraw.Draw(out)
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        if t < 0.42:
            color = (255, int(78 - 45 * t / 0.42), int(103 - 43 * t / 0.42))
        else:
            color = (int(242 - 84 * (t - 0.42) / 0.58), 26, 52)
        draw.line((0, y, size[0], y), fill=color)
    draw.line((0, 0, size[0], 0), fill=(255, 116, 132))
    draw.line((0, size[1] - 1, size[0], size[1] - 1), fill=(91, 7, 26))
    for x in range(18, size[0], 18):
        draw.line((x, 2, x, size[1] - 3), fill=(187, 18, 45))
        draw.line((x + 1, 2, x + 1, size[1] - 3), fill=(255, 55, 78))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    save_or_check(make_left_panel(), "left-panel.bmp", args.check)
    save_or_check(make_title_brand(), "title-brand.bmp", args.check)
    save_or_check(make_progress_frame(), "progress-frame.bmp", args.check)
    save_or_check(make_progress_fill(), "progress-fill.bmp", args.check)


if __name__ == "__main__":
    main()
