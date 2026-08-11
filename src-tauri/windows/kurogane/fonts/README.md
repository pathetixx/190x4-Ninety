# Installer fonts

The Kurogane BMP generator renders every baked label from these files instead of
system fonts. Rendering must not depend on what happens to be installed on the
machine that runs `make_kurogane_assets.py`.

| File | Family | Licence |
| --- | --- | --- |
| `Orbitron-Regular.ttf`, `Orbitron-Bold.ttf` | Orbitron (Matt McInerney) | SIL Open Font License 1.1 |
| `DejaVuSans-Bold.ttf` | DejaVu Sans (DejaVu fonts project) | Bitstream Vera Fonts Licence / Arev Fonts Licence |

Both families are redistributed unmodified. They are build-time assets only:
they are baked into bitmaps and never shipped with the application.

Orbitron carries no Cyrillic glyphs, so any label containing them is rendered
with DejaVu Sans Bold. The generator refuses to render a string whose face is
missing a glyph — a silent fallback once shipped an installer whose Russian
buttons were rows of empty boxes.
