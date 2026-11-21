// Ninety · backup/restore of the UI state and the Rust-owned profile store via
// writable config dir.
//
// localStorage lives in the WebView2 profile (the EBWebView directory): it gets wiped by
// disk cleaners, antiviruses and OS reinstalls — the user silently loses
// settings. Profiles/subscriptions are taken from the Rust-owned store. We keep an encrypted snapshot
// of the restorable ninety.* keys next to the configs
// (Rust: state_backup_save/load, the state-backup.json file) and at startup
// restore it if the storage is empty.

import { STORAGE_KEYS, shouldBackupStorageKey, shouldRestoreStorageKey } from "/lib/storage-policy.js";
import {
  profileStoreBackupEntries,
  profileStoreIsDegraded,
  profileStoreIsPersisted,
  restoreProfileStoreFromBackup,
} from "/lib/profile-store.js";
import { localizedInvoke } from "/lib/backend-errors.js";

// "Storage is alive" markers: if there's at least one, no restore is needed.
const CORE_KEYS = ["ninety.options.v1", "ninety.profiles.v1", "ninety.subscriptions.v1"];
const BACKUP_SCHEMA_VERSION = 2;

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

function snapshot({ includeUpdateResume = false } = {}) {
  const out = { __schemaVersion: BACKUP_SCHEMA_VERSION, __createdAt: Date.now() };
  let storedKeys = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // The session resume marker is needed only in the snapshot taken right before
    // OTA. In a regular backup it must not survive an arbitrary restart.
    if (!shouldBackupStorageKey(k) && !(includeUpdateResume && k === STORAGE_KEYS.updateResume)) continue;
    const v = localStorage.getItem(k);
    if (v != null) {
      out[k] = v;
      storedKeys++;
    }
  }
  // Profiles now live in the Rust-owned store. In the recovery backup we keep the
  // same compatible set of string fields, but take it from memory rather than from
  // WebView localStorage.
  const profileEntries = profileStoreBackupEntries();
  let profileData = false;
  try {
    profileData = JSON.parse(profileEntries[STORAGE_KEYS.profiles] || "[]").length > 0
      || JSON.parse(profileEntries[STORAGE_KEYS.subscriptions] || "[]").length > 0
      || !!profileEntries[STORAGE_KEYS.profileActive]
      || !!profileEntries[STORAGE_KEYS.subscriptionActive]
      || Object.keys(JSON.parse(profileEntries[STORAGE_KEYS.proxySelection] || "{}")).length > 0;
  } catch {}
  if (profileData || storedKeys > 0) {
    for (const [key, value] of Object.entries(profileEntries)) {
      if (out[key] == null) out[key] = value;
    }
    if (profileData) storedKeys += Object.keys(profileEntries).length;
  }
  // The default CORE keys are needed only so that a partial but real storage yields
  // a valid snapshot. A completely empty storage must not overwrite a useful
  // disk backup with artificial {}, [], [].
  if (storedKeys === 0) return null;
  if (out["ninety.options.v1"] == null) out["ninety.options.v1"] = "{}";
  if (out["ninety.profiles.v1"] == null) out["ninety.profiles.v1"] = "[]";
  if (out["ninety.subscriptions.v1"] == null) out["ninety.subscriptions.v1"] = "[]";
  return out;
}

let backupInFlight = Promise.resolve();
// How many failures in a row we count as "the safety net is dead". One failure can be
// transient (the file is locked by an antivirus), three in a row is already a state.
const BACKUP_FAILURE_ALERT_AT = 3;
let consecutiveFailures = 0;

function emitBackupEvent(name, detail) {
  try {
    if (typeof globalThis.CustomEvent !== "function" || typeof globalThis.dispatchEvent !== "function") return;
    globalThis.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {}
}
// The journal value is remembered both in the old process after the strict OTA save and in
// the new process on module import. This lets us recognize the transition
// "resume existed → RuntimeReady deleted it" without changes in main.js.
let pendingResumeValue = (() => {
  try { return localStorage.getItem(STORAGE_KEYS.updateResume); }
  catch { return null; }
})();

function restorePendingResume() {
  if (pendingResumeValue == null) return;
  try { localStorage.setItem(STORAGE_KEYS.updateResume, pendingResumeValue); } catch {}
}

export function backupNow({ includeUpdateResume = false, strict = false } = {}) {
  // Each request gets its own Promise: OTA won't start the installation until
  // exactly its snapshot is written after a possible regular backup in the queue.
  backupInFlight = backupInFlight.catch(() => {}).then(async () => {
    // The resume journal is a durable lock that survives a relaunch. While it lives,
    // debounce/periodic backup has no right to overwrite the OTA snapshot with a version
    // without ninety.update.resume. RuntimeReady deletes the journal before a regular backup.
    let closingResume = false;
    if (!includeUpdateResume) {
      try {
        const current = localStorage.getItem(STORAGE_KEYS.updateResume);
        if (current != null) {
          pendingResumeValue = current;
          return;
        }
      } catch {}
      // The journal existed in this OTA session but has now been deleted by RuntimeReady:
      // the next write must strictly record its absence on disk.
      closingResume = pendingResumeValue != null;
    }
    // The profile storage failed: memory holds incomplete data, and the cause may
    // go away on its own. A snapshot would overwrite the working copy and within two writes push out
    // .bak, so we skip it. For OTA and closing the journal this is a failure.
    if (profileStoreIsDegraded()) {
      if (strict || closingResume) {
        if (closingResume) restorePendingResume();
        throw new Error("profile store is degraded; state backup skipped");
      }
      return;
    }
    const snap = snapshot({ includeUpdateResume });
    // We don't write an empty storage — we don't overwrite a useful backup with emptiness. But when
    // closing the OTA journal this isn't a success: the old resume on disk would stay alive.
    if (!snap) {
      if (closingResume) {
        restorePendingResume();
        throw new Error("cannot close OTA resume journal with empty state");
      }
      return;
    }
    try {
      await invoke("state_backup_save", { json: JSON.stringify(snap) });
      consecutiveFailures = 0;
      if (includeUpdateResume) {
        pendingResumeValue = snap[STORAGE_KEYS.updateResume] ?? pendingResumeValue;
      } else if (closingResume) {
        pendingResumeValue = null;
      }
    } catch (e) {
      if (closingResume) restorePendingResume();
      console.warn("state backup failed", e);
      // A safety net that silently doesn't work is worse than none: a series of failures
      // means that when the WebView2 profile is lost there will be nothing to restore.
      // One event per series — the listener decides itself how to tell the user.
      consecutiveFailures += 1;
      if (consecutiveFailures === BACKUP_FAILURE_ALERT_AT) {
        emitBackupEvent("ninety:state-backup-error", {
          failures: consecutiveFailures,
          reason: String(e?.message || e),
        });
      }
      // Background snapshots stay best-effort, but OTA must stop before
      // shutdown/install. Closing the resume journal is strict too: otherwise the old
      // marker would stay on disk and come back to life on a future WebView2 loss.
      if (strict || closingResume) throw e;
    }
  });
  return backupInFlight;
}

// Before OTA we save a single snapshot of the profile and the session resume flag. The flag itself
// is one-time: main.js deletes it right after the next successful start.
export function backupForUpdate() {
  return backupNow({ includeUpdateResume: true, strict: true });
}

let backupTimer = null;
// Debounce after mutations (profiles/subscriptions/settings) — a series of edits in a row
// produces one write to disk, not a write for every sneeze.
export function backupSoon(delayMs = 5000) {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { backupTimer = null; backupNow(); }, delayMs);
}

export function unwrapSnapshotEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  if (!Object.prototype.hasOwnProperty.call(parsed, "keys")) return parsed;
  const keys = parsed.keys;
  return keys && typeof keys === "object" && !Array.isArray(keys) ? keys : null;
}

// true → the keys were restored; the caller does location.reload() so that all
// modules reread localStorage from scratch (theme/language/options are read on load).
export async function restoreIfEmpty() {
  const integrity = storageIntegrity();
  if (integrity.profiles && integrity.settings) return false;
  // A guard against an endless loop: a snapshot with ninety.* keys but without a single CORE_KEY
  // (e.g. only the theme) produced restore → reload → storage "still empty" →
  // restore → reload… sessionStorage survives a reload but not an app restart —
  // we don't make a second attempt within one load.
  const ATTEMPT_KEY = "ninety.restore.attempted";
  try { if (sessionStorage.getItem(ATTEMPT_KEY) === "1") return false; } catch {}
  let raw;
  try { raw = await invoke("state_backup_load"); } catch { return false; }
  if (!raw) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  const snap = unwrapSnapshotEnvelope(parsed);
  if (!validateSnapshot(snap)) return false;
  const profileKeys = new Set(Object.keys(profileStoreBackupEntries()));
  // The profiles are intact — they must not be touched: the backup may be older than the live store.
  // Then we restore only the settings we came here for.
  const profileRestored = integrity.profiles
    ? true
    : await restoreProfileStoreFromBackup(snap);
  const entries = Object.entries(snap).filter(([k, v]) =>
    !k.startsWith("__")
    && (shouldRestoreStorageKey(k) || k === STORAGE_KEYS.updateResume)
    // If the Rust store accepted the snapshot, its profile fields have
    // already been restored and must not be copied back into WebView storage.
    // If IPC failed, keep the legacy fallback path alive instead of dropping
    // the only recoverable copy of profiles/subscriptions. A degraded store is
    // different: its data stays on disk, and copying credentials into WebView
    // storage as plain text would only look like a restore.
    && (!profileKeys.has(k) || (!profileRestored && !profileStoreIsDegraded()))
    && typeof v === "string");
  if (!entries.length) return false;

  // Web Storage has no transaction API: we stage in memory, then
  // check every write; on any exception we restore the original set.
  const before = new Map(entries.map(([k]) => [k, localStorage.getItem(k)]));
  try {
    for (const [k, v] of entries) localStorage.setItem(k, v);
    for (const [k, v] of entries) {
      if (localStorage.getItem(k) !== v) throw new Error(`restore verify failed: ${k}`);
    }
  } catch {
    for (const [k, v] of before) {
      try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {}
    }
    return false;
  }
  let restored = 0;
  for (const [k, v] of entries) {
    // update.resume exists only in a snapshot created right before
    // OTA; without it, with a lost WebView2, the profile is restored but not the
    // active session itself.
    if (localStorage.getItem(k) === v) restored++;
  }
  if (restored > 0) {
    try { sessionStorage.setItem(ATTEMPT_KEY, "1"); } catch {}
    return true;
  }
  return false;
}

function parseJsonKey(snap, key, expected) {
  if (typeof snap?.[key] !== "string") return null;
  try {
    const value = JSON.parse(snap[key]);
    return expected(value) ? value : null;
  } catch { return null; }
}

export function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return false;
  if (snap.__schemaVersion != null && snap.__schemaVersion !== BACKUP_SCHEMA_VERSION) return false;
  const profiles = parseJsonKey(snap, "ninety.profiles.v1", Array.isArray);
  const subs = parseJsonKey(snap, "ninety.subscriptions.v1", Array.isArray);
  const options = parseJsonKey(snap, "ninety.options.v1", v => !!v && typeof v === "object" && !Array.isArray(v));
  if (!profiles || !subs || !options) return false;
  const kind = snap["ninety.active.kind"] || "single";
  if (kind === "sub") {
    const active = snap["ninety.subscriptions.active"];
    if (active && !subs.some(s => s?.id === active)) return false;
  } else {
    const active = snap["ninety.profiles.active"];
    if (active && !profiles.some(p => p?.id === active)) return false;
  }
  return true;
}

// Profiles and settings get lost independently: profiles live in the Rust-owned store,
// settings only in the WebView2 localStorage. Clearing the WebView profile (a disk
// cleaner, an antivirus, a reinstall) leaves the profiles untouched, and the shared
// "storage is intact" check declared the state complete: the connection mode,
// strict tunnel, Kill Switch, routing, DPI and theme didn't come back, and
// autostart came up with default settings. So we answer the two
// questions separately.
export function storageIntegrity() {
  const snap = Object.fromEntries(CORE_KEYS.map(k => [k, localStorage.getItem(k)]));
  const liveProfileEntries = profileStoreBackupEntries();
  let hasLiveProfileData = false;
  try {
    hasLiveProfileData = JSON.parse(liveProfileEntries[STORAGE_KEYS.profiles] || "[]").length > 0
      || JSON.parse(liveProfileEntries[STORAGE_KEYS.subscriptions] || "[]").length > 0
      || !!liveProfileEntries[STORAGE_KEYS.profileActive]
      || !!liveProfileEntries[STORAGE_KEYS.subscriptionActive]
      || Object.keys(JSON.parse(liveProfileEntries[STORAGE_KEYS.proxySelection] || "{}")).length > 0;
  } catch {}
  const profiles = profileStoreIsPersisted() || hasLiveProfileData;
  // loadOptions() deliberately keeps defaults in memory and doesn't write a plaintext blob,
  // so the absence of the settings key by itself doesn't mean a loss yet — but
  // with live profiles that's exactly what it is: a working session always saves options.
  const settings = localStorage.getItem(STORAGE_KEYS.options) != null;
  if (!settings && profiles) snap[STORAGE_KEYS.options] = "{}";
  Object.assign(snap, liveProfileEntries);
  return { profiles: profiles && validateSnapshot(snap), settings };
}

