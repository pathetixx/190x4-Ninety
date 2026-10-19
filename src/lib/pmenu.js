// Всплывающее меню действий (.pmenu): положение у кнопки «⋯» или у курсора,
// и правила, когда WebView2 должен показать своё меню вместо нашего.
// Меню страницы WebView2 (Назад, Обновить, Сохранить как, Печать) для
// приложения бесполезно и опасно: «Обновить» перезапускает интерфейс посреди
// живого подключения. Поэтому оно остаётся только там, где нужно
// копирование и вставка, — в полях ввода и на выделенном тексте.

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])";
const EDGE = 8;
const MARGIN = 12;

/**
 * Координаты меню: под якорем (или от точки курсора), с переворотом вверх у
 * нижнего края и прижатием к правому краю окна.
 * @param {{top:number,bottom:number,left:number}} anchor прямоугольник якоря; у точки top === bottom
 * @param {{width:number,height:number}} size размер меню
 * @param {{width:number,height:number}} viewport размер окна
 * @param {number} gap отступ от якоря
 */
export function placeMenu(anchor, size, viewport, gap = 6) {
  let top = anchor.bottom + gap;
  let left = anchor.left;
  if (top + size.height > viewport.height - MARGIN) top = anchor.top - size.height - gap;
  if (left + size.width > viewport.width - MARGIN) left = viewport.width - size.width - MARGIN;
  return { top: Math.max(EDGE, top), left: Math.max(EDGE, left) };
}

/** Правый клик здесь должен открыть меню WebView2 (копировать/вставить). */
export function wantsNativeContextMenu(target, selection) {
  if (target?.closest?.(EDITABLE)) return true;
  return Boolean(selection && !selection.isCollapsed && String(selection).trim());
}

/** Клавиша открытия контекстного меню с клавиатуры: Menu или Shift+F10. */
export function isContextMenuKey(e) {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

/**
 * Сочетания, которыми WebView2 перезагружает страницу, уходит по истории или
 * открывает печать. В приложении у них нет смысла, а перезагрузка сбрасывает
 * интерфейс при живом подключении.
 */
export function isPageNavigationShortcut(e) {
  const key = e.key;
  if (key === "BrowserRefresh" || key === "BrowserBack" || key === "BrowserForward") return true;
  if (key === "F5") return true;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.altKey && (e.code === "KeyR" || e.code === "KeyP")) return true;
  if (e.altKey && !ctrl && (key === "ArrowLeft" || key === "ArrowRight")) return true;
  return false;
}

/** Боковые кнопки мыши «Назад»/«Вперёд». */
export function isHistoryMouseButton(e) {
  return e.button === 3 || e.button === 4;
}

/**
 * Глобальная защита документа: своё меню вместо меню страницы, без
 * перезагрузки и переходов по истории.
 * @param {Document} doc
 */
export function installPageGuards(doc) {
  const win = doc.defaultView;
  doc.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    if (wantsNativeContextMenu(e.target, win?.getSelection?.())) return;
    e.preventDefault();
  });
  doc.addEventListener("keydown", (e) => {
    if (isPageNavigationShortcut(e)) e.preventDefault();
  }, true);
  for (const type of ["mouseup", "auxclick"]) {
    doc.addEventListener(type, (e) => {
      if (isHistoryMouseButton(e)) e.preventDefault();
    }, true);
  }
}

/**
 * Перемещение фокуса по пунктам меню стрелками, Home и End.
 * @returns {number|null} индекс следующего пункта или null, если клавиша не наша
 */
export function nextMenuIndex(key, current, count) {
  if (count <= 0) return null;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
