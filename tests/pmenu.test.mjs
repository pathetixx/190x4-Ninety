// Меню действий и защита страницы (issue #185): своё меню вместо меню WebView2,
// без перезагрузки и переходов по истории; меню WebView2 остаётся только для
// копирования и вставки.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installPageGuards,
  isContextMenuKey,
  isHistoryMouseButton,
  isPageNavigationShortcut,
  nextMenuIndex,
  placeMenu,
  wantsNativeContextMenu,
} from "../src/lib/pmenu.js";

const VIEW = { width: 1000, height: 700 };
const SIZE = { width: 200, height: 300 };

test("меню встаёт под кнопкой с отступом", () => {
  assert.deepEqual(placeMenu({ top: 100, bottom: 130, left: 400 }, SIZE, VIEW), { top: 136, left: 400 });
});

test("у нижнего края меню переворачивается вверх", () => {
  assert.deepEqual(placeMenu({ top: 600, bottom: 630, left: 400 }, SIZE, VIEW), { top: 294, left: 400 });
});

test("у правого края меню прижимается внутрь окна", () => {
  assert.deepEqual(placeMenu({ top: 100, bottom: 130, left: 900 }, SIZE, VIEW), { top: 136, left: 788 });
});

test("от точки курсора меню открывается без отступа", () => {
  assert.deepEqual(placeMenu({ top: 50, bottom: 50, left: 60 }, SIZE, VIEW, 0), { top: 50, left: 60 });
  assert.deepEqual(placeMenu({ top: 650, bottom: 650, left: 60 }, SIZE, VIEW, 0), { top: 350, left: 60 });
});

test("меню не уходит за верхний и левый край", () => {
  assert.deepEqual(placeMenu({ top: 100, bottom: 690, left: -50 }, SIZE, VIEW), { top: 8, left: 8 });
});

function target(matches) {
  return { closest: (sel) => (matches && sel.includes("input") ? {} : null) };
}

test("меню WebView2 остаётся в полях ввода и на выделенном тексте", () => {
  assert.equal(wantsNativeContextMenu(target(true), null), true);
  const sel = { isCollapsed: false, toString: () => "текст" };
  assert.equal(wantsNativeContextMenu(target(false), sel), true);
  assert.equal(wantsNativeContextMenu(target(false), { isCollapsed: true, toString: () => "" }), false);
  assert.equal(wantsNativeContextMenu(target(false), { isCollapsed: false, toString: () => "  " }), false);
  assert.equal(wantsNativeContextMenu(null, null), false);
});

test("сочетания перезагрузки, истории и печати перехватываются", () => {
  const hit = (e) => isPageNavigationShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...e });
  assert.equal(hit({ key: "F5" }), true);
  assert.equal(hit({ key: "F5", ctrlKey: true }), true);
  assert.equal(hit({ key: "r", code: "KeyR", ctrlKey: true }), true);
  assert.equal(hit({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }), true);
  assert.equal(hit({ key: "к", code: "KeyR", ctrlKey: true }), true, "русская раскладка");
  assert.equal(hit({ key: "p", code: "KeyP", ctrlKey: true }), true);
  assert.equal(hit({ key: "ArrowLeft", altKey: true }), true);
  assert.equal(hit({ key: "BrowserBack" }), true);
  assert.equal(hit({ key: "BrowserRefresh" }), true);
});

test("рабочие сочетания приложения не трогаются", () => {
  const hit = (e) => isPageNavigationShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...e });
  assert.equal(hit({ key: "p", code: "KeyP", ctrlKey: true, altKey: true }), false, "Ctrl+Alt+P — снимок производительности");
  assert.equal(hit({ key: "f", code: "KeyF", ctrlKey: true }), false, "Ctrl+F — поиск серверов");
  assert.equal(hit({ key: "Enter", code: "Enter", ctrlKey: true }), false);
  assert.equal(hit({ key: "ArrowLeft" }), false);
  assert.equal(hit({ key: "r", code: "KeyR" }), false);
});

test("клавиатурное контекстное меню: Menu и Shift+F10", () => {
  assert.equal(isContextMenuKey({ key: "ContextMenu" }), true);
  assert.equal(isContextMenuKey({ key: "F10", shiftKey: true }), true);
  assert.equal(isContextMenuKey({ key: "F10", shiftKey: false }), false);
});

test("боковые кнопки мыши — это история", () => {
  assert.equal(isHistoryMouseButton({ button: 3 }), true);
  assert.equal(isHistoryMouseButton({ button: 4 }), true);
  assert.equal(isHistoryMouseButton({ button: 2 }), false);
});

test("стрелки ходят по пунктам по кругу", () => {
  assert.equal(nextMenuIndex("ArrowDown", -1, 3), 0);
  assert.equal(nextMenuIndex("ArrowDown", 2, 3), 0);
  assert.equal(nextMenuIndex("ArrowUp", -1, 3), 2);
  assert.equal(nextMenuIndex("ArrowUp", 0, 3), 2);
  assert.equal(nextMenuIndex("Home", 2, 3), 0);
  assert.equal(nextMenuIndex("End", 0, 3), 2);
  assert.equal(nextMenuIndex("Enter", 0, 3), null);
  assert.equal(nextMenuIndex("ArrowDown", -1, 0), null);
});

test("защита документа гасит меню страницы, но не в поле ввода", () => {
  const handlers = {};
  const selection = { isCollapsed: true, toString: () => "" };
  const doc = {
    defaultView: { getSelection: () => selection },
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
  };
  installPageGuards(doc);
  const fire = (type, e) => {
    let prevented = false;
    const ev = { defaultPrevented: false, preventDefault: () => { prevented = true; }, ...e };
    for (const fn of handlers[type]) fn(ev);
    return prevented;
  };
  assert.equal(fire("contextmenu", { target: target(false) }), true);
  assert.equal(fire("contextmenu", { target: target(true) }), false);
  assert.equal(fire("keydown", { key: "F5" }), true);
  assert.equal(fire("keydown", { key: "a", code: "KeyA" }), false);
  assert.equal(fire("mouseup", { button: 3 }), true);
  assert.equal(fire("auxclick", { button: 4 }), true);
});
