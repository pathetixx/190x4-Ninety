# Architecture

Ninety is a Tauri 2 desktop app with a vanilla JavaScript frontend and a Rust backend. The app builds runtime configs for sing-box and helper sidecars based on the selected source, mode and settings.

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

## Frontend

The frontend lives under `src/`. It uses vanilla HTML, CSS and JavaScript without a framework or bundler.

The UI owns screens, local presentation state, i18n, settings forms, import flows and client-side config-building helpers.

## Rust backend

The backend lives under `src-tauri/src/`. It exposes Tauri commands and events for Windows integration and runtime control.

The backend is responsible for:

- starting and stopping local engine processes;
- native dataplane health checks and host-pressure classification;
- Windows system proxy changes;
- TUN elevation and autostart behavior;
- WARP/WireGuard state;
- WFP kill switch controls;
- logs, backup, cleanup and update support.

## Config builder

JavaScript modules assemble runtime configs for the active source, mode and options.

The builder decides which inbounds, outbounds, DNS settings, routing rules and sidecar bridges are needed. The runtime config is generated for the current connection and should not be treated as a stable user-authored file.

## Sidecars

sing-box remains the central router. Some protocols or transports need helper sidecars:

- xray-core for XHTTP bridge behavior;
- NaiveProxy client for NaiveProxy nodes;
- TrustTunnel client for TrustTunnel endpoints.

Sidecars listen locally and are wired into sing-box through local bridge routes. The user still sees one source and one connection state.

## Updater

Ninety uses Tauri updater metadata from `latest.json` assets published with releases.

The OTA notes shown by the app come from the `notes` field in `latest.json`, which is generated during the tag build. The human-facing GitHub Release body can be polished for GitHub readers, but editing it after release does not rewrite an already published `latest.json`.

## CI and external engines

The repository does not store the full release engine binaries directly. GitHub Actions prepares them during the Windows release workflow.

This keeps the repository smaller and makes release inputs explicit in CI:

- build or download pinned engine versions;
- verify hashes where applicable;
- place binaries where Tauri expects sidecars;
- build and sign Windows artifacts;
- generate and publish `latest.json`.

## Runtime health and recovery

`connected` is a UI state, while the native runtime health is tracked separately.
The Rust backend monitors the actual proxy/TUN datapath through the local
`probe-in`/mixed inbound, in addition to process liveness. It reports bounded
states such as `unknown`, `healthy`, `suspect`, `pressure` and `failed`, with a
runtime generation and a non-sensitive reason code.

When the host is under CPU or memory pressure, Ninety pauses background quality
remediation instead of switching nodes blindly. A confirmed dataplane failure
uses a bounded recovery policy: validate an alternative node, switch to it when
the dataplane probe succeeds, or use the existing controlled runtime reconnect.
The frontend remains the recovery coordinator for now because it owns the
profile/config selection; a future Windows service can move that ownership out
of the WebView.

For the release ritual, see [RELEASING.md](../RELEASING.md).
