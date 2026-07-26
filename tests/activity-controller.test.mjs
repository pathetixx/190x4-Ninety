import test from "node:test";
import assert from "node:assert/strict";

import { createActivityController } from "../src/lib/activity-controller.js";

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, fn) {
      const set = listeners.get(name) || new Set();
      set.add(fn);
      listeners.set(name, set);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); },
    count(name) { return listeners.get(name)?.size || 0; },
  };
}

test("controller follows visibility, focus and active view", () => {
  const doc = eventTarget({ visibilityState: "visible", hasFocus: () => true });
  const win = eventTarget();
  const controller = createActivityController({ document: doc, window: win });
  const states = [];
  controller.subscribe((state) => states.push({ ...state }));
  controller.mount();

  assert.equal(controller.isInteractive("home"), true);
  controller.setView("logs");
  assert.equal(controller.isInteractive("home"), false);
  assert.equal(controller.isInteractive("logs"), true);
  controller.setFocused(false);
  assert.equal(controller.isInteractive("logs"), false);
  controller.setFocused(true);
  assert.equal(controller.isInteractive("logs"), true);

  doc.visibilityState = "hidden";
  doc.emit("visibilitychange");
  assert.equal(controller.isVisible(), false);
  assert.equal(controller.isInteractive("logs"), false);

  doc.visibilityState = "visible";
  doc.emit("visibilitychange");
  win.emit("blur");
  assert.equal(controller.isFocused(), false);
  win.emit("focus");
  assert.equal(controller.isInteractive("logs"), true);
  assert.ok(states.length >= 5);

  controller.destroy();
  assert.equal(doc.count("visibilitychange"), 0);
  assert.equal(win.count("focus"), 0);
  assert.equal(win.count("blur"), 0);
});

test("mount and no-op state updates are idempotent", () => {
  const doc = eventTarget({ visibilityState: "visible", hasFocus: () => true });
  const win = eventTarget();
  const controller = createActivityController({ document: doc, window: win });
  let notifications = 0;
  controller.subscribe(() => notifications++);
  controller.mount();
  controller.mount();
  controller.setView("home");
  doc.emit("visibilitychange");

  assert.equal(doc.count("visibilitychange"), 1);
  assert.equal(win.count("focus"), 1);
  assert.equal(notifications, 2); // immediate subscribe + initial mount snapshot
});
