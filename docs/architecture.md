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
`probe-in`/mixed inbound, in addition to process liveness and the local Clash
control API. Liveness has its own fixed HTTPS policy (two independent
allowlisted endpoints, 16 KiB sample, 6 s total budget and 2.5 s inactivity
window); it never reuses the quality engine's 64 KiB/800 ms shaping thresholds.

The dataplane decision is a bounded rolling window of three observations:

```text
new generation → unknown
two successes in the window → healthy
two failures in the window → failed
otherwise → suspect
```

Therefore `F,S,F` is failed, while `S,S` is healthy. A stale monitor cannot
write a newer process generation. Host pressure is a separate hysteretic signal
based on physical/commit memory and scheduler heartbeat lateness. It changes
the polling interval and pauses quality remediation, but it never clears a
dataplane failure or authorizes mass node switching.

The native monitor has the following lifecycle states:

```text
inactive → unknown → suspect → healthy
                    └──────→ failed → recovering → unknown (new generation)
                                      ├──────────→ pressure_wait
                                      └──────────→ handoff → healthy (candidate switched)
                                                   └──→ terminal_cleanup → terminal
                                                          └──→ cleanup_error
```

Recovery is owned by one native controller. It retains the in-memory launch
specification, performs a controlled same-config dependency restart, verifies
processes, Clash, the real dataplane, system-proxy ownership and (when
required) the WFP barrier, then publishes a new generation. It does not ask
WebView2 to rebuild a profile during that restart or silently select a different
server. There is one same-config restart per fifteen-minute recovery window. If
the new generation still fails, the native owner publishes `handoff`; a
responsive WebView immediately validates up to three alternative nodes and can
fall back to one full lifecycle reconnect. The native owner keeps a sixty-second
fail-closed deadline, so a hung WebView cannot leave a black-hole runtime alive.
Terminal state is published only after fail-closed cleanup is confirmed. A
failed cleanup remains
`cleanup_error`, preserves the kill switch barrier and is retried only within a
bounded budget.

Strict privacy never silently disables health. It switches to explicit
`unmonitoredPrivacyMode`/`privacy_passive`: only native process, sidecar, local
Clash and host-pressure evidence is used, and no direct external probe is made
that could reveal the user's address. The bounded incident ring contains only
relative ages, generations, safe reason codes, scheduler/resource evidence and
recovery outcomes; it never stores URLs, IPs, credentials, subscription data or
traffic metadata.

The WebView watchdog remains a UI/guard observer until native recovery explicitly
publishes `handoff`; this makes one controller own every lifecycle phase while
still allowing the profile-aware frontend to choose a different node. A manual
disconnect or profile change invalidates an in-flight native start immediately,
then waits for the same owner lock before starting the requested runtime.
Candidate validation uses the fixed dataplane probe, preserves the original
selector and rolls back before full reconnect. Strict privacy keeps its
pinned-node policy and skips candidate switching. Native `healthy` transitions
also request one real quality probe so the channel indicator leaves
`Checking` promptly without treating liveness alone as a quality grade.

Every engine log segment includes its runtime generation. Planned stops and
late termination events from older generations are recorded as `stopped`; only
an unexpected exit of the current generation is recorded as `died` and exposed
as the runtime failure reason.

For the release ritual, see [RELEASING.md](../RELEASING.md).
