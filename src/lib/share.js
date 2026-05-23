// Ninety · «Поделиться» — копирование URL и экспорт sing-box JSON.

import { buildConfig, getMode } from "/lib/singbox.js";
import { loadOptions } from "/lib/options.js";

export async function copySubscriptionUrl(sub, toast) {
  if (!sub?.url) {
    toast?.("У подписки нет URL", "error", 1800);
    return;
  }
  try {
    await navigator.clipboard.writeText(sub.url);
    toast?.("URL скопирован", "success", 1400);
  } catch {
    toast?.("Не удалось скопировать", "error", 1800);
  }
}

export async function exportSingboxJson(source, toast) {
  if (!source) {
    toast?.("Нет активного источника", "error", 1800);
    return;
  }
  try {
    const config = buildConfig({
      source,
      mode: getMode(),
      options: loadOptions(),
    });
    const json = JSON.stringify(config, null, 2);
    await navigator.clipboard.writeText(json);
    toast?.(`sing-box config скопирован (${(json.length / 1024).toFixed(1)} КБ)`, "success", 2000);
  } catch (e) {
    toast?.(`Ошибка экспорта: ${e?.message || e}`, "error", 2500);
  }
}
