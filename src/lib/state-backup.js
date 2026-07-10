// Ninety · бэкап/восстановление localStorage через app_config_dir.
//
// localStorage живёт в профиле WebView2 (каталог EBWebView): его сносят
// чистилки диска, антивирусы и переустановка системы — юзер молча теряет
// профили/подписки/настройки. Держим шифрованный снапшот
// восстанавливаемых ninety.*-ключей рядом с конфигами
// (Rust: state_backup_save/load, файл state-backup.json) и на старте
// восстанавливаем, если хранилище пусто.

import { shouldBackupStorageKey, shouldRestoreStorageKey } from "/lib/storage-policy.js";

// Маркеры «хранилище живое»: есть хоть один — восстановление не нужно.
const CORE_KEYS = ["ninety.options.v1", "ninety.profiles.v1", "ninety.subscriptions.v1"];

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

function snapshot() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!shouldBackupStorageKey(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) out[k] = v;
  }
  return out;
}

let backupInFlight = null;
let backupQueued = false;

export function backupNow() {
  if (backupInFlight) {
    backupQueued = true;
    return backupInFlight;
  }
  backupInFlight = (async () => {
    const snap = snapshot();
    // Пустое хранилище не пишем — не перетираем полезный бэкап пустотой.
    if (!Object.keys(snap).length) return;
    try { await invoke("state_backup_save", { json: JSON.stringify(snap) }); }
    catch (e) { console.warn("state backup failed", e); }
  })().finally(() => {
    backupInFlight = null;
    if (backupQueued) {
      backupQueued = false;
      backupNow();
    }
  });
  return backupInFlight;
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
  let raw = null;
  try { raw = await invoke("state_backup_load"); } catch { return false; }
  if (!raw) return false;
  let snap;
  try { snap = JSON.parse(raw); } catch { return false; }
  let restored = 0;
  for (const [k, v] of Object.entries(snap)) {
    if (!shouldRestoreStorageKey(k) || typeof v !== "string") continue; // чужие/ephemeral ключи не тащим
    try { localStorage.setItem(k, v); restored++; } catch {}
  }
  if (restored > 0) {
    try { sessionStorage.setItem(ATTEMPT_KEY, "1"); } catch {}
    return true;
  }
  return false;
}
