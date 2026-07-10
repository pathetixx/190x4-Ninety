// Ninety · бэкап/восстановление localStorage через app_config_dir.
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

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

function snapshot({ includeUpdateResume = false } = {}) {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Маркер возврата сессии нужен только в снимке, который делаем прямо перед
    // OTA. В обычном бэкапе он не должен переживать произвольный перезапуск.
    if (!shouldBackupStorageKey(k) && !(includeUpdateResume && k === STORAGE_KEYS.updateResume)) continue;
    const v = localStorage.getItem(k);
    if (v != null) out[k] = v;
  }
  return out;
}

let backupInFlight = Promise.resolve();

export function backupNow({ includeUpdateResume = false } = {}) {
  // Каждая заявка получает собственный Promise: OTA не начнёт установку, пока
  // именно её снимок не записан после возможного обычного бэкапа в очереди.
  backupInFlight = backupInFlight.catch(() => {}).then(async () => {
    const snap = snapshot({ includeUpdateResume });
    // Пустое хранилище не пишем — не перетираем полезный бэкап пустотой.
    if (!Object.keys(snap).length) return;
    try { await invoke("state_backup_save", { json: JSON.stringify(snap) }); }
    catch (e) { console.warn("state backup failed", e); }
  });
  return backupInFlight;
}

// Перед OTA сохраняем единый снимок профиля и флага возврата сессии. Сам флаг
// одноразовый: main.js удалит его сразу после следующего успешного старта.
export function backupForUpdate() {
  return backupNow({ includeUpdateResume: true });
}

let backupTimer = null;
// Дебаунс после мутаций (профили/подписки/настройки) — серия правок подряд
// даёт одну запись на диск, а не по записи на каждый чих.
export function backupSoon(delayMs = 5000) {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { backupTimer = null; backupNow(); }, delayMs);
}

// true → ключи восстановлены; вызывающий делает location.reload(), чтобы все
// модули перечитали localStorage с нуля (тема/язык/опции читаются при загрузке).
export async function restoreIfEmpty() {
  if (CORE_KEYS.some((k) => localStorage.getItem(k) != null)) return false;
  // Гвард от вечного цикла: снапшот с ninety.*-ключами, но без единого CORE_KEY
  // (например, только тема) давал restore → reload → хранилище «всё ещё пусто» →
  // restore → reload… sessionStorage переживает reload, но не перезапуск аппы —
  // второй заход в рамках одной загрузки не делаем.
  const ATTEMPT_KEY = "ninety.restore.attempted";
  try { if (sessionStorage.getItem(ATTEMPT_KEY) === "1") return false; } catch {}
  let raw;
  try { raw = await invoke("state_backup_load"); } catch { return false; }
  if (!raw) return false;
  let snap;
  try { snap = JSON.parse(raw); } catch { return false; }
  let restored = 0;
  for (const [k, v] of Object.entries(snap)) {
    // update.resume бывает только в снимке, созданном непосредственно перед
    // OTA; без него при потерянном WebView2 восстановится профиль, но не сама
    // активная сессия.
    if ((!shouldRestoreStorageKey(k) && k !== STORAGE_KEYS.updateResume) || typeof v !== "string") continue;
    try { localStorage.setItem(k, v); restored++; } catch {}
  }
  if (restored > 0) {
    try { sessionStorage.setItem(ATTEMPT_KEY, "1"); } catch {}
    return true;
  }
  return false;
}
