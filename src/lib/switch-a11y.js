// Ninety · доступность .switch-тумблеров. Тумблеры — <span class="switch"
// data-on>, клик обрабатывает байндер каждого экрана (settings-view, main,
// dpi-view); здесь только клавиатура и ARIA: role/tabindex, Space/Enter → click,
// зеркало data-on → aria-checked. data-on пишут разные владельцы — наблюдатель
// избавляет от патча каждого write-site; у MutationObserver слабая ссылка на
// target, снятые с DOM узлы собираются GC вместе с ним.
export function a11ySwitch(sw) {
  if (!sw || sw.dataset.a11yBound === "1") return;
  sw.dataset.a11yBound = "1";
  sw.setAttribute("role", "switch");
  if (!sw.hasAttribute("tabindex")) sw.setAttribute("tabindex", "0");
  const sync = () => sw.setAttribute("aria-checked", sw.dataset.on === "true" ? "true" : "false");
  sync();
  sw.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    sw.click();
  });
  new MutationObserver(sync).observe(sw, { attributes: true, attributeFilter: ["data-on"] });
}

// Все .switch внутри контейнера — звать после innerHTML-рендера экрана.
// НЕ для тумблеров внутри <button> (dpi-chip): вложенный tabbable — антипаттерн.
export function a11ySwitchAll(root) {
  if (!root) return;
  root.querySelectorAll(".switch").forEach((sw) => {
    if (!sw.closest("button")) a11ySwitch(sw);
  });
}
