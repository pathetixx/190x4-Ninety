<div align="center">

![Ninety](./docs/banner.png)

[![Release](https://img.shields.io/badge/release-v0.1.81-C0304A)](https://github.com/pathetixx/190x4-Ninety/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/pathetixx/190x4-Ninety/build.yml?event=push&label=build)](https://github.com/pathetixx/190x4-Ninety/actions)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-1d1d24)](#installation)
[![License](https://img.shields.io/badge/license-MIT-6B6B72)](./LICENSE)

**A native VPN client for Windows.**

[Русский](./README.ru.md) · **English**

</div>

---

![Home](./docs/home.png)

## What is Ninety?

Ninety is a native VPN client for Windows built on the universal sing-box proxy core. It does a lot: auto-picks the fastest node, runs a TUN mode that covers all system traffic, handles subscriptions and remote profiles, bypasses blocking and routes by region. With support for a wide set of protocols (VLESS, VMess, Trojan, Hysteria2, TUIC, NaiveProxy, TrustTunnel and more), no ads and open source — it's safe, private access to the free internet.

## Features

- **Subscriptions and standalone configs** — import by URL, from the clipboard, or via a `ninety://` link. Auto-update on the subscription's interval, QR export.
- **Node selection** — a grid of servers with flags and live ping; **Auto** mode keeps the connection on the fastest node and switches by itself when latency rises or a timeout hits.
- **Connection-quality control** — watches the real connection speed and, if the provider starts throttling it, recovers on its own: switches servers, turns on traffic masking, or brings up a backup channel. An indicator on the main screen shows the current state; fine-tuning lives in the "Connection quality" section.
- **Three connection modes** — proxy, system proxy (no administrator rights), and **TUN** (all system traffic): turning it on prompts for UAC once, and the "always run as administrator" option removes even that.
- **Block bypass** — TLS ClientHello fragmentation (by TLS records or TCP segments) helps bring the tunnel up when the provider throttles the handshake by SNI; plus a built-in DPI bypass to unblock services.
- **Routing** — LAN bypass, region rules (in-country traffic goes direct), ad and tracker blocking at the DNS and routing level.
- **WARP** — built-in registration, endpoint selection with a scanner and traffic masking; works as a standalone exit or as a link in a chain.
- **Fine-tuning** — DNS (remote/direct, fake-DNS), MTU and TUN stack, TLS tricks (fragmentation, padding, mixed-case SNI), connection test and intervals.
- **Start at system login**, minimize to tray, automatic updates via GitHub Releases.
- **6 themes** — Kurogane, Cyan, Synthwave, Matrix, Command Center, Mono. The whole interface runs on CSS variables; the theme accent is picked up by the portal windows and the cyber HUD on the main screen.
- **15 languages** — the interface is translated into 15 languages, switchable in Settings → Appearance without a restart; فارسی and العربية are laid out right-to-left (RTL).

## Protocols and transports

VLESS · VMess · Trojan · Shadowsocks · Hysteria2 · TUIC · NaiveProxy · TrustTunnel
Reality · TLS (uTLS fingerprints) · XHTTP · WebSocket · gRPC · HTTP/2 · TCP

NaiveProxy and TrustTunnel are served by their own clients over a local
SOCKS bridge (like XHTTP), independent of the selected connection mode.

## Interface

The main screen is a cyber HUD around a live mask: channel status, ping, connection
integrity and the server the tunnel runs through. The other sections:

| Nodes | Profiles |
|------|---------|
| ![Nodes](./docs/nodes.png) | ![Profiles](./docs/profiles.png) |
| **DPI bypass** | **Settings** |
| ![DPI bypass](./docs/dpi.png) | ![Settings](./docs/settings.png) |
| **Logs** | **Channel quality** |
| ![Logs](./docs/logs.png) | ![Channel quality](./docs/quality.png) |

## Installation

Download the installer from [**Releases**](https://github.com/pathetixx/190x4-Ninety/releases) — `.msi` or `.exe` (NSIS).
Updates arrive inside the app and install in one click.

Requirements: Windows 10 / 11 (x64).

## Quick start

1. **Add a source.** The **"+"** button at the top — paste a subscription URL (`https://…`) or a standalone `vless://` / `vmess://` / `trojan://` / `hysteria2://` / `tuic://` / `naive+https://…` / `tt://…` config from the clipboard. For TrustTunnel you can also import an endpoint `.toml` file (the **".toml file"** tile). A subscription pulls in the server list and updates on its own interval.
2. **Pick a mode** (the toggle on the main screen):
   - **System proxy** — the default, no administrator rights. Works for a browser and most apps.
   - **Proxy** — a local SOCKS/HTTP on `127.0.0.1`; you point apps at it yourself.
   - **VPN · TUN** — all system traffic goes through the tunnel. Turning it on asks for UAC once.
3. **Connect** — click the large disc in the center of the main screen. Click again to disconnect.
4. **Fine-tuning (optional):**
   - On the **Nodes** tab pick a server by hand or leave it on **Auto** — the client keeps the connection on the fastest node and switches when latency rises.
   - Turn on **DPI bypass** if a particular service is unreachable even with the VPN running.
   - Turn on **TLS fragmentation** if the tunnel won't come up at all (see below).

**Not connecting?**
- Refresh the subscription (profile menu → refresh) — servers may have changed.
- Switch the node or flip to **Auto**.
- Turn on **ClientHello fragmentation** (Settings → TLS tricks) — it often helps when the provider cuts the handshake.
- Open the **Logs** — they show where the connection breaks.

## Block bypass

When the provider interferes with the connection, Ninety has two independent mechanisms — they can be used together.

**TLS ClientHello fragmentation.** Some providers detect and cut traffic at the TLS handshake stage, reading the server name (SNI) from the first packet — the ClientHello. Ninety splits that packet into parts so the filter can't reassemble the SNI, and the tunnel comes up. Two split methods are available — by TLS records (recommended) or by TCP segments — plus padding and mixed-case SNI. Enabled in **Settings → TLS tricks**.

**DPI bypass.** A separate built-in engine for services the provider blocks at the DPI level even with the VPN running (e.g. voice calls in messengers, or specific sites). Managed in the **DPI bypass** section: turned on with a single button, the strategy can be picked by hand or via **auto-pick** — the client tries the options and keeps the one that works for your provider. Domain and exclusion lists are edited right in the app, and your VPN nodes' addresses are added to exclusions automatically so the bypass doesn't touch the tunnel itself. In full TUN mode the bypass isn't needed (all traffic is already in the tunnel) and pauses automatically. A separate toggle can load the bypass driver under a neutral name (instead of the standard one) — it doesn't affect functionality.

## Build from source

You'll need Rust (stable), Node ≥ 18 and MSVC build tools.

```powershell
npm install
npm run tauri dev     # development window
npm run tauri build   # release build → .msi / .exe
```

The engines (sing-box, xray-core, the NaiveProxy and TrustTunnel clients) and `wintun.dll` are pulled in during the CI build and aren't stored in the repository — see [`.github/workflows/build.yml`](./.github/workflows/build.yml).

## Architecture

- **Interface** — Tauri 2 (Rust + WebView2), frontend in vanilla HTML/CSS/JS with no frameworks or bundlers.
- **Engine** — sing-box runs as a child process; the XHTTP transport is served by the xray-core engine, and the NaiveProxy and TrustTunnel protocols by their own clients; all of them connect to sing-box over a local socks bridge.
- **TUN** — sing-box brings up the TUN interface as a child process of the app running with administrator rights; UAC is requested once when enabling it (the "always run as administrator" option removes even that). The core's control API is locked with a secret and listens only on loopback.
- **Subscriptions and settings** — in `localStorage`; the engine config is assembled on the fly for the current mode and node.

## Support

The project runs on enthusiasm. If Ninety turned out useful — you can buy a coffee (hover over the address and click 📋 to copy):

**TON**

```
UQC21op6_5Qgsw0i7TQvh12XBex9I5bqmPeMNuJ20INdjtg7
```

**USDT** · TRC20 (Tron)

```
TGbdvr1gSYgQciFNRjwdmAmCbNLjK9wgJR
```

Thank you 🖤

## License

[MIT](./LICENSE)
