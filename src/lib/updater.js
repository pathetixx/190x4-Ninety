// Ninety · auto-updater wrapper
// Использует window.__TAURI__ (withGlobalTauri:true). Без bundle'инга npm пакета.

const t = () => window.__TAURI__;

function api() {
  const root = t();
  if (!root) return null;
  // В Tauri 2 с withGlobalTauri плагин-апи доступен как __TAURI__.updater
  const u = root.updater;
  const p = root.process;
  if (!u || !p) return null;
  return { updater: u, process: p };
}

export function isAvailable() {
  return !!api();
}

// checkForUpdate({ proxy, timeoutMs }).
// proxy ("http://127.0.0.1:PORT") — при поднятом VPN проверка идёт через свой
// локальный инбаунд: reqwest апдейтера не чтит системный прокси, а в TUN трафик
// Ninety.exe уходит в direct bypass-правилом, т.е. без прокси проверка ВСЕГДА
// «напрямую» — у части провайдеров эндпоинты так недоступны. Прокси из check()
// плагин запоминает в Update и скачивание идёт тем же клиентом (тоже в туннель).
export async function checkForUpdate({ proxy = null, timeoutMs = 30_000 } = {}) {
  const a = api();
  if (!a) return null;
  const opts = { timeout: timeoutMs };
  if (proxy) opts.proxy = proxy;
  // Ошибки (нет сети / заблокированный CDN ассетов) НЕ глотаем — пробрасываем
  // наверх, чтобы runUpdateCheck отличил «не смог проверить» от «обновлений нет».
  // Раньше оба случая возвращали null → апп врал «у вас актуальная версия».
  return a.updater.check(opts); // null = апдейта нет; {version, ...} = есть
}
