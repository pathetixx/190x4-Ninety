// Ninety · accessibility of .switch toggles. Toggles are <span class="switch"
// data-on>, the click is handled by each screen's binder (settings-view, main,
// dpi-view); here only the keyboard and ARIA: role/tabindex, Space/Enter → click,
// mirroring data-on → aria-checked. data-on is written by different owners — the observer
// saves us from patching every write site; MutationObserver holds a weak reference to
// the target, nodes removed from the DOM are collected by GC together with it.
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

// All .switch elements inside the container — call after the screen's innerHTML render.
// NOT for toggles inside a <button> (dpi-chip): a nested tabbable is an antipattern.
export function a11ySwitchAll(root) {
  if (!root) return;
  root.querySelectorAll(".switch").forEach((sw) => {
    if (!sw.closest("button")) a11ySwitch(sw);
  });
}
