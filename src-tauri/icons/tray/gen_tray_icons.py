#!/usr/bin/env python3
# Генератор трей-значков Ninety: они-маска (пламя-корона/злые глаза/оскал)
# в 3 состояниях. off=серый тусклый, proxy=красный, tun=purple(synthwave)+глоу.
# Запуск: python3 gen_tray_icons.py  → пишет oni_{state}_{16,32,48}.png рядом.
import os
from PIL import Image, ImageDraw, ImageFilter

S = 256  # мастер-канвас, потом даунскейл с антиалиасингом
OUT = os.path.dirname(os.path.abspath(__file__))

def oni_mask():
    m = Image.new("L", (S, S), 0); d = ImageDraw.Draw(m); cx = S // 2
    d.polygon([(cx-80,116),(cx-88,150),(cx-72,198),(cx-40,234),(cx,250),(cx+40,234),(cx+72,198),(cx+88,150),(cx+80,116)], fill=255)
    d.polygon([(cx-80,118),(cx-66,48),(cx-46,106),(cx-30,26),(cx-8,98),(cx,36),(cx+10,98),(cx+30,30),(cx+46,106),(cx+66,52),(cx+80,118)], fill=255)
    d.polygon([(cx-88,150),(cx-108,178),(cx-72,192)], fill=255)
    d.polygon([(cx+88,150),(cx+108,178),(cx+72,192)], fill=255)
    d.polygon([(cx-62,146),(cx-20,158),(cx-26,180),(cx-62,170)], fill=0)
    d.polygon([(cx+62,146),(cx+20,158),(cx+26,180),(cx+62,170)], fill=0)
    d.rectangle([cx-6,150,cx+6,176], fill=0)
    d.polygon([(cx-46,202),(cx-30,218),(cx-14,204),(cx,220),(cx+14,204),(cx+30,218),(cx+46,202),(cx+32,230),(cx,236),(cx-32,230)], fill=0)
    return m

def colorize(mask, rgb, glow=0.0, dim=False):
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if glow > 0:
        hm = mask.filter(ImageFilter.MaxFilter(11)).filter(ImageFilter.GaussianBlur(12))
        gl = Image.new("RGBA", (S, S), rgb + (0,)); gl.putalpha(hm.point(lambda p: int(p*glow)))
        out = Image.alpha_composite(out, gl)
    body = Image.new("RGBA", (S, S), rgb + (255,))
    body.putalpha(mask.point(lambda p: int(p*(0.6 if dim else 1.0))))
    return Image.alpha_composite(out, body)

mask = oni_mask()
STATES = {
    "off":   colorize(mask, (150, 150, 160), dim=True),
    "proxy": colorize(mask, (192, 48, 74)),                 # --accent  #C0304A
    "tun":   colorize(mask, (199, 125, 255), glow=0.8),     # synthwave #C77DFF
}
for name, img in STATES.items():
    for sz in (16, 32, 48):
        img.resize((sz, sz), Image.LANCZOS).save(os.path.join(OUT, f"oni_{name}_{sz}.png"))
print("wrote", len(STATES)*3, "icons to", OUT)
