#!/usr/bin/env python3
"""Генератор header.bmp (150x57) и sidebar.bmp (164x314) для NSIS-инсталлера Ninety.

NSIS требует BMP формата (24-bit, без альфы). icon.png — лого 190x4.
Запускать руками когда меняется лого: `python3 make_installer_bitmaps.py`.
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(ROOT, "..", "icons", "icon.png")
OUT_HEADER = os.path.join(ROOT, "header.bmp")
OUT_SIDEBAR = os.path.join(ROOT, "sidebar.bmp")

INK_0 = (8, 8, 10)
INK_1 = (14, 14, 17)
INK_2 = (21, 21, 26)
ACCENT = (192, 48, 74)
ACCENT_BRIGHT = (222, 87, 114)
TEXT_HI = (245, 245, 242)
TEXT_LO = (107, 107, 114)


def draw_edge_top(img, draw, alpha=24):
    """Добавляем тонкую светлую линию сверху — премиум-приём."""
    w, h = img.size
    for x in range(w):
        # горизонтальный glow к центру
        dist = abs(x - w / 2) / (w / 2)
        a = int(alpha * (1 - dist) ** 1.4)
        if a > 0:
            draw.point((x, 0), fill=(255, 255, 255, a))


def make_header():
    """150×57 — показывается сверху каждой страницы NSIS (кроме welcome/finish)."""
    W, H = 150, 57
    img = Image.new("RGB", (W, H), INK_0)
    draw = ImageDraw.Draw(img)

    # Лого слева — 40x40 c небольшим отступом
    icon = Image.open(ICON).convert("RGBA").resize((40, 40), Image.LANCZOS)
    bg = Image.new("RGB", (40, 40), INK_1)
    bg.paste(icon, (0, 0), icon)
    img.paste(bg, (10, (H - 40) // 2))

    # Accent vertical bar справа от лого
    draw.rectangle([56, 12, 58, H - 12], fill=ACCENT)

    # Текст: "NINETY · 190X4 VPN" — рендерим встроенным шрифтом
    try:
        from PIL import ImageFont
        # пробуем системные fonts
        font_paths = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        ]
        font_big = None
        font_small = None
        for p in font_paths:
            if os.path.exists(p):
                font_big = ImageFont.truetype(p, 13)
                font_small = ImageFont.truetype(p.replace("-Bold", ""), 8) if "Bold" in p else ImageFont.truetype(p, 8)
                break
    except Exception:
        font_big = font_small = None

    if font_big:
        draw.text((68, 12), "NINETY", fill=TEXT_HI, font=font_big)
        draw.text((68, 30), "190X4  ·  VPN", fill=TEXT_LO, font=font_small)
    else:
        draw.text((68, 18), "NINETY", fill=TEXT_HI)
        draw.text((68, 30), "190X4 VPN", fill=TEXT_LO)

    # Нижняя hairline линия — accent с затуханием
    for x in range(W):
        dist = abs(x - W / 2) / (W / 2)
        a = int(255 * (1 - dist) ** 1.6 * 0.7)
        col = tuple(int(c * a / 255 + INK_0[i] * (255 - a) / 255) for i, c in enumerate(ACCENT))
        draw.point((x, H - 1), fill=col)

    # Сохраняем как BMP3 (24-bit)
    img.save(OUT_HEADER, format="BMP")
    print(f"✓ {OUT_HEADER} {W}x{H}")


def make_sidebar():
    """164×314 — отображается слева на welcome/finish/uninstall страницах."""
    W, H = 164, 314
    img = Image.new("RGB", (W, H), INK_0)
    draw = ImageDraw.Draw(img)

    # Vertical gradient ink_0 → ink_2 → ink_1
    for y in range(H):
        t = y / H
        if t < 0.5:
            k = t / 0.5
            col = tuple(int(INK_0[i] * (1 - k) + INK_2[i] * k) for i in range(3))
        else:
            k = (t - 0.5) / 0.5
            col = tuple(int(INK_2[i] * (1 - k) + INK_1[i] * k) for i in range(3))
        draw.line([(0, y), (W, y)], fill=col)

    # Лого по центру — 96x96 на ink-подложке
    icon = Image.open(ICON).convert("RGBA").resize((96, 96), Image.LANCZOS)
    plate_size = 110
    plate = Image.new("RGB", (plate_size, plate_size), INK_1)
    plate_draw = ImageDraw.Draw(plate)
    # accent border 1px
    plate_draw.rectangle([0, 0, plate_size - 1, plate_size - 1], outline=ACCENT, width=1)
    plate.paste(icon, ((plate_size - 96) // 2, (plate_size - 96) // 2), icon)
    img.paste(plate, ((W - plate_size) // 2, 36))

    # Kicker
    try:
        from PIL import ImageFont
        font_paths = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
        font_kicker = None
        font_title = None
        font_sub = None
        for p in font_paths:
            if os.path.exists(p):
                font_kicker = ImageFont.truetype(p.replace("-Bold", ""), 8)
                font_title = ImageFont.truetype(p, 18)
                font_sub = ImageFont.truetype(p.replace("-Bold", ""), 10)
                break
    except Exception:
        font_kicker = font_title = font_sub = None

    # NINETY · 190X4 VPN
    if font_kicker:
        text = "190X4  ·  CYBERPUNK VPN"
        tw = draw.textlength(text, font=font_kicker) if hasattr(draw, "textlength") else len(text) * 5
        draw.text(((W - tw) // 2, 158), text, fill=TEXT_LO, font=font_kicker)
    if font_title:
        text = "NINETY"
        tw = draw.textlength(text, font=font_title) if hasattr(draw, "textlength") else 60
        draw.text(((W - tw) // 2, 174), text, fill=TEXT_HI, font=font_title)
    if font_sub:
        text = "vless / reality / xhttp"
        tw = draw.textlength(text, font=font_sub) if hasattr(draw, "textlength") else 80
        draw.text(((W - tw) // 2, 200), text, fill=TEXT_LO, font=font_sub)

    # Accent horizontal hairline
    for x in range(W):
        dist = abs(x - W / 2) / (W / 2)
        a = int(255 * (1 - dist) ** 1.6 * 0.55)
        col = tuple(int(c * a / 255 + INK_0[i] * (255 - a) / 255) for i, c in enumerate(ACCENT))
        draw.point((x, 230), fill=col)

    # MIT · 2026 footer
    if font_kicker:
        text = "MIT  ·  2026"
        tw = draw.textlength(text, font=font_kicker) if hasattr(draw, "textlength") else 40
        draw.text(((W - tw) // 2, H - 22), text, fill=(70, 70, 76), font=font_kicker)

    img.save(OUT_SIDEBAR, format="BMP")
    print(f"✓ {OUT_SIDEBAR} {W}x{H}")


if __name__ == "__main__":
    make_header()
    make_sidebar()
