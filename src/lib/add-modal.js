// Ninety · Add Profile Modal controller
// Hiddify-style: единый flow для clipboard / URL / vless://.

import { detectAddInput, addSubscriptionFromUrl, parseSubscriptionBody } from "/lib/subscriptions.js";
import { addProfileFromVless, setActiveKind } from "/lib/singbox.js";

function $(id) { return document.getElementById(id); }

let onCommitCb = null;

function intervalLabel(hours) {
  const h = Number(hours) || 0;
  if (h === 0) return "Авто (сервер)";
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r === 0 ? `${d} д` : `${d} д ${r} ч`;
}

function showPage(name) {
  ["options", "manual", "loading"].forEach(p => {
    const el = $(`add-modal-page-${p}`);
    if (el) el.hidden = p !== name;
  });
}

function setError(msg) {
  const el = $("add-modal-error");
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ""; el.hidden = true; }
}

function setLoadingText(t) {
  const el = $("add-modal-loading-text");
  if (el) el.textContent = t;
}

function openModal() {
  const m = $("add-modal");
  if (!m) return;
  m.hidden = false;
  showPage("options");
  setError(null);
  document.addEventListener("keydown", onKey);
}

function closeModal() {
  const m = $("add-modal");
  if (!m) return;
  m.hidden = true;
  showPage("options");
  setError(null);
  document.removeEventListener("keydown", onKey);
  // очищаем поля
  const u = $("add-modal-url"); if (u) u.value = "";
  const n = $("add-modal-name"); if (n) n.value = "";
}

function onKey(e) {
  if (e.key === "Escape") closeModal();
}

async function handleInput(raw, userOverride = {}) {
  const decision = detectAddInput(raw);

  if (decision.kind === "empty" || decision.kind === "unknown") {
    throw new Error("Не распознал ввод. Вставь ссылку (vless/vmess/trojan/ss/hysteria2/tuic) или http(s):// URL подписки.");
  }

  if (decision.kind === "config") {
    const { profile } = addProfileFromVless(decision.content);
    setActiveKind("single");
    return { type: "config", message: `Конфиг "${profile.name}" импортирован` };
  }

  if (decision.kind === "list") {
    const profiles = parseSubscriptionBody(decision.content);
    if (profiles.length === 0) throw new Error("Не нашёл валидных конфигов в списке");
    for (const p of profiles) {
      addProfileFromVless(p.raw);
    }
    setActiveKind("single");
    return { type: "list", message: `Импортировано ${profiles.length} конфигов` };
  }

  // kind === "url" → подписка
  setLoadingText("Загружаю подписку…");
  const sub = await addSubscriptionFromUrl(decision.url, userOverride.name || "");
  setActiveKind("sub");
  // localStorage.setItem("ninety.subscriptions.active", sub.id) — addSubscriptionFromUrl сам ставит при первом
  // но при добавлении не первой подписки активной не делает; принудительно ставим:
  localStorage.setItem("ninety.subscriptions.active", sub.id);
  return { type: "sub", message: `Подписка "${sub.name}" — ${sub.profiles.length} нод` };
}

export function mountAddModal({ onCommit } = {}) {
  onCommitCb = onCommit;

  $("add-modal-backdrop")?.addEventListener("click", closeModal);
  $("add-modal-close")?.addEventListener("click", closeModal);
  $("add-modal-back")?.addEventListener("click", () => { showPage("options"); setError(null); });

  $("add-modal")?.addEventListener("click", (e) => {
    const tile = e.target.closest(".add-modal__tile");
    if (!tile) return;
    const action = tile.dataset.action;
    if (action === "clipboard") void doClipboard();
    else if (action === "manual") {
      showPage("manual");
      setTimeout(() => $("add-modal-url")?.focus(), 50);
    }
  });

  // Slider label
  const slider = $("add-modal-interval");
  const sliderVal = $("add-modal-interval-val");
  if (slider && sliderVal) {
    sliderVal.textContent = intervalLabel(slider.value);
    slider.addEventListener("input", () => { sliderVal.textContent = intervalLabel(slider.value); });
  }

  // Enter в полях
  ["add-modal-url", "add-modal-name"].forEach(id => {
    $(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("add-modal-submit")?.click(); }
    });
  });

  $("add-modal-submit")?.addEventListener("click", async () => {
    const url = $("add-modal-url")?.value.trim();
    const name = $("add-modal-name")?.value.trim();
    if (!url) { setError("Введите URL или vless://"); return; }
    setError(null);
    showPage("loading");
    try {
      const res = await handleInput(url, { name });
      onCommitCb?.(res);
      closeModal();
    } catch (e) {
      showPage("manual");
      setError(e?.message || String(e));
    }
  });
}

async function doClipboard() {
  setError(null);
  showPage("loading");
  setLoadingText("Читаю буфер…");
  let raw = "";
  try {
    raw = await navigator.clipboard.readText();
  } catch {
    showPage("manual");
    setError("Нет доступа к буферу — введите URL вручную ниже.");
    setTimeout(() => $("add-modal-url")?.focus(), 50);
    return;
  }
  if (!raw?.trim()) {
    showPage("manual");
    setError("Буфер пуст. Введите URL вручную.");
    setTimeout(() => $("add-modal-url")?.focus(), 50);
    return;
  }
  try {
    const res = await handleInput(raw);
    onCommitCb?.(res);
    closeModal();
  } catch (e) {
    showPage("manual");
    $("add-modal-url").value = raw;
    setError(e?.message || String(e));
  }
}

export function openAddModal() { openModal(); }
