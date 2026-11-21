// Popup action menu (.pmenu) — one for the whole app: at the "⋯" button,
// at the cursor (right click) or at a row (the Menu key / Shift+F10), plus the rules
// for when WebView2 should show its own menu instead of ours.
// The WebView2 page menu (Back, Reload, Save as, Print) is useless and dangerous
// for the app: "Reload" restarts the interface in the middle of
// a live connection. So it stays only where
// copy and paste are needed — in input fields and on selected text.

import { escapeAttr, escapeHtml } from "/lib/esc.js";

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])";
const EDGE = 8;
const MARGIN = 12;

/**
 * Menu coordinates: under the anchor (or from the cursor point), flipped up at
 * the bottom edge and pushed in at the right edge of the window.
 * @param {{top:number,bottom:number,left:number}} anchor the anchor rectangle; for a point top === bottom
 * @param {{width:number,height:number}} size menu size
 * @param {{width:number,height:number}} viewport window size
 * @param {number} gap offset from the anchor
 */
export function placeMenu(anchor, size, viewport, gap = 6) {
  let top = anchor.bottom + gap;
  let left = anchor.left;
  if (top + size.height > viewport.height - MARGIN) top = anchor.top - size.height - gap;
  if (left + size.width > viewport.width - MARGIN) left = viewport.width - size.width - MARGIN;
  return { top: Math.max(EDGE, top), left: Math.max(EDGE, left) };
}

/** A right click here must open the WebView2 menu (copy/paste). */
export function wantsNativeContextMenu(target, selection) {
  if (target?.closest?.(EDITABLE)) return true;
  return Boolean(selection && !selection.isCollapsed && String(selection).trim());
}

/** The key that opens the context menu from the keyboard: Menu or Shift+F10. */
export function isContextMenuKey(e) {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

/**
 * Shortcuts with which WebView2 reloads the page, navigates history or
 * opens printing. They make no sense in the app, and a reload resets
 * the interface during a live connection.
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

/** The mouse's side "Back"/"Forward" buttons. */
export function isHistoryMouseButton(e) {
  return e.button === 3 || e.button === 4;
}

/**
 * Global document protection: our own menu instead of the page menu, no
 * reloads and no history navigation.
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
 * Moving focus through menu items with the arrows, Home and End.
 * @returns {number|null} index of the next item, or null if the key isn't ours
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
// One menu is open at a time. It closes on a click or right click outside,
// Escape, Tab, a window resize; focus returns to where the menu was opened from.
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
// The menu was opened with the mouse, focus stayed outside — Escape still closes it.
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
  // A state item ("Already selected") isn't an action, it can't be pressed.
  if (it.state) {
    return `<div class="pmenu__item pmenu__item--state" role="menuitem" aria-disabled="true">${it.icon || ""}<span>${escapeHtml(it.label)}</span></div>`;
  }
  return `<button class="pmenu__item${it.danger ? " pmenu__item--danger" : ""}" data-act="${escapeAttr(it.id)}" type="button" role="menuitem" tabindex="-1">${it.icon || ""}<span>${escapeHtml(it.label)}</span></button>`;
}

/**
 * Open the menu. The item choice arrives in onSelect(id) after the menu closes.
 * @param {Element|{x:number,y:number}} anchor a button/row or the cursor point
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
  // align: "end" — the menu's right edge at the button's right edge (the button is at the row edge).
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
    // The item takes focus on click — we return it to where it was.
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
