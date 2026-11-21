// Ninety · titlebar buttons (minimize/maximize/close). Moved out of main.js.
// tauriWin is injected — the same window handle the whole of main uses; windows
// without Tauri (web preview) simply do nothing.
export function initTitlebar(tauriWin) {
  document.querySelectorAll("[data-window-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!tauriWin) return;
      const action = btn.dataset.windowAction;
      try {
        if (action === "minimize") await tauriWin.minimize();
        else if (action === "maximize") await tauriWin.toggleMaximize();
        else if (action === "close") await tauriWin.close();
      } catch (e) {
        console.error("window action failed", action, e);
      }
    });
  });
}
