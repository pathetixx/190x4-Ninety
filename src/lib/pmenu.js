// Всплывающее меню действий (.pmenu) — одно на всё приложение: у кнопки «⋯»,
// у курсора (правый клик) или у строки (клавиша Menu / Shift+F10), и правила,
// когда WebView2 должен показать своё меню вместо нашего.
// Меню страницы WebView2 (Назад, Обновить, Сохранить как, Печать) для
// приложения бесполезно и опасно: «Обновить» перезапускает интерфейс посреди
// живого подключения. Поэтому оно остаётся только там, где нужно
// копирование и вставка, — в полях ввода и на выделенном тексте.

import { escapeAttr, escapeHtml } from "/lib/esc.js";

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

// ── DOM ──────────────────────────────────────────────────────
// Одновременно открыто одно меню. Закрывается кликом или правым кликом мимо,
// Escape, Tab, ресайзом окна; фокус возвращается туда, откуда меню открыли.
let openMenu = null;
let openMenuReturnFocus = null;

export function closePMenu({ restoreFocus = false } = {}) {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("contextmenu", onDocClick, true);
  window.removeEventListener("resize", onWindowResize);
  document.removeEventListener("keydown", onDocKeydown);
  const back = openMenuReturnFocus;
  openMenuReturnFocus = null;
  if (restoreFocus && back?.isConnected) back.focus();
}

function onDocClick(e) {
  if (openMenu && !openMenu.contains(e.target)) closePMenu();
}
function onWindowResize() { closePMenu(); }
// Меню открыто мышью, фокус остался снаружи — Escape всё равно закрывает.
function onDocKeydown(e) {
  if (e.key === "Escape") closePMenu({ restoreFocus: true });
}
function onMenuKeydown(e) {
  const items = [...e.currentTarget.querySelectorAll("[data-act]")];
  const next = nextMenuIndex(e.key, items.indexOf(document.activeElement), items.length);
  if (next !== null) { e.preventDefault(); items[next].focus(); return; }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePMenu({ restoreFocus: true }); return; }
  if (e.key === "Tab") { e.preventDefault(); closePMenu({ restoreFocus: true }); }
}

function itemHtml(it) {
  // Пункт-состояние («Уже выбран») — не действие, нажать его нельзя.
  if (it.state) {
    return `<div class="pmenu__item pmenu__item--state" role="menuitem" aria-disabled="true">${it.icon || ""}<span>${escapeHtml(it.label)}</span></div>`;
  }
  return `<button class="pmenu__item${it.danger ? " pmenu__item--danger" : ""}" data-act="${escapeAttr(it.id)}" type="button" role="menuitem" tabindex="-1">${it.icon || ""}<span>${escapeHtml(it.label)}</span></button>`;
}

/**
 * Открыть меню. Выбор пункта приходит в onSelect(id) после закрытия меню.
 * @param {Element|{x:number,y:number}} anchor кнопка/строка или точка курсора
 * @param {Array<{id?:string,label:string,icon?:string,danger?:boolean,state?:boolean}>} items
 * @param {{onSelect?: (id:string)=>void, returnFocus?: Element|null, focusFirst?: boolean, align?: "start"|"end"}} [opts]
 */
export function openPMenu(anchor, items, { onSelect, returnFocus = null, focusFirst = false, align = "start" } = {}) {
  closePMenu();
  const menu = document.createElement("div");
  menu.className = "pmenu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items.map(itemHtml).join("");
  document.body.appendChild(menu);
  const isPoint = !(anchor instanceof Element);
  const box = isPoint ? null : anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  // align: "end" — правый край меню по правому краю кнопки (кнопка у края строки).
  const rect = isPoint
    ? { top: anchor.y, bottom: anchor.y, left: anchor.x }
    : { top: box.top, bottom: box.bottom, left: align === "end" ? box.right - m.width : box.left };
  const pos = placeMenu(rect, m, { width: window.innerWidth, height: window.innerHeight }, isPoint ? 0 : 6);
  menu.style.top = `${pos.top}px`;
  menu.style.left = `${pos.left}px`;
  menu.addEventListener("keydown", onMenuKeydown);
  menu.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    // Пункт забирает фокус при клике — возвращаем его на исходное место.
    closePMenu({ restoreFocus: true });
    onSelect?.(act);
  });
  openMenu = menu;
  openMenuReturnFocus = returnFocus ?? (isPoint ? null : anchor);
  if (focusFirst) menu.querySelector("[data-act]")?.focus();
  setTimeout(() => {
    if (openMenu !== menu) return;
    document.addEventListener("click", onDocClick);
    document.addEventListener("contextmenu", onDocClick, true);
    window.addEventListener("resize", onWindowResize);
    document.addEventListener("keydown", onDocKeydown);
  }, 10);
  return menu;
}
