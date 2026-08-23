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

WireGuard and AmneziaWG profiles are emitted as sing-box endpoints rather than outbounds, keeping the same node tag: proxy groups reference an endpoint tag exactly as they reference an outbound. AmneziaWG shaping from the imported `.conf` (Jc/Jmin/Jmax, S1/S2, H1..H4, I1..I5) is carried in the endpoint's `noise.amnezia` block.

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

`connected` is a UI state. Whether the runtime is actually alive is decided from
facts the Rust backend reports, and the policy that acts on them lives in the
frontend watchdog (`src/lib/health-watchdog.js`). There is no autonomous native
recovery controller: Rust never restarts the runtime on its own.

What Rust provides:

- `health_snapshot` — one aggregated call per tick: whether sing-box is running,
  the xray and sidecar status, the last runtime error, whether the kill switch is
  armed, the current runtime operation, and a host-pressure sample;
- `verify_runtime_dataplane` — a bounded, generation-scoped check the frontend
  invokes at decision points. It confirms process liveness, sidecar liveness and
  that the local Clash control listener answers, then reports `Ready`,
  `HardFailed`, `Unverified`, `Cancelled` or `Stale`. `Unverified` is deliberately
  distinct from `HardFailed`: "we could not check" must never be treated as
  "it is broken";
- host-pressure classification, which the watchdog uses to pause remediation
  rather than to declare a failure.

What the frontend owns:

- classifying the snapshot and reacting to a dead core;
- one same-config restart budget per fifteen-minute window
  (`withFrontendRecovery` → `shutdownCore` → `restoreAfterCoreDeath`), so a
  runtime that dies repeatedly stops being restarted in a loop;
- keeping the WFP barrier while the core is down (`preserveKillSwitch`) and
  re-arming the kill switch when Windows Filtering Platform objects disappear;
- choosing a different node, which is a profile-aware decision and stays with the
  side that owns profile state.

Generation tokens tie the two halves together: every long operation captures the
current runtime generation and re-checks it after each await, so a late answer
from a previous runtime cannot be mistaken for the current one. Engine log
segments carry their generation as well — planned stops and late termination
events from older generations are recorded as `stopped`, and only an unexpected
exit of the current generation is surfaced as a runtime failure.

Strict privacy narrows this further: no external probe is made that could reveal
the user's address, so verification relies on native process, sidecar, local
Clash and host-pressure evidence only.

For the release ritual, see [RELEASING.md](../RELEASING.md).
