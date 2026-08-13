// Ninety · живое защищённое хранилище профилей и подписок.
//
// До миграции legacy-ключи читаются как fallback. После успешного commit в
// Rust они удаляются из WebView localStorage; recovery backup получает копию
// через state-backup.js и по-прежнему шифруется backend-политикой.

import { STORAGE_KEYS } from "/lib/storage-policy.js";

const STORE_SCHEMA_VERSION = 1;
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
  // Старый фасад позволял помнить источник, даже если его запись уже была
  // удалена. До старта миграции сохраняем это поведение для совместимости;
  // при фактическом Rust commit normalizeStore очистит dangling-ссылки.
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
let invokeRef = globalThis.window?.__TAURI__?.core?.invoke ?? null;
let state = readLegacy(storageRef, { preserveDangling: true }).store;
let revision = 0;
let initialized = false;
// Мутация, пришедшая до ответа Rust-хранилища (deep-link/автоимпорт на старте).
// Такая запись существует только в памяти: legacy-зеркало снимет
// removeLegacySensitiveKeys(), а backend-снимок её не содержит.
let pendingLocalMutation = false;
let backendEnabled = typeof invokeRef === "function";
let persistedStore = false;
let initPromise = null;
let writeChain = Promise.resolve();

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

function legacyHasData(storage = storageRef) {
  return readLegacy(storage).hasData;
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

async function replaceBackend(payload, expectedRevision) {
  if (!backendEnabled || typeof invokeRef !== "function") return { revision: expectedRevision, persisted: false };
  // Ключи аргументов Tauri-команд — camelCase (макрос переводит имя параметра
  // Rust в lowerCamelCase). snake_case здесь не находился, команда отвечала
  // «missing required key expectedRevision», и защищённый store не записывался
  // никогда: приложение молча работало на legacy-localStorage.
  const response = await invokeRef("profile_store_replace", {
    expectedRevision,
    store: { ...clone(payload), revision: expectedRevision },
  });
  const nextRevision = checkRevision(response?.revision);
  revision = nextRevision;
  state.revision = nextRevision;
  persistedStore = true;
  removeLegacySensitiveKeys();
  return { revision: nextRevision, persisted: true };
}

function enqueuePersist({ notify = true } = {}) {
  const payload = storePayload();
  const task = writeChain
    .catch(() => {})
    .then(() => replaceBackend(payload, revision));
  writeChain = task.catch(error => {
    if (notify) {
      emit("ninety:profile-store-error", { stage: "write" });
    }
    return null;
  });
  return task;
}

// Слияние снимка хранилища с локальными записями, сделанными до его загрузки.
// Backend — база, локальные элементы дописываются по id; активный источник
// берём локальный, если он ещё существует после слияния.
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

function publish(next) {
  state = normalizeStore(next, revision);
  if (!initialized && next?.active && typeof next.active === "object") {
    if (validId(next.active.profileId)) state.active.profileId = next.active.profileId;
    if (validId(next.active.subscriptionId)) state.active.subscriptionId = next.active.subscriptionId;
  }
  if (initialized && backendEnabled) enqueuePersist();
  else {
    if (!initialized) pendingLocalMutation = true;
    mirrorLegacyState();
  }
  emit("ninety:profile-store-changed", { revision });
}

export function hasLegacySensitiveData(storage = storageRef) {
  return legacyHasData(storage);
}

export function profileStoreIsReady() {
  return initialized;
}

export function profileStoreIsPersisted() {
  return persistedStore;
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
      initialized = true;
      emit("ninety:profile-store-error", { stage: "load" });
      emit("ninety:profile-store-ready", { source: "legacy-fallback", persisted: false, revision });
      return { source: "legacy-fallback", persisted: false, revision };
    }

    if (loaded?.store) {
      revision = checkRevision(loaded.revision);
      const backendState = normalizeStore(loaded.store, revision);
      // Профиль, добавленный до ответа хранилища, backend-снимок не содержит.
      // Раньше он просто затирался, а removeLegacySensitiveKeys() удалял и
      // зеркало в localStorage — запись исчезала бесследно.
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
    state = normalizeStore(legacy.store, revision);
    initialized = true;
    if (legacy.hasData) {
      try {
        await replaceBackend(storePayload(), 0);
        emit("ninety:profile-store-ready", { source: "migrated", persisted: true, revision });
        return { source: "migrated", persisted: true, revision };
      } catch {
        backendEnabled = false;
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

// Читатели вызываются десятками сотен раз за один рендер списка серверов
// (история задержки берётся на каждую строку), а глубокая копия подписки на
// триста нод стоит миллисекунды — на большой подписке это давало секунды
// заморозки интерфейса. Копию делаем один раз на версию состояния: publish()
// и bootstrap всегда ставят НОВЫЙ объект state, поэтому сравнение по ссылке —
// точный признак устаревшего кэша.
//
// Элементы snapshot'а общие между вызовами. Мутировать их на месте нельзя (это
// и раньше не сохранялось бы: запись идёт только через save*ToStore), поэтому
// вызывающий код заменяет записи целиком — массив отдаём копией, чтобы
// push/filter/splice над результатом оставались безопасными.
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

export function saveSubscriptionsToStore(list) {
  syncLegacyBeforeReady();
  publish({ ...state, subscriptions: list });
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
    if (!backendEnabled) mirrorLegacyState();
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
  const task = writeChain
    .catch(() => {})
    .then(async () => {
      if (backendEnabled && typeof invokeRef === "function") {
        await invokeRef("profile_store_clear", { expectedRevision: null });
      }
      state = defaultStore();
      revision = 0;
      persistedStore = false;
      removeLegacySensitiveKeys();
      emit("ninety:profile-store-changed", { revision: 0 });
    });
  writeChain = task.catch(() => {});
  await task;
}
