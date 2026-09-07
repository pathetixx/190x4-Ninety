// Ninety · поповеры титулбара (сейчас только «Режим подключения»). Вынесено из
// main.js. Самодостаточно: элементы берёт по id, вешает открытие/закрытие с
// позиционированием под кнопкой, закрытие по клику-вне/Escape и репозицию на resize.
// Возвращает { closeAll } — main зовёт его при открытии модалок (напр. add-sub).

const POPOVERS = {
  mode: { btnId: "mode-toggle", elId: "mode-popover" },
};

// Минимальный зазор от края окна при клампе.
const EDGE = 8;

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

  // Позиционируем через left: якорим по логической стороне кнопки (в LTR правый
  // край поповера по правому краю кнопки, в RTL — левый по левому) и держим в
  // границах окна. Жёсткое `right` уводило поповер за левый край в fa/ar: там
  // тулбар зеркалится к левому краю, а карточка шире расстояния до него.
  function place(p) {
    const el = p.el;
    const wasHidden = el.hidden;
    // Ширина нужна до показа: у hidden-элемента она нулевая.
    if (wasHidden) { el.style.visibility = "hidden"; el.hidden = false; }
    const r = p.btn.getBoundingClientRect();
    const w = el.offsetWidth;
    const rtl = getComputedStyle(document.documentElement).direction === "rtl";
    let left = rtl ? r.left : r.right - w;
    left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE));
    el.style.top = `${Math.round(r.bottom + 8)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.right = "auto";
    if (wasHidden) { el.hidden = true; el.style.visibility = ""; }
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
