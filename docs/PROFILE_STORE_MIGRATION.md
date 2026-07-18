# Encrypted profile-store migration

## Status

Design contract for moving sensitive profiles and subscriptions out of WebView `localStorage` into a Rust-owned encrypted store. This document intentionally makes no runtime changes by itself.

## Problem

The live copies of the following values are currently readable from the WebView profile:

- `ninety.profiles.v1` — node URLs, UUIDs, passwords and protocol keys;
- `ninety.subscriptions.v1` — subscription URLs, imported nodes and credentials;
- active profile/subscription identifiers and remembered node selection.

The existing DPAPI backup protects recovery data on disk, but it does not protect the live `localStorage` copy from a future WebView XSS, injected frontend code or local inspection of the WebView profile.

## Goals

1. Installed Windows builds keep sensitive profile data in a Rust-owned DPAPI-sealed file.
2. The frontend keeps the current synchronous-looking domain API where practical, but persistence becomes asynchronous at explicit mutation boundaries.
3. Existing users migrate without losing profiles, active source or selected node.
4. A failed migration leaves the old `localStorage` state usable.
5. Rollback to the previous app version remains possible until the new store has survived a confirmed runtime start.
6. Portable mode remains explicitly portable and is not silently tied to one Windows account.

## Non-goals

- Do not move theme, language, window state or non-sensitive UI preferences in the first PR.
- Do not redesign the profile/subscription schema while changing storage.
- Do not remove the existing encrypted recovery backup in the same release.
- Do not combine this migration with the `main.js` connection-lifecycle refactor.

## Store layout

Installed build:

```text
<app_config_dir>/profile-store.v1
```

Portable build:

```text
NinetyData/config/profile-store.v1
```

Suggested plaintext envelope before sealing:

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "createdAt": "2026-07-18T00:00:00Z",
  "updatedAt": "2026-07-18T00:00:00Z",
  "profiles": [],
  "subscriptions": [],
  "active": {
    "kind": "single",
    "profileId": null,
    "subscriptionId": null
  },
  "proxySelection": {}
}
```

Requirements:

- writes use the existing atomic-file strategy (`new`/`bak`/replace);
- installed Windows data is sealed with the existing user-scope DPAPI helper;
- the loader validates the complete envelope before returning it;
- corrupt primary data falls back to a validated `.bak`;
- `revision` increases on every successful mutation and supports stale-write detection;
- error messages must never contain URLs, UUIDs, passwords, keys or full serialized payloads.

## Portable-mode decision

Portable mode currently keeps the WebView profile and WARP state portable. DPAPI would break that contract after moving the folder to another PC.

The first implementation must choose one explicit behaviour and expose it in UI/documentation:

1. **Compatibility-first:** portable profile-store remains plaintext and `NinetyData` is documented as sensitive; or
2. **Passphrase mode:** derive an encryption key from a user passphrase with a memory-hard KDF and store only salt/parameters.

Do not silently use DPAPI in Full Portable mode.

## Rust API contract

Prefer domain-level commands instead of exposing arbitrary file access:

```text
profile_store_status() -> { exists, schemaVersion, revision, portableProtection }
profile_store_load() -> ProfileStoreEnvelope
profile_store_replace(expectedRevision, envelope) -> { revision }
profile_store_clear(expectedRevision?) -> { removed }
profile_store_migrate_legacy(payload, migrationId) -> MigrationResult
profile_store_confirm_migration(migrationId, runtimeIdentity) -> ConfirmResult
```

Rules:

- `profile_store_replace` rejects a stale `expectedRevision`;
- all writes validate IDs, active references and collection shape before touching disk;
- maximum serialized size is bounded;
- duplicate IDs are rejected;
- `clear` removes primary, backup, temporary and migration-journal files;
- commands return structured error codes in addition to user-safe messages.

## Two-phase migration

### Phase 0 — capability detection

Frontend checks `profile_store_status`. Old application versions continue using `localStorage` unchanged.

### Phase 1 — prepare

When no confirmed Rust store exists:

1. read the legacy keys without deleting them;
2. validate them with the same active-reference rules used by backup restore;
3. send one complete migration payload to Rust;
4. Rust atomically writes the sealed store and a migration journal;
5. Rust reads the file back, unseals it and verifies an exact normalized round trip;
6. frontend loads the store through the normal Rust command and compares a non-secret digest.

At this point `localStorage` remains intact.

### Phase 2 — shadow operation

For at least one release, mutations are written to Rust first and mirrored to legacy `localStorage` only after Rust commit succeeds.

Read order:

1. confirmed Rust store;
2. prepared Rust store with valid migration journal;
3. legacy `localStorage`;
4. encrypted recovery backup.

A Rust write failure must not update the legacy mirror, active selection or UI state as if persistence succeeded.

### Phase 3 — runtime confirmation

Migration is confirmed only after:

- the selected source can be loaded from the Rust store;
- config building succeeds;
- when autoconnect was requested, the runtime reaches a confirmed connected snapshot;
- the app records the running application version and store revision in the journal.

Only then may the frontend remove sensitive legacy keys.

### Phase 4 — legacy cleanup

Remove only the migrated sensitive keys:

- `ninety.profiles.v1`;
- `ninety.subscriptions.v1`;
- their active identifiers;
- active-kind marker;
- remembered proxy selection if moved into the store.

Do not call `localStorage.clear()`.

Keep a rollback export for one compatibility window. It must be generated from the confirmed Rust store and written only through the already encrypted backup path, not restored as a live localStorage copy during normal startup.

## Failure and rollback matrix

| Failure point | Required result |
| --- | --- |
| Legacy JSON invalid | Do not create a store; keep old app behaviour |
| DPAPI seal fails | Keep localStorage; show actionable error |
| Atomic write fails | Keep previous store and localStorage |
| Read-back validation fails | Delete unconfirmed new file; retain migration journal evidence |
| Frontend reload during prepare | Resume from journal; never start a second migration blindly |
| App crashes before runtime confirmation | Continue shadow mode on next launch |
| New store corrupt, `.bak` valid | Load validated `.bak`, report recovery state |
| Both store copies invalid | Fall back to legacy localStorage/recovery backup without overwriting either |
| Downgrade before confirmation | Old version still sees legacy keys |
| Downgrade after cleanup | Document minimum supported rollback version and provide explicit export path |

## Mutation semantics

Every profile/subscription mutation should become a transaction:

1. clone current in-memory domain state;
2. apply and validate the proposed mutation;
3. write with `expectedRevision`;
4. publish the new state to views only after commit;
5. schedule the existing recovery backup after commit.

Deletion of the active source must include active-source reassignment in the same store revision.

Subscription refresh must not replace the old node list until the fetched payload parses, normalizes and commits successfully.

## Logging and diagnostics

- log only operation, revision, counts and stable non-secret error codes;
- never log serialized profiles, subscription URLs or generated engine configs;
- diagnostics export should report protection mode and store health, not contents;
- migration journal contains IDs/digests only where possible.

## Test gates

### Rust unit tests

- seal/unseal round trip for the store envelope;
- primary corruption with valid `.bak` fallback;
- stale revision rejection;
- duplicate IDs and dangling active IDs rejected;
- maximum-size enforcement;
- atomic write rollback;
- clear removes all store artifacts;
- portable protection policy is explicit.

### Frontend tests

- first migration preserves profiles, active source and remembered node;
- no legacy deletion before runtime confirmation;
- Rust write failure leaves UI/domain state unchanged;
- restart resumes each migration-journal stage;
- downgrade window retains legacy data;
- subscription refresh commits atomically.

### Windows integration tests

- installed build can reopen DPAPI store under the same user;
- another Windows user cannot decrypt it;
- moving a Portable folder follows the documented portable policy;
- update/relaunch restores the same active source from the Rust store.

## Suggested PR sequence

1. Rust store implementation and tests, unused by production frontend.
2. Frontend adapter with read-only capability detection.
3. Two-phase prepare and shadow writes behind a feature flag.
4. Runtime confirmation and migration journal recovery.
5. Legacy sensitive-key cleanup after one compatibility release.
6. Remove shadow writes and narrow recovery backup scope.

Each PR must preserve existing exported frontend functions or provide a compatibility facade. No PR should simultaneously change the profile schema, config builder and connection lifecycle.
