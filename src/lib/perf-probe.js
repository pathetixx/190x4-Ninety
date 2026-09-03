// Ninety · окно наружу для perfObserver.
//
// Коллектор в performance-observer.js считает тайминги и счётчики с самого
// старта, но посмотреть их было негде: devtools в релизной сборке выключены, а
// снимок никуда не выводился. Здесь два недостающих куска:
//
//   1) наблюдатель длинных задач главного потока — ровно то, что пользователь
//      ощущает как фриз, с пометкой экрана, на котором задача случилась;
//   2) выгрузка всего снимка в буфер обмена по Ctrl+Alt+P.
//
// Наружу (в сеть, в телеметрию) отсюда не уходит ничего: снимок содержит только
// длительности и счётчики и попадает ровно туда, куда его скопировал сам
// пользователь.

import { perfObserver } from "/lib/performance-observer.js";
import { activityController } from "/lib/activity-controller.js";

// 50 мс — порог, с которого Long Tasks API вообще заводит запись; кадр при
// этом уже пропущен. Пишем всё, что он отдаёт.
const LONGTASK_MIN_MS = 50;
// Отдельная отсечка для счётчика «тяжёлых» задач: 50 мс — это подтормаживание,
// а вот от 200 мс интерфейс ощущается зависшим.
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
    // buffered: длинные задачи старта (разбор модулей, первый рендер) случаются
    // до того, как этот модуль успевает подписаться.
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch {
    longTaskObserver = null;
  }
}

// Снимок + минимум контекста, без которого цифры не читаются: какой экран
// открыт сейчас и на каком движке всё это крутится (версия WebView2 живёт в UA).
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

  // Доступ из консоли отладочной сборки — там же, где обычно и смотрят.
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
