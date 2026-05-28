#!/usr/bin/env python3
# Конвертит license.txt -> license.rtf.
#
# WiX MSI требует RTF, NSIS принимает оба. licenseFile в tauri.conf.json
# общий для обоих target'ов — значит нужен RTF. Кириллица в RTF —
# через \\u<decimal>? escape (Unicode).
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "license.txt")
OUT = os.path.join(ROOT, "license.rtf")


def to_rtf_token(ch):
    # Escape одного символа в RTF-токен.
    if ch == "\\":
        return r"\\"
    if ch == "{":
        return r"\{"
    if ch == "}":
        return r"\}"
    cp = ord(ch)
    if cp < 128:
        return ch
    # Unicode escape — RTF Unicode-mode (см. docstring).
    return "\\u" + str(cp) + "?"


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        text = f.read()

    body_lines = []
    for line in text.splitlines():
        escaped = "".join(to_rtf_token(c) for c in line)
        body_lines.append(escaped + r"\par")
    body = "\n".join(body_lines)

    rtf = (
        r"{\rtf1\ansi\ansicpg1252\deff0"
        r"{\fonttbl{\f0\fswiss\fcharset0 Segoe UI;}{\f1\fmodern\fcharset0 Consolas;}}"
        r"\fs20\sl240\slmult1 "
        + body
        + "\n}"
    )

    with open(OUT, "w", encoding="ascii", newline="\r\n") as f:
        f.write(rtf)
    print(f"✓ {OUT} ({os.path.getsize(OUT)} байт)")


if __name__ == "__main__":
    main()
