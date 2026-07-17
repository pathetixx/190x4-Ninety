// CI-only wrapper: forces the sanitized bootstrap on, then cycles the real app
// through every README view. Copied into src/ only inside the screenshot workflow.

const BOOT_TITLE = "Ninety README sequence BOOT";
document.title = BOOT_TITLE;

let tauri = window.__TAURI__;
const windowHandle = tauri?.window?.getCurrentWindow?.()
  ?? tauri?.window?.getCurrent?.();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function setWindowTitle(title) {
  document.title = title;
  try { await windowHandle?.setTitle?.(title); } catch {}
}

await setWindowTitle(BOOT_TITLE);

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fn()) return; } catch {}
    await sleep(100);
  }
  throw new Error("README sequence readiness timeout");
}

async function mark(view, state = "READY") {
  await setWindowTitle(`Ninety README ${view} ${state}`);
}

function installStartupFixture() {
  const originalInvoke = tauri?.core?.invoke?.bind(tauri.core);
  if (!originalInvoke) throw new Error("Tauri invoke is unavailable");

  const startupFixture = async (command, args = {}) => {
    if (command === "startup_deep_links") return ["ninety://readme-capture/home"];
    return originalInvoke(command, args);
  };

  let installed = false;
  try {
    tauri.core.invoke = startupFixture;
    installed = tauri.core.invoke === startupFixture;
  } catch {}

  if (!installed) {
    try {
      Object.defineProperty(tauri.core, "invoke", {
        value: startupFixture,
        configurable: true,
        writable: true,
      });
      installed = tauri.core.invoke === startupFixture;
    } catch {}
  }

  if (!installed) {
    try {
      const replacementCore = Object.create(tauri.core);
      Object.defineProperty(replacementCore, "invoke", {
        value: startupFixture,
        configurable: true,
        writable: true,
      });
      tauri.core = replacementCore;
      installed = tauri.core.invoke === startupFixture;
    } catch {}
  }

  if (!installed) throw new Error("Unable to install README startup fixture");
}

async function openView(view) {
  const target = view === "nodes" ? "proxies" : view === "quality" ? "home" : view;
  const nav = document.querySelector(`.nav__item[data-view="${target}"]`);
  if (!nav) throw new Error(`README nav missing: ${target}`);
  nav.click();
  await waitFor(() => {
    const screen = document.querySelector(`section.screen[data-view="${target}"]`);
    return screen && !screen.hidden;
  });

  if (view === "nodes") {
    await waitFor(() => document.querySelectorAll("#proxies-grid .prox").length >= 7);
  } else if (view === "profiles") {
    await waitFor(() => document.querySelectorAll("#profiles-list .prof-card").length >= 2);
  } else if (view === "dpi") {
    await waitFor(() => document.querySelector("#dpi-body .dpi-master"));
  } else if (view === "logs") {
    await waitFor(() => document.querySelectorAll("#logs-view .log-line").length >= 5);
    const auto = document.querySelector("#logs-auto");
    if (auto) auto.checked = false;
  }

  if (view === "quality") {
    const strip = document.querySelector("#stats-strip");
    if (strip) strip.hidden = false;
    const values = {
      "#stats-server": "Frankfurt · Reality",
      "#stats-ping": "34",
      "#stats-channel": "Отлично",
      "#stats-uptime": "18:42",
      "#stats-total": "↓ 4.53 ГБ · ↑ 178 МБ",
      "#stats-mode": "СИСТЕМНЫЙ",
    };
    for (const [selector, value] of Object.entries(values)) {
      const element = document.querySelector(selector);
      if (element) element.textContent = value;
    }
    const channel = document.querySelector("#tele-channel");
    if (!channel) throw new Error("README quality channel anchor missing");
    channel.dataset.q = "GOOD";
    channel.dataset.active = "true";
    const { openQualityScope } = await import("/lib/quality-scope.js");
    const samples = Array.from({ length: 46 }, (_, index) => ({
      bps: 1800000 + Math.sin(index / 3) * 420000 + (index % 9 === 0 ? -520000 : 0),
      q: index % 9 === 0 ? "SLOW" : "GOOD",
      rung: index === 13 ? "R1" : index === 31 ? "R2" : null,
    }));
    openQualityScope({ anchor: channel, getSamples: () => samples, goodBps: 1500000 });
    await waitFor(() => document.querySelector(".qscope"));
  }

  await document.fonts.ready;
  await sleep(700);
  await mark(view);
}

try {
  installStartupFixture();
  await import("/readme-capture-bootstrap.js");

  // The imported bootstrap has already prepared and marked the home view.
  await sleep(4500);
  for (const view of ["nodes", "profiles", "dpi", "settings", "logs", "quality"]) {
    await openView(view);
    await sleep(4500);
  }
  await mark("sequence", "DONE");
} catch (error) {
  console.error("README capture sequence failed", error);
  const message = String(error?.message || error || "unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 100);
  await mark("sequence", `ERROR ${message}`);
}
