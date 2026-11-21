#!/usr/bin/env python3
# Converts license.txt -> license.rtf.
#
# WiX MSI requires RTF, NSIS accepts both. licenseFile in tauri.conf.json
# is shared by both targets — so RTF is needed. Cyrillic in RTF goes
# through the \\u<decimal>? escape (Unicode).
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "license.txt")
OUT = os.path.join(ROOT, "license.rtf")


def to_rtf_token(ch):
    # Escape one character into an RTF token.
    if ch == "\\":
        return r"\\"
    if ch == "{":
        return r"\{"
    if ch == "}":
        return r"\}"
    cp = ord(ch)
    if cp < 128:
        return ch
    # Unicode escape — RTF Unicode mode (see the docstring).
    return "\\u" + str(cp) + "?"


def render_rtf():
    with open(SRC, "r", encoding="utf-8") as f:
        text = f.read()

    body_lines = []
    for line in text.splitlines():
        escaped = "".join(to_rtf_token(c) for c in line)
        body_lines.append(escaped + r"\par")
    body = "\n".join(body_lines)

    return (
        r"{\rtf1\ansi\ansicpg1252\deff0"
        r"{\fonttbl{\f0\fswiss\fcharset0 Segoe UI;}{\f1\fmodern\fcharset0 Consolas;}}"
        r"\fs20\sl240\slmult1 "
        + body
        + "\n}"
    )


def encoded_rtf():
    # RTF understands LF, and a single byte format doesn't create CR whitespace in git and
    # makes --check deterministic on Linux and Windows.
    return render_rtf().encode("ascii")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="проверить, что license.rtf синхронизирован с license.txt",
    )
    args = parser.parse_args()
    expected = encoded_rtf()

    if args.check:
        actual = open(OUT, "rb").read() if os.path.exists(OUT) else b""
        if actual != expected:
            sys.exit("license.rtf is stale; run make_license_rtf.py")
        print(f"OK {OUT} synchronized ({len(actual)} bytes)")
        return

    with open(OUT, "wb") as f:
        f.write(expected)
    print(f"OK {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
