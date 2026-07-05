// Ninety · кнопки титулбара (свернуть/развернуть/закрыть). Вынесено из main.js.
// tauriWin инжектится — тот же дескриптор окна, что использует весь main; окна
// без Tauri (web-preview) просто ничего не делают.
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
