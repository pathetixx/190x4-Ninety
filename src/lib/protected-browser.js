// Ninety · безопасная JS-граница для отдельного защищённого браузера.
//
// Rust отвечает за поиск стабильного Mullvad Browser, безопасный запуск с
// обычными правами пользователя и открытие официальной страницы загрузки.
// Профили и настройки браузера Ninety не создаёт и не меняет. Здесь нет UI-логики:
// модуль нормализует IPC-ответы и никогда не отдаёт пользователю сырую ошибку
// ОС (она может содержать локальные пути и технические детали).

export const PROTECTED_BROWSER_COMMANDS = Object.freeze({
  status: "protected_browser_status",
  launch: "protected_browser_launch",
  openDownload: "protected_browser_open_download",
});

const MESSAGES = Object.freeze({
  tauriUnavailable: "Эта функция доступна только в приложении Ninety.",
  statusFailed: "Не удалось проверить защищённый браузер.",
  launchFailed: "Не удалось открыть защищённый браузер.",
  downloadFailed: "Не удалось открыть официальный сайт загрузки браузера.",
  invalidUrl: "Можно открыть только обычную ссылку HTTP или HTTPS.",
});

function success(action, data) {
  return Object.freeze({ ok: true, action, data: Object.freeze(data) });
}

function failure(action, code, message) {
  return Object.freeze({
    ok: false,
    action,
    error: Object.freeze({ code, message }),
  });
}

function browserInvoke() {
  const call = globalThis.window?.__TAURI__?.core?.invoke;
  return typeof call === "function" ? call : null;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return null;
  let printable = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint > 31 && codePoint !== 127) printable += char;
  }
  const text = printable.trim();
  return text ? text.slice(0, maxLength) : null;
}

// Браузер найден, но забракован проверкой. Причина нужна интерфейсу: «не
// найден» на установленном браузере — тупик, из которого пользователю некуда
// идти. Набор закрытый: чужие строки в UI не пропускаем.
const REJECTION_REASONS = new Set(["signature", "link", "layout"]);

export function normalizeProtectedBrowserStatus(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.available !== "boolean") {
    return null;
  }

  const available = raw.available;
  const reason = !available && REJECTION_REASONS.has(raw.reason) ? raw.reason : null;
  const path = available || reason ? cleanText(raw.path, 4096) : null;
  if (available && !path) return null;
  if (raw.version != null && typeof raw.version !== "string") return null;

  return {
    available,
    path,
    version: available ? cleanText(raw.version, 120) : null,
    reason,
  };
}

export function normalizeProtectedBrowserUrl(value) {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, value: null };

  const input = value.trim();
  // Синхронно с backend оставляем консервативную границу для IPC и запуска.
  if (!input || input.length > 768) return { ok: false, value: null };

  try {
    const parsed = new URL(input);
    if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, value: null };
    // Учётные данные в URL попали бы в аргументы процесса и историю браузера.
    if (parsed.username || parsed.password) return { ok: false, value: null };
    return { ok: true, value: parsed.href };
  } catch {
    return { ok: false, value: null };
  }
}

export function createProtectedBrowserService(deps = {}) {
  const injectedInvoke = typeof deps.invoke === "function" ? deps.invoke : null;
  const warn = typeof deps.warn === "function"
    ? deps.warn
    : ((message, error) => console.warn(message, error));

  function resolveInvoke() {
    return injectedInvoke || browserInvoke();
  }

  function unavailable(action) {
    return failure(action, "tauri_unavailable", MESSAGES.tauriUnavailable);
  }

  function report(action, error) {
    warn(`[protected-browser] ${action} failed`, error);
  }

  async function status() {
    const call = resolveInvoke();
    if (!call) return unavailable("status");
    try {
      const normalized = normalizeProtectedBrowserStatus(
        await call(PROTECTED_BROWSER_COMMANDS.status),
      );
      if (!normalized) {
        report("status", new Error("invalid protected browser status"));
        return failure("status", "invalid_response", MESSAGES.statusFailed);
      }
      return success("status", normalized);
    } catch (error) {
      report("status", error);
      return failure("status", "status_failed", MESSAGES.statusFailed);
    }
  }

  async function launch(options = {}) {
    if (options != null && (typeof options !== "object" || Array.isArray(options))) {
      return failure("launch", "invalid_url", MESSAGES.invalidUrl);
    }
    const url = options?.url;
    const normalizedUrl = normalizeProtectedBrowserUrl(url);
    if (!normalizedUrl.ok) {
      return failure("launch", "invalid_url", MESSAGES.invalidUrl);
    }

    const call = resolveInvoke();
    if (!call) return unavailable("launch");
    const args = normalizedUrl.value ? { url: normalizedUrl.value } : {};
    try {
      await call(PROTECTED_BROWSER_COMMANDS.launch, args);
      return success("launch", { launched: true });
    } catch (error) {
      report("launch", error);
      return failure("launch", "launch_failed", MESSAGES.launchFailed);
    }
  }

  async function openOfficialDownload() {
    const call = resolveInvoke();
    if (!call) return unavailable("open_download");
    try {
      await call(PROTECTED_BROWSER_COMMANDS.openDownload);
      return success("open_download", { opened: true });
    } catch (error) {
      report("open_download", error);
      return failure("open_download", "download_failed", MESSAGES.downloadFailed);
    }
  }

  return Object.freeze({ status, launch, openOfficialDownload });
}

const defaultService = createProtectedBrowserService();

export const getProtectedBrowserStatus = () => defaultService.status();
export const launchProtectedBrowser = (options) => defaultService.launch(options);
export const openProtectedBrowserDownload = () => defaultService.openOfficialDownload();
