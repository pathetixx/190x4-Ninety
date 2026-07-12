// Ninety · Add Profile Modal controller
// Hiddify-style: единый flow для clipboard / URL / vless://.

import { detectAddInput, addSubscriptionFromUrl, parseSubscriptionBody } from "/lib/subscriptions.js";
import { addProfileFromVless, addTrustTunnelFromToml } from "/lib/singbox.js";
import { t } from "/lib/i18n/index.js";
import { toast } from "/lib/toast.js";

function $(id) { return document.getElementById(id); }

let onCommitCb = null;

function intervalLabel(hours) {
  const h = Number(hours) || 0;
  if (h === 0) return t("add.intervalAuto");
  if (h < 24) return t("add.intervalH", { h });
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r === 0 ? t("add.intervalD", { d }) : t("add.intervalDH", { d, r });
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

export async function importAddInput(raw, userOverride = {}) {
  const decision = detectAddInput(raw);

  if (decision.kind === "empty" || decision.kind === "unknown") {
    throw new Error(t("add.errUnrecognized"));
  }

  if (decision.kind === "config") {
    const { id, profile } = addProfileFromVless(decision.content);
    return {
      type: "config",
      message: t("add.msgConfig", { name: profile.name }),
      source: { kind: "single", id },
    };
  }

  if (decision.kind === "tt-toml") {
    const { id, profile } = addTrustTunnelFromToml(decision.content, userOverride.name || "");
    return {
      type: "config",
      message: t("add.msgTt", { name: profile.name }),
      source: { kind: "single", id },
    };
  }

  if (decision.kind === "list") {
    const profiles = parseSubscriptionBody(decision.content);
    if (profiles.length === 0) throw new Error(t("add.errNoConfigs"));
    const added = profiles.map(p => addProfileFromVless(p.raw));
    // Детерминированно активируем первый профиль именно этого импорта.
    return {
      type: "list",
      message: t("add.msgList", { n: profiles.length }),
      source: { kind: "single", id: added[0].id },
    };
  }

  // kind === "url" → подписка. intervalHours из слайдера «Авто-обновление»
  // (0 = авто/по заголовку панели); передаётся только при ручном добавлении.
  setLoadingText(t("add.loadingSub"));
  const sub = await addSubscriptionFromUrl(decision.url, userOverride.name || "", userOverride.intervalHours);
  // http:// — адрес и ключи подписки едут открытым текстом (виден провайдеру,
  // и каждый рефреш тоже). Не блокируем (http-панели существуют), но предупреждаем.
  if (/^http:\/\//i.test(decision.url)) toast(t("add.httpWarn"), "warn", 6000);
  return {
    type: "sub",
    message: t("add.msgSub", { name: sub.name, n: sub.profiles.length }),
    source: { kind: "sub", id: sub.id },
  };
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
    else if (action === "file") $("add-modal-file")?.click();
  });

  // Импорт файла (TrustTunnel .toml): читаем через FileReader, кормим handleInput.
  $("add-modal-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // позволить повторный выбор того же файла
    if (!file) return;
    setError(null);
    showPage("loading");
    setLoadingText(t("add.loadingFile"));
    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const res = await importAddInput(text, { name: baseName });
      await onCommitCb?.(res);
      closeModal();
    } catch (err) {
      showPage("manual");
      setError(err?.message || String(err));
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
    const intervalHours = Number($("add-modal-interval")?.value) || 0;
    if (!url) { setError(t("add.errNeedUrl")); return; }
    setError(null);
    showPage("loading");
    try {
      const res = await importAddInput(url, { name, intervalHours });
      await onCommitCb?.(res);
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
  setLoadingText(t("add.loadingClipboard"));
  let raw;
  try {
    raw = await navigator.clipboard.readText();
  } catch {
    showPage("manual");
    setError(t("add.errNoClipboard"));
    setTimeout(() => $("add-modal-url")?.focus(), 50);
    return;
  }
  if (!raw?.trim()) {
    showPage("manual");
    setError(t("add.errClipboardEmpty"));
    setTimeout(() => $("add-modal-url")?.focus(), 50);
    return;
  }
  try {
    const res = await importAddInput(raw);
    await onCommitCb?.(res);
    closeModal();
  } catch (e) {
    showPage("manual");
    $("add-modal-url").value = raw;
    setError(e?.message || String(e));
  }
}

export function openAddModal({ prefillUrl, prefillName } = {}) {
  openModal();
  if (prefillUrl) {
    showPage("manual");
    const u = $("add-modal-url");
    if (u) u.value = prefillUrl;
    const n = $("add-modal-name");
    if (n && prefillName) n.value = prefillName;
    setTimeout(() => $("add-modal-submit")?.focus(), 50);
  }
}
