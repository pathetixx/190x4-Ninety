// Ninety · auto-updater wrapper
// Использует window.__TAURI__ (withGlobalTauri:true). Без bundle'инга npm пакета.

const t = () => window.__TAURI__;

function api() {
  const root = t();
  if (!root) return null;
  // В Tauri 2 с withGlobalTauri плагин-апи доступен как __TAURI__.updater
  const u = root.updater;
  const p = root.process;
  const d = root.dialog;
  if (!u || !p) return null;
  return { updater: u, process: p, dialog: d };
}

export function isAvailable() {
  return !!api();
}

export async function checkForUpdate() {
  const a = api();
  if (!a) return null;
  // Ошибки (нет сети / заблокированный CDN ассетов) НЕ глотаем — пробрасываем
  // наверх, чтобы runUpdateCheck отличил «не смог проверить» от «обновлений нет».
  // Раньше оба случая возвращали null → апп врал «у вас актуальная версия».
  return a.updater.check(); // null = апдейта нет; {version, ...} = есть
}

// askToUpdate(update, {onProgress, toast})
export async function askAndInstall(update, opts = {}) {
  const a = api();
  if (!a || !update) return false;
  const ask = a.dialog?.ask;
  const confirmText = `Доступно обновление ${update.version} (сейчас ${update.currentVersion}).\nУстановить?`;
  let yes = true;
  if (ask) {
    yes = await ask(confirmText, { title: "Ninety", kind: "info", okLabel: "Обновить", cancelLabel: "Позже" });
  }
  if (!yes) return false;

  let total = 0, downloaded = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data?.contentLength ?? 0;
      opts.onProgress?.({ phase: "started", total });
    } else if (event.event === "Progress") {
      downloaded += event.data?.chunkLength ?? 0;
      opts.onProgress?.({ phase: "progress", downloaded, total });
    } else if (event.event === "Finished") {
      opts.onProgress?.({ phase: "finished", total });
    }
  });

  try { await a.process.relaunch(); } catch (e) { console.warn("relaunch failed", e); }
  return true;
}
