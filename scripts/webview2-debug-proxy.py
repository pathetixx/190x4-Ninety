#!/usr/bin/env python3
"""Expose a WebView2 dynamic DevTools port on a stable localhost port.

WebView2 writes the selected port to DevToolsActivePort when launched with
--remote-debugging-port=0. This helper waits for that file below the isolated
user-data directory and forwards TCP traffic from a stable port used by the
README capture script. It supports both HTTP discovery and WebSocket CDP.
"""

from __future__ import annotations

import argparse
import pathlib
import selectors
import socket
import sys
import threading
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-data-root", required=True, type=pathlib.Path)
    parser.add_argument("--listen-port", required=True, type=int)
    parser.add_argument("--timeout", type=float, default=90.0)
    return parser.parse_args()


def find_devtools_port(root: pathlib.Path, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    seen: set[pathlib.Path] = set()
    while time.monotonic() < deadline:
        if root.exists():
            for path in root.rglob("DevToolsActivePort"):
                if path in seen:
                    continue
                seen.add(path)
                try:
                    lines = path.read_text(encoding="utf-8").splitlines()
                    port = int(lines[0].strip())
                    if 1 <= port <= 65535:
                        print(f"WebView2 DevTools port {port} from {path}", flush=True)
                        return port
                except (OSError, ValueError, IndexError):
                    seen.discard(path)
        time.sleep(0.15)
    raise TimeoutError(f"DevToolsActivePort not found below {root}")


def relay(client: socket.socket, target_port: int) -> None:
    upstream: socket.socket | None = None
    try:
        upstream = socket.create_connection(("127.0.0.1", target_port), timeout=10)
        client.setblocking(False)
        upstream.setblocking(False)
        selector = selectors.DefaultSelector()
        selector.register(client, selectors.EVENT_READ, upstream)
        selector.register(upstream, selectors.EVENT_READ, client)
        while True:
            events = selector.select(timeout=30)
            if not events:
                continue
            for key, _ in events:
                source: socket.socket = key.fileobj
                destination: socket.socket = key.data
                try:
                    data = source.recv(65536)
                except BlockingIOError:
                    continue
                if not data:
                    return
                destination.sendall(data)
    except (OSError, ConnectionError) as exc:
        print(f"relay error: {exc}", file=sys.stderr, flush=True)
    finally:
        try:
            client.close()
        except OSError:
            pass
        if upstream is not None:
            try:
                upstream.close()
            except OSError:
                pass


def main() -> int:
    args = parse_args()
    root = args.user_data_root.resolve()
    target_port = find_devtools_port(root, args.timeout)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", args.listen_port))
        listener.listen(16)
        print(f"Forwarding 127.0.0.1:{args.listen_port} -> 127.0.0.1:{target_port}", flush=True)
        while True:
            client, _ = listener.accept()
            threading.Thread(target=relay, args=(client, target_port), daemon=True).start()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"webview2-debug-proxy: {exc}", file=sys.stderr, flush=True)
        raise
