// Ninety · единый HTML-эскейп для интерполяции untrusted-данных в innerHTML.
// Untrusted-источники: имена/хосты нод и подписок (сервер подписки / shared-ссылка),
// живые имена процессов и хосты соединений (ОС / clash-API). Экранирует и обе
// кавычки → безопасно и для текстового контента, и для атрибутов в двойных/одинарных
// кавычках. Консолидирует прежние локальные копии (proxies-view/main/edit-modal
// escapeHtml; dpi-view/routing-view esc — НЕ экранировали ' (латентный пробой
// одинарных атрибутов); settings-view escapeAttr — экранировал только "/< (неполно)).
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => MAP[c]);
}

// Атрибутный контекст покрывается тем же набором (обе кавычки экранированы).
export const escapeAttr = escapeHtml;
