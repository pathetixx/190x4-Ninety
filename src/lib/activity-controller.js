// Ninety · foreground/background activity controller.
//
// Visual modules subscribe to this store instead of running independent work
// while WebView2 is hidden in the tray. Network safety watchdogs remain outside
// this controller and continue to run regardless of window visibility.

import { perfObserver } from "/lib/performance-observer.js";

function readVisible(doc) {
  return !doc || doc.visibilityState !== "hidden";
}

export function createActivityController({
  document: doc = globalThis.document,
  window: win = globalThis.window,
  initialView = "home",
} = {}) {
  let state = Object.freeze({
    visible: readVisible(doc),
    focused: typeof doc?.hasFocus === "function" ? !!doc.hasFocus() : true,
    view: initialView,
  });
  const listeners = new Set();
  let mounted = false;

  function notify(previous) {
    perfObserver.gauge("activity.visible", state.visible ? 1 : 0);
    perfObserver.gauge("activity.focused", state.focused ? 1 : 0);
    for (const listener of [...listeners]) {
      try { listener(state, previous); } catch (error) {
        console.warn("activity listener failed", error);
      }
    }
  }

  function patch(next) {
    const candidate = { ...state, ...next };
    if (candidate.visible === state.visible
      && candidate.focused === state.focused
      && candidate.view === state.view) return state;
    const previous = state;
    state = Object.freeze(candidate);
    notify(previous);
    return state;
  }

  const onVisibility = () => patch({ visible: readVisible(doc) });
  const onFocus = () => patch({ focused: true });
  const onBlur = () => patch({ focused: false });

  function mount() {
    if (mounted) return;
    mounted = true;
    doc?.addEventListener?.("visibilitychange", onVisibility);
    win?.addEventListener?.("focus", onFocus);
    win?.addEventListener?.("blur", onBlur);
    notify(state);
  }

  function destroy() {
    if (!mounted) return;
    mounted = false;
    doc?.removeEventListener?.("visibilitychange", onVisibility);
    win?.removeEventListener?.("focus", onFocus);
    win?.removeEventListener?.("blur", onBlur);
    listeners.clear();
  }

  function subscribe(listener, { immediate = true } = {}) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    if (immediate) listener(state, state);
    return () => listeners.delete(listener);
  }

  function setView(view) {
    if (typeof view === "string" && view) patch({ view });
  }

  function setVisible(visible) {
    patch({ visible: !!visible });
  }

  function setFocused(focused) {
    patch({ focused: !!focused });
  }

  function isInteractive(view = null) {
    return state.visible && state.focused && (!view || state.view === view);
  }

  return {
    mount,
    destroy,
    subscribe,
    setView,
    setVisible,
    setFocused,
    snapshot: () => state,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    isInteractive,
  };
}

export const activityController = createActivityController();
activityController.mount();
