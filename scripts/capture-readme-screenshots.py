#!/usr/bin/env python3
"""Capture deterministic README screenshots from the real Ninety Tauri/WebView2 UI.

The script launches the compiled Windows application, injects sanitized fixture state
into the app's own localStorage, serves a tiny local Clash-compatible API for the
node screen, and captures the actual WebView surface through Chrome DevTools Protocol.
No generated or reconstructed UI is used.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from PIL import Image, ImageStat
import websocket

DEBUG_PORT = 9222
CLASH_PORT = 9090
EXPECTED_SCREENSHOTS = (
    "home.png",
    "nodes.png",
    "profiles.png",
    "dpi.png",
    "settings.png",
    "logs.png",
    "quality.png",
)


def stable_hash(value: str) -> str:
    """JS-compatible hashRuntimeValue() from src/lib/runtime-identity.js."""
    a = 0x811C9DC5
    b = 0x9E3779B9
    for char in value:
        code = ord(char)
        a = ((a ^ code) * 0x01000193) & 0xFFFFFFFF
        b = ((b ^ code) * 0x85EBCA6B) & 0xFFFFFFFF
    return f"{base36(a)}{base36(b)}"


def base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = []
    while value:
        value, rem = divmod(value, 36)
        out.append(digits[rem])
    return "".join(reversed(out))


NODES = [
    {
        "stableId": "demo-de-frankfurt",
        "name": "🇩🇪 Frankfurt · Reality",
        "host": "de-fra.demo.invalid",
        "port": 443,
        "proto": "vless",
        "type": "tcp",
        "security": "reality",
        "uuid": "00000000-0000-4000-8000-000000000001",
        "sni": "www.microsoft.com",
        "pbk": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sid": "01",
    },
    {
        "stableId": "demo-nl-amsterdam",
        "name": "🇳🇱 Amsterdam · XHTTP",
        "host": "nl-ams.demo.invalid",
        "port": 443,
        "proto": "vless",
        "type": "xhttp",
        "security": "tls",
        "uuid": "00000000-0000-4000-8000-000000000002",
        "sni": "www.cloudflare.com",
        "path": "/demo",
        "mode": "auto",
    },
    {
        "stableId": "demo-fi-helsinki",
        "name": "🇫🇮 Helsinki · Hysteria2",
        "host": "fi-hel.demo.invalid",
        "port": 443,
        "proto": "hysteria2",
        "security": "tls",
        "password": "demo-only",
        "sni": "www.apple.com",
    },
    {
        "stableId": "demo-ch-zurich",
        "name": "🇨🇭 Zurich · Trojan",
        "host": "ch-zrh.demo.invalid",
        "port": 443,
        "proto": "trojan",
        "type": "grpc",
        "security": "tls",
        "password": "demo-only",
        "sni": "www.google.com",
        "serviceName": "demo",
    },
    {
        "stableId": "demo-pl-warsaw",
        "name": "🇵🇱 Warsaw · VLESS",
        "host": "pl-waw.demo.invalid",
        "port": 8443,
        "proto": "vless",
        "type": "ws",
        "security": "tls",
        "uuid": "00000000-0000-4000-8000-000000000005",
        "sni": "www.github.com",
        "path": "/ws",
    },
    {
        "stableId": "demo-jp-tokyo",
        "name": "🇯🇵 Tokyo · TUIC",
        "host": "jp-tyo.demo.invalid",
        "port": 443,
        "proto": "tuic",
        "security": "tls",
        "uuid": "00000000-0000-4000-8000-000000000006",
        "password": "demo-only",
        "sni": "www.amazon.com",
    },
]

NODE_TAGS = [f"node-{stable_hash('node:' + node['stableId'])}" for node in NODES]
DELAYS = [34, 46, 58, 71, 92, 138]


def clash_payload() -> dict[str, Any]:
    now = NODE_TAGS[0]
    proxies: dict[str, Any] = {
        "proxy": {
            "type": "Selector",
            "now": "auto",
            "all": ["auto", "lowest", *NODE_TAGS],
            "history": [],
        },
        "auto": {
            "type": "Balancer",
            "now": now,
            "all": NODE_TAGS,
            "history": [{"time": "2026-07-17T08:00:00Z", "delay": DELAYS[0]}],
        },
        "lowest": {
            "type": "URLTest",
            "now": now,
            "all": NODE_TAGS,
            "history": [{"time": "2026-07-17T08:00:00Z", "delay": DELAYS[0]}],
        },
    }
    for tag, delay in zip(NODE_TAGS, DELAYS, strict=True):
        proxies[tag] = {
            "type": "VLESS",
            "name": tag,
            "udp": True,
            "history": [{"time": "2026-07-17T08:00:00Z", "delay": delay}],
        }
    return {"proxies": proxies}


class ClashHandler(BaseHTTPRequestHandler):
    server_version = "NinetyReadmeFixture/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/proxies":
            self._json(clash_payload())
            return
        if path == "/connections":
            self._json(
                {
                    "uploadTotal": 186_234_112,
                    "downloadTotal": 4_862_992_384,
                    "connections": [
                        {
                            "metadata": {
                                "host": "github.com",
                                "destinationIP": "140.82.121.4",
                                "processPath": r"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                            },
                            "chains": [NODE_TAGS[0], "proxy"],
                        },
                        {
                            "metadata": {
                                "host": "windowsupdate.com",
                                "destinationIP": "13.107.246.40",
                                "processPath": r"C:\\Windows\\System32\\svchost.exe",
                            },
                            "chains": ["direct"],
                        },
                    ],
                }
            )
            return
        if path.startswith("/proxies/") and path.endswith("/delay"):
            encoded = path[len("/proxies/") : -len("/delay")].strip("/")
            tag = urllib.parse.unquote(encoded)
            delay = DELAYS[NODE_TAGS.index(tag)] if tag in NODE_TAGS else DELAYS[0]
            self._json({"delay": delay})
            return
        if path.startswith("/group/") and path.endswith("/delay"):
            self._json({tag: delay for tag, delay in zip(NODE_TAGS, DELAYS, strict=True)})
            return
        self._json({"error": "not found"}, status=404)

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._json({})


class CdpClient:
    def __init__(self, websocket_url: str) -> None:
        self.ws = websocket.create_connection(
            websocket_url,
            timeout=20,
            origin="http://localhost",
            enable_multithread=True,
        )
        self._next_id = 1

    def close(self) -> None:
        self.ws.close()

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        call_id = self._next_id
        self._next_id += 1
        message: dict[str, Any] = {"id": call_id, "method": method}
        if params is not None:
            message["params"] = params
        self.ws.send(json.dumps(message))
        while True:
            raw = self.ws.recv()
            if not raw:
                raise RuntimeError(f"CDP disconnected during {method}")
            payload = json.loads(raw)
            if payload.get("id") != call_id:
                continue
            if "error" in payload:
                raise RuntimeError(f"CDP {method}: {payload['error']}")
            return payload.get("result", {})

    def evaluate(self, expression: str, *, await_promise: bool = True) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
                "userGesture": True,
            },
        )
        remote = result.get("result", {})
        if remote.get("subtype") == "error":
            raise RuntimeError(remote.get("description") or "JavaScript evaluation failed")
        if result.get("exceptionDetails"):
            raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False))
        return remote.get("value")


def read_json(url: str, timeout: float = 2.0) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": "Ninety-readme-capture"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_webview(deadline_seconds: int = 45) -> str:
    deadline = time.monotonic() + deadline_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            targets = read_json(f"http://127.0.0.1:{DEBUG_PORT}/json/list")
            pages = [item for item in targets if item.get("type") == "page" and item.get("webSocketDebuggerUrl")]
            preferred = [
                item
                for item in pages
                if "ninety" in str(item.get("title", "")).lower()
                or str(item.get("url", "")).startswith(("tauri://", "http://tauri.localhost"))
            ]
            if preferred or pages:
                return (preferred or pages)[0]["webSocketDebuggerUrl"]
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"WebView2 DevTools target did not appear: {last_error}")


def wait_js(client: CdpClient, condition: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if client.evaluate(f"Boolean({condition})"):
            return
        time.sleep(0.15)
    raise RuntimeError(f"Timed out waiting for JavaScript condition: {condition}")


def build_fixture(version: str) -> dict[str, str]:
    now_ms = int(time.time() * 1000) - 4 * 60 * 1000
    now_sec = int(time.time())
    subscription = {
        "id": "sub_readme_demo",
        "url": "https://subscription.demo.invalid/ninety",
        "name": "190X4 DEMO NETWORK",
        "lastUpdate": now_ms,
        "expire": now_sec + 153 * 86_400,
        "upload": 1_432_655_872,
        "download": 24_668_946_432,
        "total": 1_099_511_627_776,
        "updateIntervalMode": "manual",
        "updateIntervalHours": 6,
        "serverUpdateIntervalHours": 6,
        "profiles": NODES,
    }
    standalone = {
        "id": "profile_readme_demo",
        "stableId": "profile-readme-demo",
        "name": "🇸🇪 Stockholm · Backup",
        "host": "se-sto.demo.invalid",
        "port": 443,
        "proto": "vless",
        "type": "tcp",
        "security": "reality",
        "uuid": "00000000-0000-4000-8000-000000000099",
        "sni": "www.microsoft.com",
        "pbk": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sid": "99",
    }
    options = {
        "region": "ru",
        "quality": {"enabled": True, "aggressive": False},
        "general": {"disableGeoLookup": True},
        "experimental": {"enableClashApi": True, "clashApiPort": CLASH_PORT},
    }
    return {
        "ninety.lang": "ru",
        "ninety.theme": "kurogane",
        "ninety.mode": "systemProxy",
        "ninety.onboarding.done": "1",
        "ninety.region.detected": "1",
        "ninety.active.kind": "sub",
        "ninety.subscriptions.active": subscription["id"],
        "ninety.subscriptions.v1": json.dumps([subscription], ensure_ascii=False),
        "ninety.profiles.v1": json.dumps([standalone], ensure_ascii=False),
        "ninety.options.v1": json.dumps(options, ensure_ascii=False),
        "ninety.readme.capture.version": version,
        "ninety.traffic.sub:sub_readme_demo": json.dumps(
            {"up": 186_234_112, "down": 4_862_992_384, "total": 5_049_226_496}
        ),
    }


def seed_storage(client: CdpClient, fixture: dict[str, str]) -> None:
    fixture_json = json.dumps(fixture, ensure_ascii=False)
    client.evaluate(
        f"""
        (() => {{
          for (let i = localStorage.length - 1; i >= 0; i--) {{
            const key = localStorage.key(i);
            if (key && key.startsWith('ninety.')) localStorage.removeItem(key);
          }}
          const fixture = {fixture_json};
          for (const [key, value] of Object.entries(fixture)) localStorage.setItem(key, value);
          sessionStorage.clear();
          return true;
        }})()
        """,
        await_promise=False,
    )
    client.call("Page.reload", {"ignoreCache": True})
    wait_js(client, "document.readyState === 'complete' && document.querySelector('#app-root')")
    wait_js(client, "document.querySelectorAll('.nav__item[data-view]').length >= 6")
    client.evaluate(
        """
        (async () => {
          await document.fonts.ready;
          const video = document.querySelector('#hero-mask');
          if (video) {
            try { video.pause(); video.currentTime = 0.65; } catch (_) {}
          }
          return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
        })()
        """
    )
    time.sleep(1.0)


def write_fixture_log(client: CdpClient) -> None:
    path = client.evaluate(
        "(async () => await window.__TAURI__.core.invoke('singbox_log_path'))()"
    )
    if not path:
        raise RuntimeError("singbox_log_path returned an empty path")
    log_path = pathlib.Path(path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_text = "\n".join(
        [
            "+0300 2026-07-17 12:00:01 INFO [system] Ninety runtime initialized",
            "+0300 2026-07-17 12:00:02 INFO [mixed-in] listening on 127.0.0.1:7890",
            "+0300 2026-07-17 12:00:03 INFO [🇩🇪 Frankfurt · Reality] outbound ready",
            "+0300 2026-07-17 12:00:04 DEBUG [dns] query github.com via dns-remote",
            "+0300 2026-07-17 12:00:05 INFO [proxy] connection to github.com:443 established",
            "+0300 2026-07-17 12:00:06 WARN [quality] temporary throughput drop; observing",
            "+0300 2026-07-17 12:00:07 INFO [quality] channel recovered without reconnect",
            "+0300 2026-07-17 12:00:08 INFO [route] windowsupdate.com matched direct rule",
            "+0300 2026-07-17 12:00:09 INFO [system] configuration contains demo.invalid endpoints only",
        ]
    )
    log_path.write_text(log_text + "\n", encoding="utf-8")


def show_view(client: CdpClient, name: str) -> None:
    ok = client.evaluate(
        f"""
        (() => {{
          const item = document.querySelector('.nav__item[data-view="{name}"]');
          if (!item) return false;
          item.click();
          return true;
        }})()
        """,
        await_promise=False,
    )
    if not ok:
        raise RuntimeError(f"Navigation item not found: {name}")
    wait_js(client, f"!document.querySelector('section.screen[data-view=\"{name}\"]').hidden")
    time.sleep(1.0 if name in {"proxies", "logs", "dpi", "settings"} else 0.45)


def prepare_quality(client: CdpClient) -> None:
    show_view(client, "home")
    client.evaluate(
        """
        (async () => {
          const strip = document.querySelector('#stats-strip');
          if (strip) strip.hidden = false;
          const values = {
            '#stats-server': 'Frankfurt · Reality',
            '#stats-ping': '34',
            '#stats-channel': 'Отлично',
            '#stats-uptime': '18:42',
            '#stats-total': '↓ 4.53 ГБ · ↑ 178 МБ',
            '#stats-mode': 'СИСТЕМНЫЙ'
          };
          for (const [selector, value] of Object.entries(values)) {
            const el = document.querySelector(selector);
            if (el) el.textContent = value;
          }
          const channel = document.querySelector('#tele-channel');
          if (!channel) return false;
          channel.dataset.q = 'GOOD';
          channel.dataset.active = 'true';
          const mod = await import('/lib/quality-scope.js');
          const samples = Array.from({length: 46}, (_, i) => ({
            bps: 1800000 + Math.sin(i / 3) * 420000 + (i % 9 === 0 ? -520000 : 0),
            q: i % 9 === 0 ? 'SLOW' : 'GOOD',
            rung: i === 13 ? 'R1' : (i === 31 ? 'R2' : null)
          }));
          mod.openQualityScope({ anchor: channel, getSamples: () => samples, goodBps: 1500000 });
          await new Promise(resolve => setTimeout(resolve, 250));
          return Boolean(document.querySelector('.qscope'));
        })()
        """
    )
    wait_js(client, "document.querySelector('.qscope')")
    time.sleep(0.5)


def capture(client: CdpClient, output: pathlib.Path) -> tuple[int, int]:
    metrics = client.evaluate("({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})")
    width = int(metrics["width"])
    height = int(metrics["height"])
    if width < 1000 or height < 650:
        raise RuntimeError(f"Unexpected WebView viewport: {width}x{height}")
    result = client.call(
        "Page.captureScreenshot",
        {
            "format": "png",
            "fromSurface": True,
            "captureBeyondViewport": False,
            "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": 1},
        },
    )
    data = result.get("data")
    if not data:
        raise RuntimeError(f"No screenshot data for {output.name}")
    output.write_bytes(base64.b64decode(data))
    return width, height


def validate_images(output_dir: pathlib.Path) -> None:
    missing = [name for name in EXPECTED_SCREENSHOTS if not (output_dir / name).is_file()]
    if missing:
        raise RuntimeError(f"Missing screenshots: {', '.join(missing)}")

    expected_size: tuple[int, int] | None = None
    hashes: set[bytes] = set()
    for name in EXPECTED_SCREENSHOTS:
        path = output_dir / name
        if path.stat().st_size < 45_000:
            raise RuntimeError(f"Screenshot is suspiciously small: {name} ({path.stat().st_size} bytes)")
        with Image.open(path) as image:
            image.load()
            if image.format != "PNG":
                raise RuntimeError(f"Unexpected image format for {name}: {image.format}")
            if expected_size is None:
                expected_size = image.size
            elif image.size != expected_size:
                raise RuntimeError(f"Inconsistent screenshot size: {name} is {image.size}, expected {expected_size}")
            if image.width < 1000 or image.height < 650:
                raise RuntimeError(f"Screenshot viewport too small: {name} is {image.size}")
            rgb = image.convert("RGB")
            stats = ImageStat.Stat(rgb.resize((160, 105)))
            if max(stats.stddev) < 12:
                raise RuntimeError(f"Screenshot lacks visual variance: {name}")
            pixels = list(rgb.resize((160, 105)).getdata())
            near_black = sum(1 for r, g, b in pixels if r < 8 and g < 8 and b < 8) / len(pixels)
            near_white = sum(1 for r, g, b in pixels if r > 247 and g > 247 and b > 247) / len(pixels)
            if near_black > 0.94 or near_white > 0.94:
                raise RuntimeError(
                    f"Screenshot appears blank: {name} black={near_black:.1%} white={near_white:.1%}"
                )
        digest = path.read_bytes()
        if digest in hashes:
            raise RuntimeError(f"Duplicate screenshot bytes detected: {name}")
        hashes.add(digest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--version", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    app = args.app.resolve()
    output = args.output.resolve()
    if not app.is_file():
        raise FileNotFoundError(app)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    server = ThreadingHTTPServer(("127.0.0.1", CLASH_PORT), ClashHandler)
    server_thread = threading.Thread(target=server.serve_forever, name="clash-fixture", daemon=True)
    server_thread.start()

    env = os.environ.copy()
    existing = env.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "").strip()
    remote_args = f"--remote-debugging-port={DEBUG_PORT} --remote-allow-origins=*"
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"{existing} {remote_args}".strip()
    env["NINETY_README_CAPTURE"] = "1"

    process = subprocess.Popen([str(app)], env=env, cwd=str(app.parent))
    client: CdpClient | None = None
    try:
        websocket_url = wait_for_webview()
        client = CdpClient(websocket_url)
        client.call("Page.enable")
        client.call("Runtime.enable")
        seed_storage(client, build_fixture(args.version))
        write_fixture_log(client)

        show_view(client, "home")
        capture(client, output / "home.png")

        show_view(client, "proxies")
        wait_js(client, "document.querySelectorAll('#proxies-grid .prox').length >= 7")
        capture(client, output / "nodes.png")

        show_view(client, "profiles")
        wait_js(client, "document.querySelectorAll('#profiles-list .prof-card').length >= 2")
        capture(client, output / "profiles.png")

        show_view(client, "dpi")
        capture(client, output / "dpi.png")

        show_view(client, "settings")
        capture(client, output / "settings.png")

        show_view(client, "logs")
        wait_js(client, "document.querySelectorAll('#logs-view .log-line').length >= 5")
        capture(client, output / "logs.png")

        prepare_quality(client)
        capture(client, output / "quality.png")

        validate_images(output)
        print(f"Captured {len(EXPECTED_SCREENSHOTS)} real Ninety screenshots in {output}")
        for name in EXPECTED_SCREENSHOTS:
            with Image.open(output / name) as image:
                print(f"  {name}: {image.width}x{image.height}, {(output / name).stat().st_size} bytes")
        return 0
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"capture-readme-screenshots: {exc}", file=sys.stderr)
        raise
