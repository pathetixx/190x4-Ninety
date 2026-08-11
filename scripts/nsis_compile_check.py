#!/usr/bin/env python3
"""Compile the shipped Windows installer script without building the app.

`tauri build` renders `src-tauri/windows/installer.nsi` and hands it to makensis
on a Windows runner, so a broken shell — a syntax error, a page callback that
NSIS strips as unreachable, a macro that stops expanding — is only discovered
when a release is already being cut. This renders the same template with a
representative bundle context and compiles it with makensis, which also runs on
Linux, so every push can prove the installer still builds.

Two failure classes are gated:

* any makensis error;
* any `6010 … zeroing code out` warning that is not in EXPECTED_DEAD_CODE.
  NSIS fills a stripped function with zero bytes, and zero is the opcode for
  "invalid opcode": if anything still reaches that address at runtime the user
  gets an endless stream of "Distribution corrupted" boxes instead of a setup.

Usage: python3 scripts/nsis_compile_check.py [--keep]
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WINDOWS = ROOT / "src-tauri/windows"
KUROGANE = WINDOWS / "kurogane"

# The template is a pinned copy of the stock one from this exact CLI release,
# so its include files have to be fetched from the same tag.
TAURI_CLI_TAG = "tauri-cli-v2.11.4"
TAURI_NSIS_RAW = (
    "https://raw.githubusercontent.com/tauri-apps/tauri/"
    f"{TAURI_CLI_TAG}/crates/tauri-bundler/src/bundle/windows/nsis"
)
# The bundler downloads this plugin for SemverCompare/ReadJson and friends.
NSIS_TAURI_UTILS = (
    "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/"
    "nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
)

LANGUAGES = ["English", "Russian"]

# Install and uninstall keep their own copy of the chrome helpers, and each side
# only ever calls its own variants. Nothing may be added here without proving
# the function is unreachable at runtime.
EXPECTED_DEAD_CODE = {
    "un.KuroganeApplyChromeInstall",
    "KuroganeApplyChromeRemove",
    "Skip",
}

CONTEXT = {
    "compression": "lzma",
    "signed_plugins_path": "",
    "manufacturer": "190x4",
    "product_name": "Ninety",
    "version": "0.0.0",
    "version_with_build": "0.0.0.0",
    "homepage": "https://190x4.pw",
    "install_mode": "both",
    "license": "LICENSE.rtf",
    "installer_icon": "icon.ico",
    "sidebar_image": "",
    "header_image": "",
    "uninstaller_icon": "icon.ico",
    "uninstaller_header_image": "",
    "main_binary_name": "Ninety.exe",
    "main_binary_path": "Ninety.exe",
    "bundle_id": "pw.x190x4.ninety",
    "copyright": "190x4",
    "out_file": "Ninety-preview-setup.exe",
    "arch": "x64",
    "allow_downgrades": "false",
    "display_language_selector": "true",
    "install_webview2_mode": "downloadBootstrapper",
    "webview2_installer_args": "",
    "webview2_bootstrapper_path": "MicrosoftEdgeWebview2Setup.exe",
    "webview2_installer_path": "",
    "minimum_webview2_version": "",
    "uninstaller_sign_cmd": "",
    "estimated_size": "180000",
    "start_menu_folder": "Ninety",
    "installer_hooks": "installer-entry.nsh",
    "languages": LANGUAGES,
    "language_files": [f"languages/{name}.nsh" for name in LANGUAGES],
    # The payload loops only wrap File instructions; an empty payload still
    # compiles every branch that owns installer behaviour.
    "resources_dirs": [],
    "resources": [],
    "binaries": [],
    "resources_ancestors": [],
    "file_associations": [],
    "deep_link_protocols": [],
}

BLOCK = re.compile(r"\{\{#(each|if) ([\w.]+)(?: as \|(\w+)\|)?\s*~?\}\}")
CLOSE = re.compile(r"\{\{/(each|if)\}\}")


def render(template: str, context: dict) -> str:
    """Expand the handlebars subset the bundler actually uses in this template."""
    out: list[str] = []
    position = 0
    while position < len(template):
        opening = BLOCK.search(template, position)
        if not opening:
            out.append(template[position:])
            break
        out.append(template[position : opening.start()])
        depth = 1
        cursor = opening.end()
        while depth:
            nxt_open = BLOCK.search(template, cursor)
            nxt_close = CLOSE.search(template, cursor)
            if not nxt_close:
                raise SystemExit(f"unbalanced {{{{#{opening.group(1)}}}}} in template")
            if nxt_open and nxt_open.start() < nxt_close.start():
                depth += 1
                cursor = nxt_open.end()
                continue
            depth -= 1
            cursor = nxt_close.end()
            body_end = nxt_close.start()
        body = template[opening.end() : body_end]
        kind, name, alias = opening.group(1), opening.group(2), opening.group(3)
        value = context.get(name)
        if kind == "if":
            out.append(render(body, context) if value else "")
        else:
            for item in value or []:
                scope = dict(context)
                scope["this"] = item
                if alias:
                    scope[alias] = item
                out.append(render(body, scope))
        position = cursor

    rendered = "".join(out)
    for key, value in context.items():
        if isinstance(value, (str, int)):
            rendered = rendered.replace(f"{{{{{key}}}}}", str(value))
    return rendered


def fetch(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=60) as response:
        target.write_bytes(response.read())


def stage(work: Path) -> Path:
    """Lay out the directory the bundler would hand to makensis.

    The standalone Kurogane scripts resolve `..\\..\\icons\\icon.ico`, so the
    staged tree mirrors the repository layout instead of flattening it.
    """
    base = work / "src-tauri"
    windows = base / "windows"
    windows.mkdir(parents=True)
    (base / "icons").mkdir()
    shutil.copy(ROOT / "src-tauri/icons/icon.ico", base / "icons/icon.ico")

    plugins = work / "plugins"
    plugins.mkdir()
    fetch(NSIS_TAURI_UTILS, plugins / "nsis_tauri_utils.dll")
    for name in ("utils.nsh", "FileAssociation.nsh"):
        fetch(f"{TAURI_NSIS_RAW}/{name}", windows / name)
    (windows / "languages").mkdir()
    for name in LANGUAGES:
        fetch(f"{TAURI_NSIS_RAW}/languages/{name}.nsh", windows / "languages" / f"{name}.nsh")

    shutil.copy(WINDOWS / "installer-entry.nsh", windows)
    shutil.copy(WINDOWS / "hooks.nsh", windows)
    shutil.copytree(KUROGANE, windows / "kurogane")
    (windows / "LICENSE.rtf").write_text("{\\rtf1 preview}", encoding="ascii")
    (windows / "Ninety.exe").write_bytes(b"preview payload")

    context = dict(
        CONTEXT,
        additional_plugins_path=str(plugins),
        installer_icon=str(base / "icons/icon.ico"),
        uninstaller_icon=str(base / "icons/icon.ico"),
        license=str(windows / "LICENSE.rtf"),
        main_binary_path=str(windows / "Ninety.exe"),
    )
    script = windows / "installer.nsi"
    template = (WINDOWS / "installer.nsi").read_text(encoding="utf-8")
    rendered = render(template, context)
    leftovers = sorted(set(re.findall(r"\{\{[^}]*\}\}", rendered)))
    if leftovers:
        raise SystemExit(f"template placeholders left unrendered: {leftovers}")
    script.write_text(rendered, encoding="utf-8")
    return script


def compile_script(script: Path, defines: list[str] | None = None) -> str:
    command = ["makensis", "-V3", "-NOCD", *(defines or []), str(script)]
    result = subprocess.run(command, capture_output=True, text=True, cwd=script.parent)
    output = result.stdout + result.stderr
    if result.returncode != 0:
        print(output)
        raise SystemExit(f"makensis failed for {script.name}")
    return output


def report_dead_code(output: str, label: str) -> list[str]:
    zeroed = set(re.findall(r'6010: \w+ function "([^"]+)" not referenced', output))
    unexpected = sorted(zeroed - EXPECTED_DEAD_CODE)
    print(f"{label}: compiled, {len(zeroed)} stripped function(s)")
    return unexpected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="keep the staged directory")
    args = parser.parse_args()

    if not shutil.which("makensis"):
        raise SystemExit("makensis not found")

    work = Path(tempfile.mkdtemp(prefix="ninety-nsis-"))
    try:
        script = stage(work)

        # The standalone shells share kurogane-ui.nsh with the installer, and the
        # selector has to be compiled first: the installer embeds the resulting
        # kurogane-language.exe, exactly as the release workflow does.
        for name in ("language-selector.nsi", "smoke.nsi", "concept-gallery.nsi"):
            output = compile_script(script.parent / "kurogane" / name, ["-DVERSION=0.0.0"])
            report_dead_code(output, name)

        unexpected = report_dead_code(compile_script(script), "installer.nsi")

        if unexpected:
            print(
                "NSIS stripped installer code that is not known to be dead: "
                + ", ".join(unexpected)
            )
            print(
                "A stripped function is zero-filled, and reaching one at runtime "
                'shows "Distribution corrupted: invalid opcode" on every event.'
            )
            return 1
    finally:
        if args.keep:
            print(f"staged in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
