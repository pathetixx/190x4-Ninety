// Ninety · a window to the outside for perfObserver.
//
// The collector in performance-observer.js counts timings and counters from the very
// start, but there was nowhere to look at them: devtools are disabled in the release build, and
// the snapshot wasn't output anywhere. Here are the two missing pieces:
//
//   1) an observer of main-thread long tasks — exactly what the user
//      perceives as a freeze, tagged with the screen on which the task happened;
//   2) dumping the whole snapshot to the clipboard with Ctrl+Alt+P.
//
// Nothing goes out from here (to the network, to telemetry): the snapshot contains only
// durations and counters and ends up exactly where the user copied it
// themselves.

import { perfObserver } from "/lib/performance-observer.js";
import { activityController } from "/lib/activity-controller.js";

// 50 ms is the threshold from which the Long Tasks API creates an entry at all; a frame
// is already dropped by then. We record everything it returns.
const LONGTASK_MIN_MS = 50;
// A separate cutoff for the "heavy" task counter: 50 ms is a stutter,
// but from 200 ms the interface feels frozen.
const LONGTASK_HEAVY_MS = 200;

let longTaskObserver = null;
let hotkeyBound = false;

function startLongTaskObserver() {
  if (longTaskObserver || typeof PerformanceObserver !== "function") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = Number(entry?.duration) || 0;
        if (duration < LONGTASK_MIN_MS) continue;
        const { view, visible } = activityController.snapshot();
        perfObserver.sample("longtask.ms", duration, { view, visible: visible ? 1 : 0 });
        perfObserver.increment("longtask.count");
        if (duration >= LONGTASK_HEAVY_MS) perfObserver.increment("longtask.heavy");
      }
    });
    // buffered: startup long tasks (module parsing, the first render) happen
    // before this module gets a chance to subscribe.
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    longTaskObserver = null;
  }
}

// The snapshot + the minimum context without which the numbers can't be read: which screen
// is open now and on which engine it all runs (the WebView2 version lives in the UA).
export function perfSnapshot() {
  const activity = activityController.snapshot();
  return {
    ...perfObserver.snapshot(),
    view: activity.view,
    visible: activity.visible,
    focused: activity.focused,
    userAgent: globalThis.navigator?.userAgent || "",
    screen: {
      dpr: globalThis.devicePixelRatio || 1,
      w: globalThis.innerWidth || 0,
      h: globalThis.innerHeight || 0,
    },
  };
}

export function initPerfProbe({ onToast, onCopied } = {}) {
  startLongTaskObserver();

  // Access from the debug build console — where people usually look.
  try { globalThis.__ninetyPerf = perfSnapshot; } catch { /* ignore */ }

  if (hotkeyBound) return;
  hotkeyBound = true;
  document.addEventListener("keydown", async (e) => {
    if (!e.ctrlKey || !e.altKey || e.shiftKey) return;
    if ((e.key || "").toLowerCase() !== "p") return;
    e.preventDefault();
    const text = JSON.stringify(perfSnapshot(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      onCopied?.(text);
      onToast?.("ok");
    } catch {
      onToast?.("fail");
    }
  });
}
