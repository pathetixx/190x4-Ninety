#!/usr/bin/env python3
"""Windows launcher for real Ninety README screenshot capture.

The generic capture module contains fixture data, DOM navigation and image checks.
This launcher discovers the actual WebView2 user-data directory from the command
line of the running msedgewebview2.exe process, reads DevToolsActivePort, then
connects directly to that real WebView instance. No guessed port or rendered mock
application is involved.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from types import ModuleType
from typing import Any


CAPTURE_MODULE = pathlib.Path(__file__).with_name("capture-readme-screenshots.py")
USER_DATA_RE = re.compile(r'(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))', re.IGNORECASE)


def load_capture_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ninety_readme_capture", CAPTURE_MODULE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {CAPTURE_MODULE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--version", required=True)
    return parser.parse_args()


def webview_processes() -> list[dict[str, Any]]:
    command = (
        "$items = Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
        "Select-Object ProcessId,ParentProcessId,CommandLine; "
        "if ($items) { $items | ConvertTo-Json -Compress } else { '[]' }"
    )
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"WebView2 process query failed: {completed.stderr.strip()}")
    raw = completed.stdout.strip() or "[]"
    payload = json.loads(raw)
    if isinstance(payload, dict):
        return [payload]
    return payload if isinstance(payload, list) else []


def user_data_dirs(processes: list[dict[str, Any]]) -> list[pathlib.Path]:
    found: list[pathlib.Path] = []
    for item in processes:
        command_line = str(item.get("CommandLine") or "")
        match = USER_DATA_RE.search(command_line)
        if not match:
            continue
        value = match.group(1) or match.group(2)
        path = pathlib.Path(value)
        if path not in found:
            found.append(path)
    return found


def active_port_files(root: pathlib.Path) -> list[pathlib.Path]:
    candidates = [root / "DevToolsActivePort"]
    if root.name.lower() != "ebwebview":
        candidates.append(root / "EBWebView" / "DevToolsActivePort")
    try:
        candidates.extend(root.glob("**/DevToolsActivePort"))
    except OSError:
        pass
    unique: list[pathlib.Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def read_active_port(path: pathlib.Path) -> int | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        port = int(lines[0].strip())
        return port if 1 <= port <= 65535 else None
    except (OSError, ValueError, IndexError):
        return None


def port_has_targets(capture: ModuleType, port: int) -> bool:
    try:
        targets = capture.read_json(f"http://127.0.0.1:{port}/json/list", timeout=1.5)
        return isinstance(targets, list) and any(
            item.get("type") == "page" and item.get("webSocketDebuggerUrl")
            for item in targets
            if isinstance(item, dict)
        )
    except Exception:
        return False


def wait_for_devtools(capture: ModuleType, app_process: subprocess.Popen[Any], timeout: float = 60.0) -> int:
    deadline = time.monotonic() + timeout
    seen_dirs: list[pathlib.Path] = []
    last_processes: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        exit_code = app_process.poll()
        if exit_code is not None:
            raise RuntimeError(f"Ninety exited before WebView2 was ready, code={exit_code}")

        last_processes = webview_processes()
        for directory in user_data_dirs(last_processes):
            if directory not in seen_dirs:
                seen_dirs.append(directory)
                print(f"WebView2 user-data directory: {directory}", flush=True)
            for active_file in active_port_files(directory):
                port = read_active_port(active_file)
                if port and port_has_targets(capture, port):
                    print(f"WebView2 DevTools port: {port} ({active_file})", flush=True)
                    return port
        time.sleep(0.25)

    commands = [str(item.get("CommandLine") or "") for item in last_processes]
    raise RuntimeError(
        "WebView2 DevTools target not discovered. "
        f"user-data dirs={seen_dirs}; WebView2 command lines={commands}"
    )


def run_capture(capture: ModuleType, args: argparse.Namespace) -> int:
    app = args.app.resolve()
    output = args.output.resolve()
    if not app.is_file():
        raise FileNotFoundError(app)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    server = ThreadingHTTPServer(("127.0.0.1", capture.CLASH_PORT), capture.ClashHandler)
    threading.Thread(target=server.serve_forever, name="clash-fixture", daemon=True).start()

    env = os.environ.copy()
    existing = env.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "").strip()
    remote_args = "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --remote-allow-origins=*"
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"{existing} {remote_args}".strip()
    env["NINETY_README_CAPTURE"] = "1"

    process = subprocess.Popen([str(app)], env=env, cwd=str(app.parent))
    client = None
    try:
        capture.DEBUG_PORT = wait_for_devtools(capture, process)
        websocket_url = capture.wait_for_webview(deadline_seconds=20)
        client = capture.CdpClient(websocket_url)
        client.call("Page.enable")
        client.call("Runtime.enable")
        capture.seed_storage(client, capture.build_fixture(args.version))
        capture.write_fixture_log(client)

        capture.show_view(client, "home")
        capture.capture(client, output / "home.png")

        capture.show_view(client, "proxies")
        capture.wait_js(client, "document.querySelectorAll('#proxies-grid .prox').length >= 7")
        capture.capture(client, output / "nodes.png")

        capture.show_view(client, "profiles")
        capture.wait_js(client, "document.querySelectorAll('#profiles-list .prof-card').length >= 2")
        capture.capture(client, output / "profiles.png")

        capture.show_view(client, "dpi")
        capture.capture(client, output / "dpi.png")

        capture.show_view(client, "settings")
        capture.capture(client, output / "settings.png")

        capture.show_view(client, "logs")
        capture.wait_js(client, "document.querySelectorAll('#logs-view .log-line').length >= 5")
        capture.capture(client, output / "logs.png")

        capture.prepare_quality(client)
        capture.capture(client, output / "quality.png")

        capture.validate_images(output)
        print(f"Captured {len(capture.EXPECTED_SCREENSHOTS)} real Ninety screenshots in {output}")
        for name in capture.EXPECTED_SCREENSHOTS:
            with capture.Image.open(output / name) as image:
                print(f"  {name}: {image.width}x{image.height}, {(output / name).stat().st_size} bytes")
        return 0
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        server.shutdown()
        server.server_close()


def main() -> int:
    capture = load_capture_module()
    return run_capture(capture, parse_args())


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"capture-readme-windows: {exc}", file=sys.stderr, flush=True)
        raise
