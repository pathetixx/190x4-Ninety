// Ninety · titlebar popovers (currently only "Connection mode"). Moved out of
// main.js. Self-contained: takes elements by id, attaches open/close with
// positioning under the button, closing on click-outside/Escape and repositioning on resize.
// Returns { closeAll } — main calls it when opening modals (e.g. add-sub).

const POPOVERS = {
  mode: { btnId: "mode-toggle", elId: "mode-popover" },
};

// Minimum gap from the window edge when clamping.
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

  // Positioned via left: anchored to the button's logical side (in LTR the popover's right
  // edge at the button's right edge, in RTL the left one at the left one) and kept within
  // the window bounds. A hard `right` pushed the popover past the left edge in fa/ar: there
  // the toolbar is mirrored to the left edge, and the card is wider than the distance to it.
  function place(p) {
    const el = p.el;
    const wasHidden = el.hidden;
    // The width is needed before showing: for a hidden element it's zero.
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
