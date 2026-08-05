// Единственный видимый признак OTA, когда окно в трее. Регрессия здесь не
// заметна ни в UI, ни в логах: приложение просто молчит, и снаружи это
// неотличимо от «обновлений нет».
import { test } from "node:test";
import assert from "node:assert/strict";
import { planUpdateNotice, UPDATE_NOTICE } from "/lib/update-notice.js";

test("свёрнутое в трей окно получает OS-уведомление", () => {
  const plan = planUpdateNotice({ foreground: false });
  assert.equal(plan.action, UPDATE_NOTICE.NOTIFY);
  assert.equal(plan.pending, true);
});

test("повторная фоновая проверка той же версии не спамит уведомлением", () => {
  const plan = planUpdateNotice({ foreground: false, alreadyNotified: true });
  assert.equal(plan.action, UPDATE_NOTICE.TRAY);
  // Пункт трея и подсказка остаются: апдейт никуда не делся.
  assert.equal(plan.pending, true);
});

test("«Позже» гасит модалку и уведомление, но не признак в трее", () => {
  const plan = planUpdateNotice({ skipped: true, foreground: false });
  assert.equal(plan.action, UPDATE_NOTICE.TRAY);
  assert.equal(plan.pending, true, "случайный Esc не должен прятать факт обновления");
});

test("«Позже» не мешает модалке при открытом окне тоже — но только пассивно", () => {
  const plan = planUpdateNotice({ skipped: true, foreground: true });
  assert.equal(plan.action, UPDATE_NOTICE.TRAY);
});

test("окно перед пользователем — обычная модалка", () => {
  const plan = planUpdateNotice({ foreground: true });
  assert.equal(plan.action, UPDATE_NOTICE.MODAL);
});

test("ручная проверка показывает модалку даже по пропущенной версии", () => {
  const plan = planUpdateNotice({ interactive: true, skipped: true, foreground: false });
  assert.equal(plan.action, UPDATE_NOTICE.MODAL);
  assert.equal(plan.reason, "interactive");
});

test("открытая модалка той же версии не открывается вторично", () => {
  const plan = planUpdateNotice({ foreground: true, modalBusy: true });
  assert.equal(plan.action, UPDATE_NOTICE.TRAY);
  assert.equal(plan.reason, "modal_open");
});

test("любой исход оставляет апдейт pending", () => {
  const inputs = [
    { foreground: true },
    { foreground: false },
    { skipped: true },
    { alreadyNotified: true },
    { modalBusy: true },
    { interactive: true },
  ];
  for (const input of inputs) {
    assert.equal(planUpdateNotice(input).pending, true, JSON.stringify(input));
  }
});
