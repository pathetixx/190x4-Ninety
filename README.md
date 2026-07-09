<div align="center">

![Ninety](./docs/banner.png)

[![Release](https://img.shields.io/github/v/release/pathetixx/190x4-Ninety?label=release&color=C0304A)](https://github.com/pathetixx/190x4-Ninety/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/pathetixx/190x4-Ninety/build.yml?event=push&label=build)](https://github.com/pathetixx/190x4-Ninety/actions)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-1d1d24)](#installation)
[![License](https://img.shields.io/badge/license-MIT-6B6B72)](./LICENSE)

# Ninety

**A Windows desktop networking client built with Tauri 2 and Rust around sing-box, WARP, routing rules and connection diagnostics.**

[Download](https://github.com/pathetixx/190x4-Ninety/releases) · [Русский](./README.ru.md) · **English** · [Changelog](./CHANGELOG.md) · [Security](./SECURITY.md)

</div>

---

![Home](./docs/home.png)

## Why Ninety?

Ninety is a native Windows desktop client built around the sing-box ecosystem, Tauri 2 and Rust. It is designed for users who want one clean app for subscriptions, standalone profiles, WARP, TUN mode, routing rules, DPI tools, logs, tray control and real connection-quality feedback.

The goal is not to be a thin wrapper around a `config.json`. Ninety treats connection state as a product problem: it starts and stops helper engines safely, restores Windows proxy settings, tracks the actually selected node, cleans runtime configs, keeps sensitive local state encrypted where possible, and gives the user visible diagnostics instead of a vague "connected" label.

> Ninety is a networking client, not an anonymity guarantee. Your privacy still depends on your server, provider, configuration and operating-system environment.

## Highlights

| Area | What Ninety does |
| --- | --- |
| **Connection modes** | Local proxy, Windows system proxy and full **VPN · TUN** mode. TUN requests UAC only when needed; the app can also run elevated on login. |
| **Sources** | Imports subscriptions, standalone links and TrustTunnel `.toml` endpoints. Supports clipboard import and optional deep links. |
| **Node control** | Server grid with flags, live delay checks, auto selection, tray server switching and effective-node tracking. |
| **Protocols** | VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, NaiveProxy, TrustTunnel and WARP/WireGuard. |
| **Bridges** | XHTTP via xray-core; NaiveProxy and TrustTunnel via local SOCKS sidecars; sing-box remains the central router. |
| **Routing** | LAN bypass, regional rules, custom domain/IP/process rules, ad/malware/phishing rule sets and a live connections view. |
| **Quality engine** | Watches real throughput, not only ping. Can re-test, switch nodes, apply masking, rescan WARP or suggest a reconnect step. |
| **DPI tools** | Separate screen for DPI-related compatibility tools, strategy/list updates, driver cleanup and automatic VPN-node exclusions. |
| **Privacy** | No ads or bundled analytics, privacy-safe log defaults, encrypted WARP/backup state on Windows, runtime config cleanup. |
| **Desktop UX** | Tray menu, auto-update, session restore after update, themes, onboarding, 15 languages and RTL layout for فارسی / العربية. |

## Screenshots

| Nodes | Profiles |
|------|---------|
| ![Nodes](./docs/nodes.png) | ![Profiles](./docs/profiles.png) |
| **DPI tools** | **Settings** |
| ![DPI tools](./docs/dpi.png) | ![Settings](./docs/settings.png) |
| **Logs** | **Channel quality** |
| ![Logs](./docs/logs.png) | ![Channel quality](./docs/quality.png) |

## Supported protocols and transports

**Protocols:** VLESS · VMess · Trojan · Shadowsocks · Hysteria2 · TUIC · NaiveProxy · TrustTunnel · WARP/WireGuard

**Transports and options:** Reality · TLS with uTLS fingerprints · XHTTP · WebSocket · gRPC · HTTP/2 · TCP · TLS fragmentation · padding · mixed-case SNI · mux

NaiveProxy and TrustTunnel are served by their own clients over local SOCKS bridges. XHTTP is bridged through xray-core when needed. The user still sees a single source and a single connection state.

## Installation

Download the latest installer from [**Releases**](https://github.com/pathetixx/190x4-Ninety/releases):

- `.exe` — NSIS installer.
- `.msi` — MSI package.

Requirements: **Windows 10 / 11 x64**.

Updates are delivered inside the app. When the VPN is already connected, update checks and downloads can go through the active tunnel.

## Quick start

1. Open Ninety and press **+**.
2. Paste a subscription URL or a standalone config link (`vless://`, `vmess://`, `trojan://`, `hysteria2://`, `tuic://`, `naive+https://`, `tt://`, etc.).
3. Choose a mode:
   - **System proxy** — default, no administrator rights, good for browsers and many desktop apps.
   - **Proxy** — local SOCKS/HTTP on `127.0.0.1`; configure apps manually.
   - **VPN · TUN** — routes system traffic through the tunnel and requires elevation.
4. Click the central disc to connect. Click again to disconnect.

If something fails, open **Logs** first. The log screen is built for debugging startup, bridge and routing problems without digging through app folders.

## Security and privacy notes

Ninety is open source, but it still manages powerful networking components. Please read this before using it on a sensitive system.

- Imported profile and subscription data may contain credentials. Treat exports and logs carefully.
- Runtime engine configs are created on demand and cleaned up after disconnect; stale runtime configs are purged on startup.
- WARP keys and state backups are encrypted with Windows DPAPI where supported by the app backend.
- The default engine log level is `warn` to avoid writing visited domains to disk during normal use.
- External IP/geo lookups can be disabled in settings.
- Subscription refreshes keep a privacy-safe default: direct fallback is opt-in.
- The core control API listens on loopback.
- TUN mode, DPI tools and kill switch touch system networking. Review the settings before enabling them.

For vulnerability reports, see [SECURITY.md](./SECURITY.md).

## Architecture

```text
Tauri WebView UI
        │
        │ invoke / events
        ▼
Rust backend
        │
        ├─ sing-box process
        ├─ xray bridge for XHTTP
        ├─ NaiveProxy sidecar
        ├─ TrustTunnel sidecar
        ├─ WARP / WireGuard state
        ├─ Windows system proxy
        ├─ TUN / elevation / autostart
        ├─ WFP kill switch
        └─ updater, logs, backup and cleanup
```

- **Frontend:** vanilla HTML/CSS/JavaScript, no framework and no bundler.
- **Desktop shell:** Tauri 2 + WebView2.
- **Backend:** Rust commands for process control, Windows integration, encrypted local secrets, logs and cleanup.
- **Config builder:** JavaScript modules assemble sing-box/xray/sidecar configs for the active source, mode and options.
- **CI:** GitHub Actions builds the Windows release and injects the external engines that are not stored in this repository.

## Build from source

Requirements:

- Rust stable.
- Node.js 18 or newer.
- MSVC build tools.
- Windows environment for full Tauri builds.

```powershell
npm install
npm run tauri dev
npm run tauri build
```

The engines (`sing-box`, `xray-core`, NaiveProxy, TrustTunnel) and `wintun.dll` are pulled during CI. See [`.github/workflows/build.yml`](./.github/workflows/build.yml).

For regular development checks:

```powershell
npm run lint
npm test
```

Heavy Rust/Tauri checks are expected to run in the Windows CI pipeline unless you are on a properly prepared local Windows machine.

## Repository map

```text
src/                  Frontend: screens, styles, i18n, config builder
src-tauri/src/        Rust backend commands and Windows integration
src-tauri/dpi/        DPI strategies, lists and bundled runtime resources
docs/                 Screenshots and project images
tests/                JavaScript unit tests
.github/workflows/    Build, checks and release automation
```

## Contributing

Bug reports, reproducible test cases, docs fixes and careful pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.

When reporting connection bugs, never paste private subscription URLs, access tokens, UUIDs, private keys or full exported configs into a public issue.

## Support the project

Ninety is developed on enthusiasm. If it is useful to you, you can support the work:

**TON**

```text
UQC21op6_5Qgsw0i7TQvh12XBex9I5bqmPeMNuJ20INdjtg7
```

**USDT · TRC20**

```text
TGbdvr1gSYgQciFNRjwdmAmCbNLjK9wgJR
```

Thank you 🖤

## License

[MIT](./LICENSE)
