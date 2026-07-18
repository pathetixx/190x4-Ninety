// Ninety · бэкап/восстановление localStorage через writable config dir.
//
// localStorage живёт в профиле WebView2 (каталог EBWebView): его сносят
// чистилки диска, антивирусы и переустановка системы — юзер молча теряет
// профили/подписки/настройки. Держим шифрованный снапшот
// восстанавливаемых ninety.*-ключей рядом с конфигами
// (Rust: state_backup_save/load, файл state-backup.json) и на старте
// восстанавливаем, если хранилище пусто.

import { STORAGE_KEYS, shouldBackupStorageKey, shouldRestoreStorageKey } from "/lib/storage-policy.js";

// Маркеры «хранилище живое»: есть хоть один — восстановление не нужно.
const CORE_KEYS = ["ninety.options.v1", "ninety.profiles.v1", "ninety.subscriptions.v1"];
const BACKUP_SCHEMA_VERSION = 2;

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

function snapshot({ includeUpdateResume = false } = {}) {
  const out = { __schemaVersion: BACKUP_SCHEMA_VERSION, __createdAt: Date.now() };
  let storedKeys = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Маркер возврата сессии нужен только в снимке, который делаем прямо перед
    // OTA. В обычном бэкапе он не должен переживать произвольный перезапуск.
    if (!shouldBackupStorageKey(k) && !(includeUpdateResume && k === STORAGE_KEYS.updateResume)) continue;
    const v = localStorage.getItem(k);
    if (v != null) {
      out[k] = v;
      storedKeys++;
    }
  }
  // Дефолтные CORE-ключи нужны только чтобы частичный, но реальный storage дал
  // валидный snapshot. Полностью пустое хранилище не должно перетирать полезный
  // дисковый backup искусственными {}, [], [].
  if (storedKeys === 0) return null;
  if (out["ninety.options.v1"] == null) out["ninety.options.v1"] = "{}";
  if (out["ninety.profiles.v1"] == null) out["ninety.profiles.v1"] = "[]";
  if (out["ninety.subscriptions.v1"] == null) out["ninety.subscriptions.v1"] = "[]";
  return out;
}

let backupInFlight = Promise.resolve();

export function backupNow({ includeUpdateResume = false, strict = false } = {}) {
  // Каждая заявка получает собственный Promise: OTA не начнёт установку, пока
  // именно её снимок не записан после возможного обычного бэкапа в очереди.
  backupInFlight = backupInFlight.catch(() => {}).then(async () => {
    // Resume-журнал — durable lock, который переживает relaunch. Пока он жив,
    // debounce/periodic backup не имеет права перезаписать OTA-снимок версией
    // без ninety.update.resume. RuntimeReady удаляет журнал перед обычным backup.
    if (!includeUpdateResume) {
      try {
        if (localStorage.getItem(STORAGE_KEYS.updateResume) != null) return;
      } catch {}
    }
    const snap = snapshot({ includeUpdateResume });
    // Пустое хранилище не пишем — не перетираем полезный бэкап пустотой.
    if (!snap) return;
    try {
      await invoke("state_backup_save", { json: JSON.stringify(snap) });
    } catch (e) {
      console.warn("state backup failed", e);
      // Фоновые снимки остаются best-effort, но OTA обязан остановиться до
      // shutdown/install: иначе UI обещает восстановление состояния, которого
      // фактически нет на диске.
      if (strict) throw e;
    }
  });
  return backupInFlight;
}

// Перед OTA сохраняем единый снимок профиля и флага возврата сессии. Сам флаг
// одноразовый: main.js удалит его сразу после следующего успешного старта.
export function backupForUpdate() {
  return backupNow({ includeUpdateResume: true, strict: true });
}

let backupTimer = null;
// Дебаунс после мутаций (профили/подписки/настройки) — серия правок подряд
// даёт одну запись на диск, а не по записи на каждый чих.
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

// true → ключи восстановлены; вызывающий делает location.reload(), чтобы все
// модули перечитали localStorage с нуля (тема/язык/опции читаются при загрузке).
export async function restoreIfEmpty() {
  if (storageIsCompleteAndValid()) return false;
  // Гвард от вечного цикла: снапшот с ninety.*-ключами, но без единого CORE_KEY
  // (например, только тема) давал restore → reload → хранилище «всё ещё пусто» →
  // restore → reload… sessionStorage переживает reload, но не перезапуск аппы —
  // второй заход в рамках одной загрузки не делаем.
  const ATTEMPT_KEY = "ninety.restore.attempted";
  try { if (sessionStorage.getItem(ATTEMPT_KEY) === "1") return false; } catch {}
  let raw;
  try { raw = await invoke("state_backup_load"); } catch { return false; }
  if (!raw) return false;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  const snap = unwrapSnapshotEnvelope(parsed);
  if (!validateSnapshot(snap)) return false;
  const entries = Object.entries(snap).filter(([k, v]) =>
    !k.startsWith("__")
    && (shouldRestoreStorageKey(k) || k === STORAGE_KEYS.updateResume)
    && typeof v === "string");
  if (!entries.length) return false;

  // Web Storage не даёт transaction API: staging делаем в памяти, затем
  // проверяем каждую запись; при любом исключении возвращаем исходный набор.
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
    // update.resume бывает только в снимке, созданном непосредственно перед
    // OTA; без него при потерянном WebView2 восстановится профиль, но не сама
    // активная сессия.
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

function storageIsCompleteAndValid() {
  const snap = Object.fromEntries(CORE_KEYS.map(k => [k, localStorage.getItem(k)]));
  snap["ninety.active.kind"] = localStorage.getItem("ninety.active.kind") || "single";
  snap["ninety.profiles.active"] = localStorage.getItem("ninety.profiles.active");
  snap["ninety.subscriptions.active"] = localStorage.getItem("ninety.subscriptions.active");
  return validateSnapshot(snap);
}
