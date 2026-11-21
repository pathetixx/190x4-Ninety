// Ninety · live protected storage for profiles and subscriptions.
//
// Before the migration, legacy keys are read as a fallback. After a successful commit in
// Rust they're removed from the WebView localStorage; the recovery backup gets a copy
// via state-backup.js and is still encrypted by the backend policy.

import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const STORE_SCHEMA_VERSION = 1;
// The same limit as MAX_STORE_BYTES in profile_store.rs (checked by a test): refusing
// in advance with a clear error is cheaper than sending a big snapshot through IPC.
export const PROFILE_STORE_MAX_BYTES = 32 * 1024 * 1024;
const PROFILE_KEYS = [
  STORAGE_KEYS.profiles,
  STORAGE_KEYS.profileActive,
  STORAGE_KEYS.subscriptions,
  STORAGE_KEYS.subscriptionActive,
  STORAGE_KEYS.activeKind,
  STORAGE_KEYS.proxySelection,
];

function storageOrNull(storage = globalThis.localStorage) {
  try { return storage || null; } catch { return null; }
}

function clone(value) {
  try { return structuredClone(value); } catch {}
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function defaultStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: 0,
    profiles: [],
    subscriptions: [],
    active: {
      kind: "single",
      profileId: null,
      subscriptionId: null,
    },
    proxySelection: {},
  };
}

function validId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !Array.from(value).some(char => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter(item => item && typeof item === "object" && !Array.isArray(item) && validId(item.id))
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map(clone);
}

function normalizeProxySelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, tag]) =>
    validId(key) && typeof tag === "string" && validId(tag),
  ));
}

function normalizeStore(value, revision = 0) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const profiles = normalizeItems(source.profiles);
  const subscriptions = normalizeItems(source.subscriptions);
  const activeSource = source.active && typeof source.active === "object"
    ? source.active
    : {};
  const kind = activeSource.kind === "sub" ? "sub" : "single";
  const profileId = validId(activeSource.profileId)
    && profiles.some(item => item.id === activeSource.profileId)
    ? activeSource.profileId
    : null;
  const subscriptionId = validId(activeSource.subscriptionId)
    && subscriptions.some(item => item.id === activeSource.subscriptionId)
    ? activeSource.subscriptionId
    : null;
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: Number.isSafeInteger(Number(revision)) && Number(revision) >= 0
      ? Number(revision)
      : 0,
    profiles,
    subscriptions,
    active: { kind, profileId, subscriptionId },
    proxySelection: normalizeProxySelection(source.proxySelection),
  };
}

function readJson(storage, key, fallback) {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch { return fallback; }
}

function readLegacy(storage = storageOrNull(), { preserveDangling = false } = {}) {
  const profiles = normalizeItems(readJson(storage, STORAGE_KEYS.profiles, []));
  const subscriptions = normalizeItems(readJson(storage, STORAGE_KEYS.subscriptions, []));
  const proxySelection = normalizeProxySelection(readJson(storage, STORAGE_KEYS.proxySelection, {}));
  let profileId = null;
  let subscriptionId = null;
  let kind = "single";
  try {
    const rawProfile = storage?.getItem(STORAGE_KEYS.profileActive);
    const rawSubscription = storage?.getItem(STORAGE_KEYS.subscriptionActive);
    const rawKind = storage?.getItem(STORAGE_KEYS.activeKind);
    if (validId(rawProfile) && profiles.some(item => item.id === rawProfile)) profileId = rawProfile;
    if (validId(rawSubscription) && subscriptions.some(item => item.id === rawSubscription)) subscriptionId = rawSubscription;
    kind = rawKind === "sub" ? "sub" : "single";
  } catch {}
  const hasData = PROFILE_KEYS.some(key => {
    try { return storage?.getItem(key) != null; } catch { return false; }
  });
  const store = normalizeStore({
    profiles,
    subscriptions,
    active: { kind, profileId, subscriptionId },
    proxySelection,
  });
  // The old facade allowed remembering a source even if its record had already been
  // deleted. Until the migration starts we keep this behavior for compatibility;
  // on the actual Rust commit normalizeStore clears dangling references.
  if (preserveDangling) {
    try {
      const rawProfile = storage?.getItem(STORAGE_KEYS.profileActive);
      const rawSubscription = storage?.getItem(STORAGE_KEYS.subscriptionActive);
      if (validId(rawProfile)) store.active.profileId = rawProfile;
      if (validId(rawSubscription)) store.active.subscriptionId = rawSubscription;
    } catch {}
  }
  return {
    hasData,
    store,
  };
}

let storageRef = storageOrNull();
let invokeRef = localizedInvoke(globalThis.window?.__TAURI__?.core?.invoke) ?? null;
let state = readLegacy(storageRef, { preserveDangling: true }).store;
let revision = 0;
let initialized = false;
// A mutation that arrived before the Rust storage responded (deep link/auto-import at startup).
// Such a record exists only in memory: the legacy mirror is removed by
// removeLegacySensitiveKeys(), and the backend snapshot doesn't contain it.
let pendingLocalMutation = false;
let backendEnabled = typeof invokeRef === "function";
// The protected storage WAS available but dropped off (read or migration).
// This differs from the regular legacy mode (browser preview, tests — there the backend
// never existed at all): in degradation mirroring the state into localStorage
// is not allowed, otherwise node credentials that went into the encrypted store would again
// end up on disk in plain text. See docs/PROFILE_STORE_MIGRATION.md:
// «A Rust write failure must not update the legacy mirror».
let backendDegraded = false;
let persistedStore = false;
// The last write to Rust failed: memory holds unsaved changes.
// { code: "too_large" | "write", bytes?, limit? }; null after a successful write.
let writeFailure = null;
let initPromise = null;
let writeChain = Promise.resolve();
// How many "Clear" operations are in flight right now. A write queued during this time carries
// the state from before the clear and, if it ran after it, would bring the deleted
// subscriptions (with URLs and tokens) back to disk.
let clearsInFlight = 0;

function emit(name, detail = {}) {
  try {
    if (typeof globalThis.CustomEvent !== "function" || typeof globalThis.dispatchEvent !== "function") return;
    globalThis.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {}
}

function removeLegacySensitiveKeys(storage = storageRef) {
  const removed = [];
  for (const key of PROFILE_KEYS) {
    try {
      if (storage?.getItem(key) != null) {
        storage.removeItem(key);
        removed.push(key);
      }
    } catch {}
  }
  return removed;
}

function mirrorLegacyState(storage = storageRef) {
  if (!storage) return;
  const values = {
    [STORAGE_KEYS.profiles]: JSON.stringify(state.profiles),
    [STORAGE_KEYS.subscriptions]: JSON.stringify(state.subscriptions),
    [STORAGE_KEYS.activeKind]: state.active.kind,
    [STORAGE_KEYS.proxySelection]: JSON.stringify(state.proxySelection),
  };
  if (state.active.profileId) values[STORAGE_KEYS.profileActive] = state.active.profileId;
  if (state.active.subscriptionId) values[STORAGE_KEYS.subscriptionActive] = state.active.subscriptionId;
  for (const key of PROFILE_KEYS) {
    try {
      if (values[key] == null) {
        if (typeof storage.removeItem === "function") storage.removeItem(key);
      } else {
        storage.setItem(key, values[key]);
      }
    } catch {}
  }
}

function syncLegacyBeforeReady() {
  if (initialized) return;
  const currentStorage = storageOrNull();
  if (currentStorage && currentStorage !== storageRef) storageRef = currentStorage;
  // Tests and the browser preview can replace or mutate the Web Storage object
  // before the Rust bridge is ready.  Re-read it on every legacy-fallback call
  // so a cleared storage cannot be mistaken for the previous in-memory state.
  if (storageRef) state = readLegacy(storageRef, { preserveDangling: true }).store;
}

function storePayload() {
  return clone({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision,
    profiles: state.profiles,
    subscriptions: state.subscriptions,
    active: state.active,
    proxySelection: state.proxySelection,
  });
}

function checkRevision(value) {
  const next = Number(value);
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("profile store returned invalid revision");
  return next;
}

function encodedBytes(value) {
  const json = JSON.stringify(value);
  return typeof TextEncoder === "function" ? new TextEncoder().encode(json).length : json.length;
}

function tooLargeError(bytes) {
  const error = new Error(`profile store is too large: ${bytes} bytes, limit ${PROFILE_STORE_MAX_BYTES}`);
  error.code = "too_large";
  error.bytes = bytes;
  error.limit = PROFILE_STORE_MAX_BYTES;
  return error;
}

function describeWriteError(error) {
  if (error?.code === "too_large") {
    return { code: "too_large", bytes: error.bytes, limit: error.limit };
  }
  // Rust is the final arbiter: its size refusal (a string from
  // profile_store.rs) must also roll back and be explained as too_large.
  const text = String(error?.message ?? error ?? "");
  if (text.includes("profile store exceeds") || text.includes("profile store is too large")) {
    return { code: "too_large", limit: PROFILE_STORE_MAX_BYTES };
  }
  return { code: "write" };
}

async function replaceBackend(payload, expectedRevision) {
  if (!backendEnabled || typeof invokeRef !== "function") return { revision: expectedRevision, persisted: false };
  const store = { ...clone(payload), revision: expectedRevision };
  // Rust serializes the already next revision: we measure with it so the boundary doesn't
  // diverge by an extra digit.
  const bytes = encodedBytes({ ...store, revision: expectedRevision + 1 });
  if (bytes > PROFILE_STORE_MAX_BYTES) {
    // The request doesn't reach the backend, so we write the cause to the file log ourselves:
    // without it the refusal can't be figured out from a submitted log.
    Promise.resolve()
      .then(() => invokeRef("record_frontend_runtime_event", {
        phase: "profile_store_write",
        result: "failed",
        reason: "too_large",
      }))
      .catch(() => {});
    throw tooLargeError(bytes);
  }
  // Tauri command argument keys are camelCase (the macro converts the Rust parameter name
  // to lowerCamelCase). snake_case wasn't found here, the command answered
  // "missing required key expectedRevision", and the protected store was never
  // written: the app silently ran on legacy localStorage.
  const response = await invokeRef("profile_store_replace", {
    expectedRevision,
    store,
  });
  const nextRevision = checkRevision(response?.revision);
  revision = nextRevision;
  state.revision = nextRevision;
  persistedStore = true;
  removeLegacySensitiveKeys();
  return { revision: nextRevision, persisted: true };
}

// quietTooLarge — the caller will explain the size refusal itself (the add window);
// other write refusals are still reported with the shared notification.
function enqueuePersist({ notify = true, quietTooLarge = false } = {}) {
  if (clearsInFlight > 0) return Promise.resolve({ revision, persisted: false, superseded: true });
  const payload = storePayload();
  const task = writeChain
    .catch(() => {})
    .then(() => replaceBackend(payload, revision));
  writeChain = task.then(
    () => { writeFailure = null; },
    error => {
      writeFailure = describeWriteError(error);
      console.warn("profile store write failed:", error?.message || error);
      if (notify && !(quietTooLarge && writeFailure.code === "too_large")) {
        emit("ninety:profile-store-error", { stage: "write", ...writeFailure });
      }
      return null;
    },
  );
  return task;
}

// The write result for the calling code; it's never rejected so that
// an unused promise doesn't turn into an unhandledrejection.
function settledPersist(options) {
  return enqueuePersist(options).then(
    result => result,
    error => ({ persisted: false, error: describeWriteError(error) }),
  );
}

// Merging the storage snapshot with local records made before it loaded.
// The backend is the base, local items are appended by id; the active source
// is taken from local if it still exists after the merge.
function mergeStoreStates(backendState, localState, revision) {
  const mergeById = (base, local) => {
    const known = new Set(base.map(item => item.id));
    return base.concat(local.filter(item => item && !known.has(item.id)));
  };
  return normalizeStore({
    profiles: mergeById(backendState.profiles, localState.profiles || []),
    subscriptions: mergeById(backendState.subscriptions, localState.subscriptions || []),
    active: {
      kind: localState.active?.kind || backendState.active.kind,
      profileId: localState.active?.profileId || backendState.active.profileId,
      subscriptionId: localState.active?.subscriptionId || backendState.active.subscriptionId,
    },
    proxySelection: { ...backendState.proxySelection, ...(localState.proxySelection || {}) },
  }, revision);
}

function publish(next, { quietTooLarge = false } = {}) {
  state = normalizeStore(next, revision);
  if (!initialized && next?.active && typeof next.active === "object") {
    if (validId(next.active.profileId)) state.active.profileId = next.active.profileId;
    if (validId(next.active.subscriptionId)) state.active.subscriptionId = next.active.subscriptionId;
  }
  let result = Promise.resolve({ persisted: false });
  if (initialized && backendEnabled) result = settledPersist({ quietTooLarge });
  else {
    if (!initialized) pendingLocalMutation = true;
    // In degradation mutations stay in memory only: an open copy of secrets
    // on disk is a worse outcome than losing changes until a restart.
    if (!backendDegraded) mirrorLegacyState();
  }
  emit("ninety:profile-store-changed", { revision });
  return result;
}

export function profileStoreIsReady() {
  return initialized;
}

export function profileStoreIsPersisted() {
  return persistedStore;
}

// The protected storage was available and failed: changes live only in
// memory and will disappear on restart. The UI must tell the user —
// a silently working app looks healthy until the profiles disappear.
export function profileStoreIsDegraded() {
  return backendDegraded;
}

// Whether a native storage exists at all (desktop), regardless of its readiness.
// On desktop profile keys never return to WebView storage.
export function profileStoreHasBackend() {
  return typeof invokeRef === "function";
}

// Why the last write failed (null — everything is saved).
export function profileStoreWriteFailure() {
  return writeFailure ? { ...writeFailure } : null;
}

export async function initializeProfileStore({ invoke = null, storage = null } = {}) {
  if (initPromise) return initPromise;
  if (typeof invoke === "function") invokeRef = invoke;
  if (storage) storageRef = storageOrNull(storage);
  backendEnabled = typeof invokeRef === "function";
  initPromise = (async () => {
    const legacy = readLegacy(storageRef);
    state = legacy.store;
    if (!backendEnabled) {
      initialized = true;
      pendingLocalMutation = false;
      emit("ninety:profile-store-ready", { source: "legacy", persisted: false, revision });
      return { source: "legacy", persisted: false, revision };
    }

    let loaded;
    try {
      loaded = await invokeRef("profile_store_load");
    } catch {
      backendEnabled = false;
      backendDegraded = true;
      initialized = true;
      emit("ninety:profile-store-error", { stage: "load" });
      emit("ninety:profile-store-ready", { source: "legacy-fallback", persisted: false, revision });
      return { source: "legacy-fallback", persisted: false, revision };
    }

    if (loaded?.store) {
      revision = checkRevision(loaded.revision);
      const backendState = normalizeStore(loaded.store, revision);
      // A profile added before the storage responded isn't in the backend snapshot.
      // Previously it was simply overwritten, and removeLegacySensitiveKeys() also deleted
      // the localStorage mirror — the record vanished without a trace.
      const merged = pendingLocalMutation
        ? mergeStoreStates(backendState, state, revision)
        : backendState;
      state = merged;
      persistedStore = true;
      initialized = true;
      removeLegacySensitiveKeys();
      if (pendingLocalMutation) {
        pendingLocalMutation = false;
        enqueuePersist({ notify: false });
      }
      emit("ninety:profile-store-ready", {
        source: loaded.recoveredFromBackup ? "backup" : "rust",
        persisted: true,
        revision,
      });
      return { source: "rust", persisted: true, revision };
    }

    // One complete migration transaction.  localStorage is retained if the
    // Rust write fails, so a transient IPC/permission error cannot destroy the
    // only usable copy of a user's profiles.
    revision = 0;
    persistedStore = false;
    // A profile added before the storage responded exists only in memory: without
    // merging it was lost, and the next write deleted its mirror too.
    const legacyState = normalizeStore(legacy.store, revision);
    const hadLocalMutation = pendingLocalMutation;
    state = hadLocalMutation ? mergeStoreStates(legacyState, state, revision) : legacyState;
    pendingLocalMutation = false;
    initialized = true;
    if (legacy.hasData || hadLocalMutation) {
      try {
        await replaceBackend(storePayload(), 0);
        emit("ninety:profile-store-ready", { source: "migrated", persisted: true, revision });
        return { source: "migrated", persisted: true, revision };
      } catch {
        backendEnabled = false;
        backendDegraded = true;
        emit("ninety:profile-store-error", { stage: "migration" });
        emit("ninety:profile-store-ready", { source: "legacy-fallback", persisted: false, revision });
        return { source: "legacy-fallback", persisted: false, revision };
      }
    }
    emit("ninety:profile-store-ready", { source: "empty", persisted: false, revision });
    return { source: "empty", persisted: false, revision };
  })();
  return initPromise;
}

// Readers are called hundreds and thousands of times in one server list render
// (the latency history is taken for every row), and a deep copy of a subscription with
// three hundred nodes costs milliseconds — on a big subscription this produced seconds
// of interface freeze. We make the copy once per state version: publish()
// and bootstrap always set a NEW state object, so comparison by reference is
// an exact sign of a stale cache.
//
// Snapshot elements are shared between calls. Mutating them in place is not allowed (it
// wouldn't have been saved before either: writing goes only through save*ToStore), so
// calling code replaces records entirely — the array is returned as a copy so that
// push/filter/splice on the result stay safe.
let readCache = null;

function readSnapshot() {
  if (!readCache || readCache.state !== state) {
    readCache = {
      state,
      profiles: clone(state.profiles),
      subscriptions: clone(state.subscriptions),
    };
  }
  return readCache;
}

export function loadProfilesFromStore() {
  syncLegacyBeforeReady();
  return readSnapshot().profiles.slice();
}

export function saveProfilesToStore(list) {
  syncLegacyBeforeReady();
  publish({ ...state, profiles: list });
}

export function getActiveProfileIdFromStore() {
  syncLegacyBeforeReady();
  return state.active.profileId;
}

export function setActiveProfileIdInStore(id) {
  syncLegacyBeforeReady();
  publish({
    ...state,
    active: { ...state.active, profileId: validId(id) ? id : null },
  });
}

export function loadSubscriptionsFromStore() {
  syncLegacyBeforeReady();
  return readSnapshot().subscriptions.slice();
}

// Returns a promise with the write result ({ persisted, error? }); waiting for
// it isn't required.
export function saveSubscriptionsToStore(list, options) {
  syncLegacyBeforeReady();
  return publish({ ...state, subscriptions: list }, options);
}

export function getActiveSubscriptionIdFromStore() {
  syncLegacyBeforeReady();
  return state.active.subscriptionId;
}

export function setActiveSubscriptionIdInStore(id) {
  syncLegacyBeforeReady();
  publish({
    ...state,
    active: { ...state.active, subscriptionId: validId(id) ? id : null },
  });
}

export function getActiveKindFromStore() {
  syncLegacyBeforeReady();
  return state.active.kind === "sub" ? "sub" : "single";
}

export function setActiveKindInStore(kind) {
  syncLegacyBeforeReady();
  publish({ ...state, active: { ...state.active, kind: kind === "sub" ? "sub" : "single" } });
}

export function getProxySelectionFromStore() {
  syncLegacyBeforeReady();
  return clone(state.proxySelection);
}

export function saveProxySelectionToStore(selections) {
  syncLegacyBeforeReady();
  publish({ ...state, proxySelection: selections });
}

// state-backup.js uses these strings as its legacy-compatible snapshot fields.
// The live source of truth remains the in-memory Rust-backed state.
export function profileStoreBackupEntries() {
  syncLegacyBeforeReady();
  const entries = {
    [STORAGE_KEYS.profiles]: JSON.stringify(state.profiles),
    [STORAGE_KEYS.subscriptions]: JSON.stringify(state.subscriptions),
    [STORAGE_KEYS.activeKind]: state.active.kind,
    [STORAGE_KEYS.proxySelection]: JSON.stringify(state.proxySelection),
  };
  if (state.active.profileId) entries[STORAGE_KEYS.profileActive] = state.active.profileId;
  if (state.active.subscriptionId) entries[STORAGE_KEYS.subscriptionActive] = state.active.subscriptionId;
  return entries;
}

export async function restoreProfileStoreFromBackup(snapshot) {
  // The storage can't be read: the restore would live only in memory, and the success
  // would be false. We leave the data on disk and honestly report the error.
  if (backendDegraded) {
    emit("ninety:profile-store-error", { stage: "restore" });
    return false;
  }
  const profiles = readJsonValue(snapshot?.[STORAGE_KEYS.profiles], []);
  const subscriptions = readJsonValue(snapshot?.[STORAGE_KEYS.subscriptions], []);
  const proxySelection = readJsonValue(snapshot?.[STORAGE_KEYS.proxySelection], {});
  if (!Array.isArray(profiles) || !Array.isArray(subscriptions)) return false;
  const next = normalizeStore({
    profiles,
    subscriptions,
    active: {
      kind: snapshot?.[STORAGE_KEYS.activeKind],
      profileId: snapshot?.[STORAGE_KEYS.profileActive],
      subscriptionId: snapshot?.[STORAGE_KEYS.subscriptionActive],
    },
    proxySelection,
  }, revision);
  const previous = state;
  state = next;
  try {
    const result = await enqueuePersist({ notify: false });
    if (!backendEnabled && !backendDegraded) mirrorLegacyState();
    if (backendEnabled && !result?.persisted) throw new Error("profile store restore was not persisted");
    emit("ninety:profile-store-changed", { revision });
    return true;
  } catch {
    state = previous;
    emit("ninety:profile-store-error", { stage: "restore" });
    return false;
  }
}

function readJsonValue(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function clearProfileStore() {
  clearsInFlight++;
  const task = writeChain
    .catch(() => {})
    .then(async () => {
      // Only the native backend confirms deletion — in degradation too.
      // Rust deletes files without reading (expectedRevision: null), and previously this
      // call was skipped: "Clear" reported success while the files stayed.
      if (typeof invokeRef === "function") {
        await invokeRef("profile_store_clear", { expectedRevision: null });
        if (backendDegraded) {
          backendDegraded = false;
          backendEnabled = true;
          writeFailure = null;
        }
      }
      state = defaultStore();
      revision = 0;
      persistedStore = false;
      removeLegacySensitiveKeys();
      emit("ninety:profile-store-changed", { revision: 0 });
    });
  writeChain = task.catch(() => {});
  try {
    await task;
  } finally {
    clearsInFlight--;
  }
}
