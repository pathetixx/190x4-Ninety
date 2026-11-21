// Ninety · "Share" — copying the URL, exporting sing-box JSON, the QR code.

import { buildConfig, getMode, lanInboundPolicy, profileProto, wireguardConfText } from "/lib/singbox.js";
import { loadOptions } from "/lib/options.js";
import qrcode from "/vendor/qrcode.mjs";
import { t, tn } from "/lib/i18n/index.js";
import { escapeAttr } from "/lib/esc.js";
import { openvpnConfText } from "/lib/protocol-parsers.js";

export async function copySubscriptionUrl(sub, toast) {
  if (!sub?.url) {
    toast?.(t("share.noUrl"), "error", 1800);
    return;
  }
  try {
    await navigator.clipboard.writeText(sub.url);
    toast?.(t("share.urlCopied"), "success", 1400);
  } catch {
    toast?.(t("share.copyFailed"), "error", 1800);
  }
}

// QR modal for a subscription. The URL is long (200+ characters) — typeNumber=0 (auto),
// errorCorrectionLevel "M" (15% redundancy — a compromise between density
// and robustness against folding/glare on a phone screen).
export function openQRModal(sub) {
  if (!sub?.url) return;

  closeQRModal();

  const card = document.createElement("div");
  card.className = "qr-modal";
  card.innerHTML = `
    <div class="qr-modal__backdrop"></div>
    <div class="qr-modal__card">
      <div class="qr-modal__head">
        <span class="qr-modal__kicker">${t("share.qrKicker")}</span>
        <button class="qr-modal__close" type="button" aria-label="${escapeAttr(t("share.close"))}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <h3 class="qr-modal__name"></h3>
      <div class="qr-modal__qr-wrap" data-qr></div>
      <p class="qr-modal__hint">${t("share.qrHint")}</p>
      <div class="qr-modal__actions">
        <button class="qr-modal__btn" type="button" data-copy>${t("share.copyUrl")}</button>
      </div>
    </div>
  `;

  card.querySelector(".qr-modal__name").textContent = sub.name || t("share.subFallback");

  try {
    const qr = qrcode(0, "M");
    qr.addData(sub.url);
    qr.make();
    card.querySelector("[data-qr]").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch (e) {
    card.querySelector("[data-qr]").textContent = t("share.qrError", { err: e?.message || e });
  }

  const close = () => closeQRModal();
  card.querySelector(".qr-modal__backdrop").addEventListener("click", close);
  card.querySelector(".qr-modal__close").addEventListener("click", close);
  card.querySelector("[data-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(sub.url);
      card.querySelector("[data-copy]").textContent = t("share.copied");
      setTimeout(close, 700);
    } catch {}
  });
  document.addEventListener("keydown", onQRKey);

  document.body.appendChild(card);
}

function closeQRModal() {
  document.querySelectorAll(".qr-modal").forEach(el => el.remove());
  document.removeEventListener("keydown", onQRKey);
}

function onQRKey(e) {
  if (e.key === "Escape") closeQRModal();
}

// Transports the app serves with a separate core on a local
// socks bridge: there's nothing to reproduce them with in a standalone config.
const BRIDGE_ONLY_TYPES = new Set(["xhttp", "kcp"]);
// The same, but at the protocol level: naive and TrustTunnel are brought up by a separate
// sidecar client (a ready Xray outbound by the local xray), while the config gets
// socks on 127.0.0.1. Without this check
// the export produced an outwardly valid file that leads the recipient to their own
// localhost — i.e. silently broken.
const BRIDGE_ONLY_PROTOS = new Set(["naive", "trusttunnel", "xray"]);

function isBridgeOnly(node) {
  return BRIDGE_ONLY_TYPES.has(node?.type) || BRIDGE_ONLY_PROTOS.has(profileProto(node));
}

// WireGuard has no share link — people exchange a file. We return the same .conf
// that we accepted: with it the profile opens both in Amnezia and in wg-quick.
export async function copyWireguardConf(profile, toast) {
  if (profileProto(profile) !== "wireguard") {
    toast?.(t("share.confNotWireguard"), "error", 2000);
    return;
  }
  try {
    await navigator.clipboard.writeText(wireguardConfText(profile));
    toast?.(t("share.confCopied"), "success", 2000);
  } catch (e) {
    toast?.(t("share.exportError", { err: e?.message || e }), "error", 2500);
  }
}

// We return the original .ovpn: certificates, keys and provider settings
// stay usable for moving to another OpenVPN client.
export async function copyOpenvpnConf(profile, toast) {
  if (profileProto(profile) !== "openvpn") {
    toast?.(t("share.ovpnNotOpenvpn"), "error", 2000);
    return;
  }
  try {
    await navigator.clipboard.writeText(openvpnConfText(profile));
    toast?.(t("share.ovpnCopied"), "success", 2000);
  } catch (e) {
    toast?.(t("share.exportError", { err: e?.message || e }), "error", 2500);
  }
}

export async function exportSingboxJson(source, toast) {
  if (!source) {
    toast?.(t("share.noSource"), "error", 1800);
    return;
  }
  try {
    // The export is a self-contained config, without the loopback bridges the app
    // brings up itself. Nodes that live only behind such a bridge don't get into it:
    // the core doesn't support their transport, and a config with them simply wouldn't start.
    // We skip them and say so, rather than silently handing over a broken file.
    const all = source.kind === "sub" ? (source.nodes || []) : [source.profile];
    const exportable = all.filter((node) => !isBridgeOnly(node));
    const skipped = all.length - exportable.length;
    if (!exportable.length) {
      toast?.(t("share.exportNoNodes"), "error", 2500);
      return;
    }
    // The login/password pair is substituted into the LAN inbound only by the backend at launch. In a file
    // such an inbound would stay open to the whole network, so it doesn't go into the export.
    const options = loadOptions();
    const { config } = buildConfig({
      source: source.kind === "sub" ? { ...source, nodes: exportable } : source,
      mode: getMode(),
      options: lanInboundPolicy(options.inbound) === "password"
        ? { ...options, inbound: { ...options.inbound, allowConnectionFromLan: false } }
        : options,
    });
    const json = JSON.stringify(config, null, 2);
    await navigator.clipboard.writeText(json);
    const kb = (json.length / 1024).toFixed(1);
    if (skipped) {
      toast?.(t("share.exportedSkipped", { kb, srv: tn("prof.srvN", skipped) }), "success", 3000);
    } else {
      toast?.(t("share.exported", { kb }), "success", 2000);
    }
  } catch (e) {
    toast?.(t("share.exportError", { err: e?.message || e }), "error", 2500);
  }
}
