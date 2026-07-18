# Safe module extraction plan

## Status

Implementation plan for reducing the size and coupling of `src/main.js`, `src/lib/singbox.js` and `src-tauri/src/dpi.rs` without mixing mechanical moves with behavioural changes.

## Why this needs staged work

These files are not merely large. They are orchestration boundaries that currently encode ordering guarantees across:

- WebView state and DOM lifecycle;
- VPN start/stop generations;
- system proxy ownership;
- updater shutdown and resume;
- DPI elevation, driver unload and node exclusion;
- protocol parsing and sing-box/xray/sidecar config generation.

A broad split can look clean while silently changing initialization order, event ownership or cancellation semantics. Each extraction PR must therefore be narrow, mechanically reviewable and protected by contract tests.

## Global rules

1. One extraction concern per PR.
2. Do not rename public exports in the same PR that moves them.
3. Do not change persisted keys, IPC command names or payload casing during extraction.
4. Do not combine file movement with feature changes or bug fixes.
5. Keep a compatibility facade at the old import path until all callers migrate.
6. Add characterization tests before moving code that lacks direct tests.
7. Every async controller must retain its cancellation/generation ownership.
8. Event listeners must have one documented owner and one cleanup path.
9. The final diff of a mechanical PR should be explainable as “same code, new boundary”.
10. If a discovered bug must be fixed, open a separate PR based on `main`.

## Dependency direction

Preferred frontend direction:

```text
views / DOM adapters
        ↓
application controllers
        ↓
domain state and pure builders
        ↓
Tauri IPC adapters / storage adapters
```

Forbidden directions:

- domain modules importing `main.js`;
- pure builders reading DOM or calling `invoke`;
- view modules mutating persisted state without a controller callback;
- infrastructure adapters importing view modules;
- circular imports hidden through global `window` aliases.

Preferred Rust direction:

```text
Tauri command adapters
        ↓
operation controllers
        ↓
pure validation/planning helpers
        ↓
OS / filesystem / process adapters
```

## `src/lib/singbox.js`

### Current responsibilities to separate

- profile storage facade;
- active source and mode state;
- protocol-to-outbound dispatch;
- TLS and transport builders;
- xray bridge construction;
- naive/TrustTunnel sidecar construction;
- inbound, DNS and route generation;
- WARP outbound integration;
- final config assembly and runtime hashing helpers.

### Phase S1 — storage facade

Extract profile and active-source persistence to:

```text
src/lib/profile-repository.js
```

Keep re-exports in `singbox.js` for:

- `loadProfiles`;
- `getActiveProfileId`;
- `setActiveProfileId`;
- `removeProfile`;
- `getMode` / `setMode`;
- active-kind helpers.

Characterization tests:

- malformed storage fallback;
- active ID removal;
- active kind switching;
- no change to key names or serialized shape.

This phase should be coordinated with the encrypted profile-store migration. Do not remove the facade until the new repository adapter is stable.

### Phase S2 — protocol outbound builders

Create:

```text
src/lib/config/outbounds.js
src/lib/config/tls.js
src/lib/config/transports.js
```

Move only pure functions. Inputs and outputs remain plain objects. No storage, translation, DOM or IPC access.

Contract fixtures should cover every supported protocol and meaningful transport combination, including xhttp extras and malformed optional fields.

### Phase S3 — bridge and sidecar builders

Create:

```text
src/lib/config/xray-bridge.js
src/lib/config/sidecars.js
src/lib/config/bridge-ports.js
```

Preserve:

- deterministic port assignment;
- tag naming;
- credentials escaping;
- duplicate-port rejection assumptions;
- exact Rust `SidecarSpec` wire shape.

### Phase S4 — routing and DNS

Create:

```text
src/lib/config/dns.js
src/lib/config/routes.js
src/lib/config/inbounds.js
```

Required snapshot tests:

- proxy/systemProxy/tun inbound differences;
- probe-in precedence;
- engine process bypass;
- split Discord behaviour;
- LAN bypass;
- WARP routing;
- direct DNS bootstrap path;
- ad-block rule-set ordering.

### Phase S5 — final assembler

`singbox.js` becomes a compatibility facade that coordinates the extracted pure builders. Only after all callers and tests are stable may it be renamed to a config-specific module.

## `src/main.js`

### Target boundaries

```text
src/app/bootstrap.js
src/app/network-controller.js
src/app/update-controller.js
src/app/subscription-controller.js
src/app/dpi-controller.js
src/app/settings-controller.js
src/app/runtime-reconcile.js
```

`main.js` should eventually contain only composition:

- construct controllers;
- pass DOM/view callbacks;
- register top-level application events;
- start bootstrap.

### Phase M0 — characterization harness

Before moving connection code, add tests around controller factories with injected dependencies:

- latest intent wins;
- connect cancelled during bridge settle stops the newly created runtime;
- stale runtime is shut down before a new start;
- system proxy is enabled only after core readiness;
- kill switch is part of readiness;
- failure returns UI to honest idle/cleanup_error;
- updater suppresses health recovery only during install ownership.

Avoid jsdom where a pure dependency-injected controller test is sufficient.

### Phase M1 — updater flow

Extract update scheduling and modal orchestration first because it already has defined callbacks and limited interaction points.

The controller receives:

- updater adapter;
- runtime stop/recovery callbacks;
- storage backup callback;
- notification/toast callbacks;
- foreground-state callback;
- clock/timer adapter.

Preserve:

- proxy-first check with direct fallback;
- retry schedule and stale checks;
- pending update in tray;
- single notification per version;
- update resume journal stages;
- fail-closed pre-install backup.

### Phase M2 — settings wiring

Move DOM event-to-option mapping without moving option storage itself. The view emits semantic events; the controller validates and calls `updateOption`.

Do not let settings modules call connection internals directly. They should request actions through injected callbacks or the existing bus.

### Phase M3 — subscription refresh

Extract:

- single refresh;
- refresh-all sequencing;
- proxy selection for fetches;
- active source mutation transaction;
- reconnect decision after successful commit.

Required invariant: a failed fetch/parse must not replace the previous usable subscription.

### Phase M4 — DPI actions

Move frontend DPI orchestration after subscription flow, but keep the Rust `dpi.rs` operation model unchanged.

Preserve:

- TUN pause/resume rules;
- elevation intent persistence;
- node exclusion before DPI start;
- update-time driver unload;
- autostart state reconciliation.

### Phase M5 — runtime reconciliation

Extract startup reconcile/autostart decisions before the interactive connect controller. Inputs should be snapshots and desired state; policy should be mostly pure.

Test matrix:

- no backend runtime;
- matching running runtime;
- mismatching source/mode/port;
- owned/unowned system proxy;
- expected kill switch missing;
- update resume with VPN/DPI combinations.

### Phase M6 — connection lifecycle

Move last. This is the highest-risk extraction.

The new controller owns:

- network intent epoch;
- connection attempt gate;
- runtime identity token;
- core start barrier;
- reconnect queue;
- connected/connecting/idle/cleanup_error transitions.

No other module may mutate connection state directly after this phase.

Explicit command order for connect remains:

1. inspect backend runtime snapshot;
2. reconcile or stop stale runtime;
3. claim connection attempt;
4. validate direct DNS;
5. load WARP state;
6. plan bridge ports;
7. build configs;
8. start Rust runtime;
9. adopt backend generation;
10. validate Clash topology;
11. restore remembered selection;
12. enable system proxy when requested;
13. arm kill switch when requested;
14. perform final runtime snapshot validation;
15. publish connected state.

Disconnect owns the reverse cleanup and must not report idle until Rust confirms process exit, port release and proxy restoration.

## `src-tauri/src/dpi.rs`

### Current responsibilities to separate

- operation generation and cancellation;
- child process lifecycle and logging;
- strategy parsing and argument substitution;
- list seeding and mode generation;
- node exclusion resolution;
- signed channel download and verification;
- archive validation/staging/commit;
- WinDivert service ownership and unload;
- autotest orchestration.

### Phase D1 — pure strategy model

Create:

```text
src-tauri/src/dpi/strategy.rs
```

Move:

- `Strategy` model;
- placeholder substitution;
- argument validation;
- path normalization helpers that do not touch OS state.

Use table-driven tests with representative strategy fixtures.

### Phase D2 — list repository

Create:

```text
src-tauri/src/dpi/lists.rs
```

Own:

- resource-to-writable seeding;
- ipset mode generation;
- user list operations;
- active VPN domain/IP exclusions;
- domain counts.

All writes should use the existing atomic helpers where replacement matters.

### Phase D3 — channel updater

Create:

```text
src-tauri/src/dpi/channel.rs
src-tauri/src/dpi/archive.rs
```

Preserve all current security boundaries:

- dedicated and transitional legacy minisign keys;
- compressed and unpacked size caps;
- entry count and per-entry caps;
- path traversal rejection;
- staging directory guard;
- validate-before-commit behaviour;
- key-rotation workflow checks.

This extraction must have malicious archive fixtures before movement.

### Phase D4 — process runtime

Create:

```text
src-tauri/src/dpi/runtime.rs
src-tauri/src/dpi/log.rs
```

The runtime owns the child handle, bounded termination, log cap and stray-process cleanup. It must not own strategy/download policy.

### Phase D5 — driver/service adapter

Create:

```text
src-tauri/src/dpi/driver.rs
```

Keep service ownership checks and absolute System32 paths. Never replace owned-service verification with global service-name shutdown.

### Phase D6 — operation controller

The remaining `dpi/mod.rs` owns generation, cancellation and Tauri command adaptation. Async operations retain the current operation guard semantics.

## Event and global ownership

Before each extraction, document all relevant events in a small table:

| Event/global | Producer | Consumer | Cleanup owner |
| --- | --- | --- | --- |
| `ninety:option-changed` | options repository | views/controllers | app lifetime |
| `ninety:node-changed` | proxies view | network presentation | view/controller |
| `ninety:dpi-changed` | DPI controller | tray/backup | app lifetime |
| `window.__ninetySetTheme` | theme adapter | external shell hooks | app lifetime |

New globals are forbidden. Existing globals should be removed only in dedicated compatibility PRs.

## Validation per PR

Every extraction PR must run:

```text
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Additional requirements:

- record before/after config fixture hashes for config-builder moves;
- record public exports before/after for facade moves;
- compare Tauri command names and serde casing;
- no generated installer or sidecar changes unless directly required;
- no persisted schema changes without a migration document.

## Review checklist

- Is this diff mechanical, or is behaviour changing too?
- Are initialization and listener-registration order unchanged?
- Does the moved code still have exactly one owner?
- Are cancellation epochs/tokens preserved across every await?
- Are cleanup functions still called on every early return?
- Does the old import path remain compatible?
- Were secrets kept out of logs and fixtures?
- Is the rollback path tested?
- Can this PR be reverted without data migration?

## Suggested merge order

1. Characterization tests and test helpers.
2. `singbox.js` pure helpers/builders.
3. updater controller.
4. settings controller.
5. subscription controller.
6. DPI frontend controller.
7. startup runtime reconciliation.
8. Rust DPI pure strategy/lists/channel modules.
9. Rust DPI runtime/driver modules.
10. connection lifecycle last.

Do not stack all phases into one long-lived branch. Each phase should branch from the then-current `main` so review and rollback remain independent.
