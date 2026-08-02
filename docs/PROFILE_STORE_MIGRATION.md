# Encrypted profile-store migration

## Status

Runtime implementation is now present: `profile-store.v1` is a Rust-owned,
validated envelope protected by the existing DPAPI/portable policy. The
frontend keeps a legacy fallback only until the first successful load/migration
commit; after that commit the profile/subscription keys are removed from WebView
`localStorage`. Windows runtime validation and the manual downgrade matrix still
belong to the release gate.

## Problem

Legacy versions and an intentionally failed Portable migration may leave the
following fallback copies readable from the WebView profile:

- `ninety.profiles.v1` — node URLs, UUIDs, passwords and protocol keys;
- `ninety.subscriptions.v1` — subscription URLs, imported nodes and credentials;
- active profile/subscription identifiers and remembered node selection.

The Rust-owned store and DPAPI/portable envelope protect the normal live copy;
the legacy fallback is retained only when migration cannot be committed.

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

Portable mode keeps the WebView profile and WARP state portable. DPAPI would break
that contract after moving the folder to another PC. The implemented storage
policy is explicit: new secret writes are disabled until the user sets an
in-memory passphrase; the passphrase envelope uses Argon2id and
XChaCha20-Poly1305.

The runtime exposes three explicit portable modes:

1. **NoPersistentSecrets:** the default; without another choice, new secret writes fail closed;
2. **PassphraseEncrypted:** derive an encryption key from a user passphrase with Argon2id and store only a versioned salt/nonce/encrypted envelope;
3. **PlaintextExplicitlyConfirmed:** an additional UI warning creates a versioned confirmation marker and permits plaintext writes for users who explicitly accept that risk.

Setting a passphrase removes the plaintext confirmation marker. Clearing the
portable protection removes both choices and returns to `NoPersistentSecrets`.
Legacy plaintext is readable for migration, but it never enables the third mode
by itself.

Do not silently use DPAPI in Full Portable mode.

Portable backup policy: every new backup is written through the crash-safe
same-directory temporary-file + fsync + replace helper. The previous snapshot is
kept as `.bak`; failed replacement restores the previous primary. Legacy primary
and `.bak` snapshots are validated independently and migrated only after a valid
read. If the passphrase is absent, encrypted portable data stays untouched and
the load fails closed instead of overwriting it. Crash dumps and diagnostics must
not include passphrases, plaintext snapshots, URLs, keys or serialized payloads.

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

At this point `localStorage` is removed only after Rust has accepted the complete
envelope and returned the committed revision. If IPC, validation, protection or
atomic write fails, the legacy keys remain intact and the frontend continues in
fallback mode.

### Phase 2 — shadow operation

After initialization, mutations update the in-memory domain state and are
serialized through a Rust write queue. They are not mirrored back to
`localStorage`; the encrypted recovery backup is the rollback copy.

Read order:

1. confirmed Rust store;
2. prepared Rust store with valid migration journal;
3. legacy `localStorage`;
4. encrypted recovery backup.

A Rust write failure must not update the legacy mirror, active selection or UI state as if persistence succeeded.

### Phase 3 — runtime confirmation

The current implementation waits for the profile-store initialization before
network bootstrap and removes legacy keys after a successful store
load/migration commit. A later release can add a separate connected-runtime
journal if the downgrade window requires it.

### Phase 4 — legacy cleanup

Remove only the migrated sensitive keys:

- `ninety.profiles.v1`;
- `ninety.subscriptions.v1`;
- their active identifiers;
- active-kind marker;
- remembered proxy selection if moved into the store.

Do not call `localStorage.clear()`.

Keep the recovery backup for the compatibility window. It is generated from the
Rust store and written only through the encrypted backup path, not restored as a
live localStorage copy when the Rust store is available.

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
