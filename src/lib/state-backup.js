// Ninety · бэкап/восстановление localStorage через app_config_dir.
//
// localStorage живёт в профиле WebView2 (каталог EBWebView): его сносят
// чистилки диска, антивирусы и переустановка системы — юзер молча теряет
// профили/подписки/настройки. Держим снапшот всех ninety.*-ключей рядом с
// конфигами (Rust: state_backup_save/load, файл state-backup.json) и на
// старте восстанавливаем, если хранилище пусто.

const PREFIX = "ninety.";
// Маркеры «хранилище живое»: есть хоть один — восстановление не нужно.
const CORE_KEYS = ["ninety.options.v1", "ninety.profiles.v1", "ninety.subscriptions.v1"];

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

function snapshot() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) out[k] = localStorage.getItem(k);
  }
  return out;
}

export async function backupNow() {
  const snap = snapshot();
  // Пустое хранилище не пишем — не перетираем полезный бэкап пустотой
  // (например, если бэкап-тик сработал до восстановления).
  if (!Object.keys(snap).length) return;
  try { await invoke("state_backup_save", { json: JSON.stringify(snap) }); }
  catch (e) { console.warn("state backup failed", e); }
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
  let raw = null;
  try { raw = await invoke("state_backup_load"); } catch { return false; }
  if (!raw) return false;
  let snap;
  try { snap = JSON.parse(raw); } catch { return false; }
  let restored = 0;
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith(PREFIX) || typeof v !== "string") continue; // чужие ключи не тащим
    try { localStorage.setItem(k, v); restored++; } catch {}
  }
  return restored > 0;
}
