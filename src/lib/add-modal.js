// Ninety · Add Profile Modal controller
// One card that grows. The mode picker is gone: the input type is detected
// automatically and shown BEFORE pressing "Add".

import {
  detectAddInput,
  addSubscriptionFromUrl,
  findSubscriptionByUrl,
  loadSubscriptions,
  parseSubscriptionEntries,
  refreshSubscription,
  updateSubscription,
} from "/lib/subscriptions.js";
import { askEnableHwid } from "/lib/hwid-prompt.js";
import {
  configFormatName,
  parseClientConfig,
  unsupportedFormatMessage,
} from "/lib/config-import.js";
import { partitionNodes } from "/lib/node-validation.js";
import {
  addParsedProfile,
  addProfileFromVless,
  addOpenvpnFromConf,
  addTrustTunnelFromToml,
  addWireguardFromConf,
} from "/lib/singbox.js";
import { t, tn } from "/lib/i18n/index.js";
import { escapeHtml } from "/lib/esc.js";
import { parseAmneziaKey } from "/lib/amnezia-key.js";
import { openvpnNeedsCredentials } from "/lib/protocol-parsers.js";
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
  "wg-conf": SVG('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9 12h6"/>'),
};
DET_ICONS["client-config"] = SVG('<path d="M20 7h-9m3 10H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>');
DET_ICONS.url = DET_ICONS.empty;
DET_ICONS.duplicate = DET_ICONS.unknown;
DET_ICONS["ovpn-conf"] = DET_ICONS["wg-conf"];

// Parsing a config means JSON.parse of a foreign file, and the recognition strip
// is recomputed on every keystroke. We keep the result of the last
// parse: the user pastes a config rather than typing it, and parsing
// the same text again gives nothing.
let lastConfigParse = { text: null, result: null };
function parseConfigCached(text) {
  if (lastConfigParse.text === text) return lastConfigParse.result;
  const parsed = parseClientConfig(text);
  const { usable, skipped } = partitionNodes(parsed.profiles);
  const result = { profiles: usable, skipped: parsed.skipped + skipped.length };
  lastConfigParse = { text, result };
  return result;
}

// The subscription list for the duplicate check is taken when the window opens: while it's
// open, the list doesn't change, and rereading storage on every keystroke
// in the address field means parsing all saved servers on every character.
let knownSubscriptions = [];
function refreshKnownSubscriptions() {
  try { knownSubscriptions = loadSubscriptions(); }
  catch { knownSubscriptions = []; }
}

// The recognition strip is the heart of the screen: it says exactly what will be created.
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
    // A duplicate is visible before pressing "Add", not after the request to the panel.
    const duplicate = findSubscriptionByUrl(d.url, knownSubscriptions);
    if (duplicate) {
      const name = duplicate.name || t("subs.subFallback");
      setDetection("duplicate", "add.detDuplicateK",
        `<b>${escapeHtml(name)}</b><s>·</s>${escapeHtml(t("add.detDuplicateD"))}`);
      return { ok: true, kind: "url", host, duplicate: duplicate.id };
    }
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
      `<b>${escapeHtml(tn("add.detListN", hits.length))}</b>${parts ? `<s>·</s>${escapeHtml(parts)}` : ""}`);
    return { ok: true, kind: "list", host: "" };
  }
  if (d.kind === "client-config") {
    // A format we have nothing to read with (Clash) is named directly: the user
    // needs to know which of the panel's links to take instead of this one.
    const unreadable = unsupportedFormatMessage(d.format);
    if (unreadable) {
      setDetection("unknown", "add.detUnknownK", escapeHtml(unreadable));
      return { ok: false, kind: "client-config", host: "" };
    }
    const { profiles } = parseConfigCached(d.content);
    if (!profiles.length) {
      setDetection("unknown", "add.detUnknownK", escapeHtml(t("add.errNoConfigs")));
      return { ok: false, kind: "client-config", host: "" };
    }
    // How many nodes weren't taken is reported after adding (msgListSkipped):
    // in the recognition strip what matters is what exactly was recognized.
    setDetection("client-config", "add.detSbConfigK",
      `<b>${escapeHtml(tn("add.detListN", profiles.length))}</b><s>·</s>${escapeHtml(configFormatName(d.format))}`);
    return { ok: true, kind: "client-config", host: "" };
  }
  if (d.kind === "tt-toml") {
    setDetection("tt-toml", "add.detTomlK", escapeHtml(t("add.detTomlD")));
    return { ok: true, kind: "tt-toml", host: "" };
  }
  if (d.kind === "amnezia-key") {
    setDetection("wg-conf", "add.detAmneziaK", escapeHtml(t("add.detAmneziaD")));
    return { ok: true, kind: "amnezia-key", host: "" };
  }
  if (d.kind === "wg-conf") {
    // We show the peer endpoint: that's how the user recognizes their file.
    const peer = s.match(/^\s*Endpoint\s*=\s*(\S+)/im)?.[1] || "";
    const amnezia = /^\s*(?:Jc|H1|I1|S1)\s*=/im.test(s);
    setDetection("wg-conf", amnezia ? "add.detWgAwgK" : "add.detWgK",
      `${peer ? `<b>${escapeHtml(peer)}</b><s>·</s>` : ""}${escapeHtml(t("add.detWgD"))}`);
    return { ok: true, kind: "wg-conf", host: peer.split(":")[0] || "" };
  }
  if (d.kind === "ovpn-conf") {
    const remote = d.content.match(/^\s*remote\s+(?:"([^"]+)"|'([^']+)'|(\S+))/im);
    const host = remote?.[1] || remote?.[2] || remote?.[3] || "";
    setDetection("ovpn-conf", "add.detOvpnK",
      `${host ? `<b>${escapeHtml(host)}</b><s>·</s>` : ""}${escapeHtml(t("add.detOvpnD"))}`);
    return { ok: true, kind: "ovpn-conf", host, content: d.content };
  }
  setDetection("unknown", "add.detUnknownK", escapeHtml(t("add.detUnknownD")));
  return { ok: false, kind: "unknown", host: "" };
}

let credentialsProbe = 0;
let credentialsText = "";

function showOpenvpnCredentials(show, text = "") {
  const box = $("add-modal-credentials");
  if (box) box.hidden = !show;
  // One profile's password must not carry over to another after the text is replaced.
  if (!show || credentialsText !== text) {
    for (const id of ["add-modal-username", "add-modal-password"]) {
      const input = $(id);
      if (input) input.value = "";
    }
  }
  credentialsText = show ? text : "";
}

function refreshDetection() {
  const raw = $("add-modal-url")?.value || "";
  const res = describeInput(raw);
  const submit = $("add-modal-submit");
  if (submit) submit.disabled = !res.ok;
  const name = $("add-modal-name");
  if (name && !name.dataset.touched) name.placeholder = res.host || t("add.phNameAuto");
  const probe = ++credentialsProbe;
  if (res.kind === "ovpn-conf") {
    showOpenvpnCredentials(openvpnNeedsCredentials(res.content), raw);
  } else if (res.kind === "amnezia-key") {
    if (credentialsText !== raw) showOpenvpnCredentials(false);
    // The key contents are unpacked asynchronously: a stale result
    // must not change the fields after the window is closed or different text is pasted.
    void parseAmneziaKey(raw).then(() => {
      if (probe === credentialsProbe) showOpenvpnCredentials(false);
    }).catch(err => {
      if (probe === credentialsProbe) showOpenvpnCredentials(err?.code === "openvpn-credentials", raw);
    });
  } else {
    showOpenvpnCredentials(false);
  }
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
    hint.textContent = `${name || t("add.hintDefaultName")} · ${hours === 0 ? t("add.intervalAuto") : t("add.hintEvery", { v: intervalLabel(hours) })}`;
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
  refreshKnownSubscriptions();
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
  credentialsProbe++;
  showOpenvpnCredentials(false);
  // One subscription's interval must not silently carry over to the next one.
  const i = $("add-modal-interval"); if (i) i.value = "0";
  updateAdvancedHint();
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

  if (decision.kind === "wg-conf") {
    const { id, profile, ignored } = addWireguardFromConf(decision.content, userOverride.name || "");
    return {
      type: "config",
      message: t("add.msgWg", { name: profile.name }),
      source: { kind: "single", id },
      // Lines that aren't in the profile are the difference between how the file
      // works here and in the client it came from. Staying silent about it is not allowed;
      // the caller shows it, just like the skipped counter for a list.
      ignored,
    };
  }

  if (decision.kind === "ovpn-conf") {
    const { id, profile, ignored } = addOpenvpnFromConf(decision.content, userOverride.name || "", userOverride);
    return {
      type: "config",
      message: t("add.msgOvpn", { name: profile.name }),
      source: { kind: "single", id },
      ignored,
      ignoredKind: "ovpn",
    };
  }

  if (decision.kind === "amnezia-key") {
    // AmneziaVPN key: it contains ready .conf / Xray config files. Non-portable
    // lines and unsupported protocols are shown by the caller, as with .conf.
    const { profiles, ignored, unsupported, name } = await parseAmneziaKey(decision.content, userOverride.name || "", userOverride);
    const added = profiles.map(profile => addParsedProfile(profile));
    return {
      type: profiles.length > 1 ? "list" : "config",
      message: t("add.msgAmnezia", { name }),
      source: { kind: "single", id: added[0].id },
      ignored: [...ignored, ...unsupported],
    };
  }

  // A ready client config: we take only the servers from it. The nodes arrive already
  // parsed — some of them (WireGuard) can't be turned into a link at all,
  // so we store objects, not raw.
  if (decision.kind === "client-config") {
    const unreadable = unsupportedFormatMessage(decision.format);
    if (unreadable) throw new Error(unreadable);
    const { profiles, skipped } = parseConfigCached(decision.content);
    if (profiles.length === 0) throw new Error(t("add.errNoConfigs"));
    const added = profiles.map(profile => addParsedProfile(profile));
    return {
      type: "list",
      message: skipped
        ? t("add.msgListSkipped", { n: profiles.length, skipped })
        : t("add.msgList", { n: profiles.length }),
      source: { kind: "single", id: added[0].id },
      skipped,
    };
  }

  if (decision.kind === "list") {
    // The skipped counter is taken the same way as for a subscription: the link list
    // rejects entries by the same rules, and staying silent about them means
    // showing "Imported 8 configs" where the user pasted 12.
    const { profiles, skipped } = parseSubscriptionEntries(decision.content);
    if (profiles.length === 0) throw new Error(t("add.errNoConfigs"));
    const added = profiles.map(p => addProfileFromVless(p.raw));
    // Deterministically activate the first profile of exactly this import.
    return {
      type: "list",
      message: skipped
        ? t("add.msgListSkipped", { n: profiles.length, skipped })
        : t("add.msgList", { n: profiles.length }),
      source: { kind: "single", id: added[0].id },
      skipped,
    };
  }

  // kind === "url" → subscription. The same link a second time doesn't create a second copy:
  // we show the already added subscription and honestly say there is nothing new.
  const already = findSubscriptionByUrl(decision.url);
  if (already) {
    return {
      type: "sub",
      duplicate: true,
      message: t("add.msgDuplicateSub", { name: already.name || t("subs.subFallback") }),
      source: { kind: "sub", id: already.id },
      activate: false,
    };
  }

  // intervalHours from the "Auto-update" slider
  // (0 = auto/by the panel header); passed only when adding manually.
  setBusy(true, "add.detLoadingSub");
  let sub;
  try {
    sub = await addSubscriptionFromUrl(decision.url, userOverride.name || "", userOverride.intervalHours);
  } catch (err) {
    // A panel with a device limit returns a 404 or a single placeholder node without the HWID:
    // the subscription looks broken, although it's simply missing the header.
    if (!err?.hwid?.required || !(await askEnableHwid())) throw err;
    sub = await addSubscriptionFromUrl(decision.url, userOverride.name || "", userOverride.intervalHours, { hwid: true });
  }
  // The placeholder may also have parsed as a regular server — then the list "was added"
  // but consists of it alone, and we still need to ask.
  if (!sub.hwid && sub.hwidSignal?.required && await askEnableHwid()) {
    updateSubscription(sub.id, { hwid: true, hwidPromptDismissed: true });
    sub = await refreshSubscription(sub.id);
  }
  if (sub.hwidSignal?.limitReached) toast(t("hwid.limitReached"), "warn", 7000);
  // http:// — the subscription address and keys travel in plain text (visible to the ISP,
  // and every refresh too). We don't block it (http panels exist), but we warn.
  if (/^http:\/\//i.test(decision.url)) toast(t("add.httpWarn"), "warn", 6000);
  // Some of the panel's servers aren't accepted by the core; they were already dropped during parsing —
  // we say so directly, otherwise the counter silently diverges from the link's contents.
  if (sub.skipped > 0) toast(t("subs.skippedNote", { n: sub.skipped }), "warn", 6000);
  return {
    type: "sub",
    message: t("add.msgSub", { name: sub.name, srv: tn("prof.srvN", sub.profiles.length) }),
    source: { kind: "sub", id: sub.id },
    // Adding ≠ switching: only the user changes the active subscription.
    activate: false,
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

  // The "Name and auto-update" disclosure expands in place, without changing the page.
  $("add-modal-adv")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    b.setAttribute("aria-expanded", b.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });

  // Importing a file: we put the text into the same field so that
  // the user sees what was recognized before confirming.
  $("add-modal-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await readProfileFile(file);
  });
  $("add-modal")?.addEventListener("dragover", (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  $("add-modal")?.addEventListener("drop", async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    await readProfileFile(file);
  });

  $("add-modal-interval")?.addEventListener("input", updateAdvancedHint);

  $("add-modal-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("add-modal-submit")?.click(); }
  });
  $("add-modal-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("add-modal-submit")?.click(); }
  });
  for (const id of ["add-modal-username", "add-modal-password"]) {
    $(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("add-modal-submit")?.click(); }
    });
  }

  $("add-modal-submit")?.addEventListener("click", async () => {
    const raw = $("add-modal-url")?.value || "";
    const name = $("add-modal-name")?.value.trim();
    const username = $("add-modal-username")?.value || "";
    const password = $("add-modal-password")?.value || "";
    const intervalHours = Number($("add-modal-interval")?.value) || 0;
    if (!raw.trim()) { setError(t("add.errNeedUrl")); return; }
    const kind = describeInput(raw).kind;
    setBusy(true, kind === "url" ? "add.detLoadingSub" : "add.detAdding");
    try {
      const res = await importAddInput(raw, { name, intervalHours, username, password });
      if (res.ignored?.length) {
        toast(t(res.ignoredKind === "ovpn" ? "add.ovpnIgnored" : "add.wgIgnored", { keys: res.ignored.join(", ") }), "warn", 8000);
      }
      await onCommitCb?.(res);
      closeModal();
    } catch (e) {
      if (e?.code === "openvpn-credentials") showOpenvpnCredentials(true, raw);
      setError(e?.message || String(e));
    }
  });
}

async function readProfileFile(file) {
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
}

// The clipboard goes into the field, not straight into the import: the user sees what
// was recognized and can correct it before confirming.
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
  if (input) { input.value = raw; input.focus(); }
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
