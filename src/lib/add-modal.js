// Ninety · Add Profile Modal controller
// Одна карточка, которая растёт. Выбор режима убран: тип ввода определяется
// сам и показывается ДО нажатия «Добавить».

import { detectAddInput, addSubscriptionFromUrl, parseSubscriptionBody } from "/lib/subscriptions.js";
import { addProfileFromVless, addTrustTunnelFromToml } from "/lib/singbox.js";
import { t } from "/lib/i18n/index.js";
import { escapeHtml } from "/lib/esc.js";
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

const SVG = (p, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const DET_ICONS = {
  empty:     SVG('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  config:    SVG('<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>'),
  list:      SVG('<path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/>'),
  "tt-toml": SVG('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  unknown:   SVG('<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
};
DET_ICONS.url = DET_ICONS.empty;

// Полоса распознавания — сердце экрана: говорит, что именно будет создано.
function setDetection(kind, kickerKey, infoHtml) {
  const box = $("add-modal-det");
  if (!box) return;
  box.dataset.kind = kind;
  const ico = $("add-modal-det-ico");
  const kicker = $("add-modal-det-kind");
  const info = $("add-modal-det-info");
  if (ico) ico.innerHTML = DET_ICONS[kind] || DET_ICONS.empty;
  if (kicker) kicker.textContent = t(kickerKey);
  if (info) info.innerHTML = infoHtml;
}

function hostOf(raw) {
  try { return new URL(String(raw).replace(/^[a-z0-9+.-]+:/i, "https:")).host; }
  catch { return ""; }
}

function describeInput(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    setDetection("empty", "add.detEmptyK", escapeHtml(t("add.detEmptyD")));
    return { ok: false, kind: "empty", host: "" };
  }
  const d = detectAddInput(s);
  if (d.kind === "url") {
    const host = hostOf(d.url) || d.url;
    setDetection("url", "add.detUrlK", `<b>${escapeHtml(host)}</b><s>·</s>${escapeHtml(t("add.detUrlD"))}`);
    return { ok: true, kind: "url", host };
  }
  if (d.kind === "config") {
    const proto = s.split("://")[0].toUpperCase();
    const host = hostOf(s);
    let sec;
    try { sec = (new URL(s.replace(/^[a-z0-9+.-]+:/i, "https:")).searchParams.get("security") || "").toUpperCase(); } catch { sec = ""; }
    setDetection("config", "add.detConfigK",
      `<b>${escapeHtml(proto)}</b>${sec ? `<s>·</s>${escapeHtml(sec)}` : ""}${host ? `<s>·</s>${escapeHtml(host)}` : ""}`);
    return { ok: true, kind: "config", host };
  }
  if (d.kind === "list") {
    const hits = String(d.content || "").match(/\b([a-z0-9+]+):\/\//gi) || [];
    const by = {};
    hits.forEach(u => { const p = u.replace("://", "").toUpperCase(); by[p] = (by[p] || 0) + 1; });
    const parts = Object.entries(by).map(([p, c]) => `${p} ${c}`).join(" · ");
    setDetection("list", "add.detListK",
      `<b>${hits.length}</b> ${escapeHtml(t("add.detListD"))}${parts ? `<s>·</s>${escapeHtml(parts)}` : ""}`);
    return { ok: true, kind: "list", host: "" };
  }
  if (d.kind === "tt-toml") {
    setDetection("tt-toml", "add.detTomlK", escapeHtml(t("add.detTomlD")));
    return { ok: true, kind: "tt-toml", host: "" };
  }
  setDetection("unknown", "add.detUnknownK", escapeHtml(t("add.detUnknownD")));
  return { ok: false, kind: "unknown", host: "" };
}

function refreshDetection() {
  const res = describeInput($("add-modal-url")?.value || "");
  const submit = $("add-modal-submit");
  if (submit) submit.disabled = !res.ok;
  const name = $("add-modal-name");
  if (name && !name.dataset.touched) name.placeholder = res.host || t("add.phNameAuto");
  return res;
}

function setBusy(on, kickerKey) {
  const bar = $("add-modal-det-bar");
  if (bar) bar.hidden = !on;
  if (on && kickerKey) {
    const kicker = $("add-modal-det-kind");
    if (kicker) kicker.textContent = t(kickerKey);
  }
  const submit = $("add-modal-submit");
  const cancel = $("add-modal-cancel");
  if (submit) submit.disabled = on;
  if (cancel) cancel.disabled = on;
}

function setError(msg) {
  if (!msg) return;
  setBusy(false);
  setDetection("unknown", "add.detErrorK", escapeHtml(msg));
  const submit = $("add-modal-submit");
  if (submit) submit.disabled = false;
}

function updateAdvancedHint() {
  const hours = Number($("add-modal-interval")?.value) || 0;
  const name = $("add-modal-name")?.value.trim();
  const hint = $("add-modal-adv-hint");
  if (hint) {
    hint.textContent = `${name || t("add.hintDefaultName")} · ${hours === 0 ? t("add.hintManual") : t("add.hintEvery", { v: intervalLabel(hours) })}`;
  }
  const val = $("add-modal-interval-val");
  if (val) {
    val.innerHTML = hours === 0
      ? `<span class="n-unit" style="margin:0">${escapeHtml(t("add.intervalAuto"))}</span>`
      : `${hours < 24 ? hours : Math.floor(hours / 24)}<span class="n-unit">${escapeHtml(hours < 24 ? t("add.unitH") : t("add.unitD"))}</span>`;
  }
}

function openModal() {
  const m = $("add-modal");
  if (!m) return;
  m.hidden = false;
  setBusy(false);
  $("add-modal-adv")?.setAttribute("aria-expanded", "false");
  refreshDetection();
  updateAdvancedHint();
  document.addEventListener("keydown", onKey);
  setTimeout(() => $("add-modal-url")?.focus(), 30);
}

function closeModal() {
  const m = $("add-modal");
  if (!m) return;
  m.hidden = true;
  setBusy(false);
  document.removeEventListener("keydown", onKey);
  const u = $("add-modal-url"); if (u) u.value = "";
  const n = $("add-modal-name"); if (n) { n.value = ""; delete n.dataset.touched; }
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
  setBusy(true, "add.detLoadingSub");
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
  $("add-modal-cancel")?.addEventListener("click", closeModal);

  $("add-modal-url")?.addEventListener("input", refreshDetection);
  $("add-modal-name")?.addEventListener("input", (e) => {
    e.target.dataset.touched = "1";
    updateAdvancedHint();
  });

  $("add-modal-paste")?.addEventListener("click", () => void doClipboard());
  $("add-modal-file-btn")?.addEventListener("click", () => $("add-modal-file")?.click());

  // Раскрытие «Название и автообновление» — на месте, без смены страницы.
  $("add-modal-adv")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    b.setAttribute("aria-expanded", b.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });

  // Импорт файла (TrustTunnel .toml): кладём текст в то же поле, чтобы
  // пользователь увидел, что распозналось, до подтверждения.
  $("add-modal-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const input = $("add-modal-url");
      if (input) input.value = text;
      const name = $("add-modal-name");
      if (name && !name.dataset.touched) { name.value = file.name.replace(/\.[^.]+$/, ""); name.dataset.touched = "1"; }
      refreshDetection();
      updateAdvancedHint();
    } catch (err) {
      setError(err?.message || String(err));
    }
  });

  $("add-modal-interval")?.addEventListener("input", updateAdvancedHint);

  $("add-modal-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("add-modal-submit")?.click(); }
  });
  $("add-modal-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("add-modal-submit")?.click(); }
  });

  $("add-modal-submit")?.addEventListener("click", async () => {
    const raw = $("add-modal-url")?.value.trim();
    const name = $("add-modal-name")?.value.trim();
    const intervalHours = Number($("add-modal-interval")?.value) || 0;
    if (!raw) { setError(t("add.errNeedUrl")); return; }
    const kind = describeInput(raw).kind;
    setBusy(true, kind === "url" ? "add.detLoadingSub" : "add.detAdding");
    try {
      const res = await importAddInput(raw, { name, intervalHours });
      await onCommitCb?.(res);
      closeModal();
    } catch (e) {
      setError(e?.message || String(e));
    }
  });
}

// Буфер попадает в поле, а не сразу в импорт: пользователь видит, что
// распозналось, и может поправить до подтверждения.
async function doClipboard() {
  let raw;
  try {
    raw = await navigator.clipboard.readText();
  } catch {
    setError(t("add.errNoClipboard"));
    return;
  }
  if (!raw?.trim()) { setError(t("add.errClipboardEmpty")); return; }
  const input = $("add-modal-url");
  if (input) { input.value = raw.trim(); input.focus(); }
  refreshDetection();
  updateAdvancedHint();
}

export function openAddModal({ prefillUrl, prefillName } = {}) {
  openModal();
  if (prefillUrl) {
    const u = $("add-modal-url");
    if (u) u.value = prefillUrl;
    const n = $("add-modal-name");
    if (n && prefillName) { n.value = prefillName; n.dataset.touched = "1"; }
    refreshDetection();
    updateAdvancedHint();
    setTimeout(() => $("add-modal-submit")?.focus(), 50);
  }
}
