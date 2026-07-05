// Ninety · поповеры титулбара (сейчас только «Режим подключения»). Вынесено из
// main.js. Самодостаточно: элементы берёт по id, вешает открытие/закрытие с
// позиционированием под кнопкой, закрытие по клику-вне/Escape и репозицию на resize.
// Возвращает { closeAll } — main зовёт его при открытии модалок (напр. add-sub).

const POPOVERS = {
  mode: { btnId: "mode-toggle", elId: "mode-popover" },
};

export function initPopovers() {
  const items = {};
  for (const key of Object.keys(POPOVERS)) {
    const { btnId, elId } = POPOVERS[key];
    items[key] = { btn: document.getElementById(btnId), el: document.getElementById(elId) };
  }

  function closeAll(except) {
    for (const key of Object.keys(items)) {
      if (key === except) continue;
      const p = items[key];
      if (!p.btn || !p.el) continue;
      p.el.hidden = true;
      p.btn.setAttribute("aria-expanded", "false");
    }
  }

  function place(p) {
    const r = p.btn.getBoundingClientRect();
    p.el.style.top = `${Math.round(r.bottom + 8)}px`;
    p.el.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  }

  for (const key of Object.keys(items)) {
    const p = items[key];
    if (!p.btn || !p.el) continue;
    p.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = p.el.hidden;
      closeAll(key);
      if (willOpen) {
        place(p);
        p.el.hidden = false;
        p.btn.setAttribute("aria-expanded", "true");
      } else {
        p.el.hidden = true;
        p.btn.setAttribute("aria-expanded", "false");
      }
    });
    p.el.addEventListener("click", (e) => e.stopPropagation());
  }

  document.addEventListener("click", () => closeAll());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  window.addEventListener("resize", () => {
    for (const key of Object.keys(items)) {
      const p = items[key];
      if (p.btn && p.el && !p.el.hidden) place(p);
    }
  });

  return { closeAll };
}
