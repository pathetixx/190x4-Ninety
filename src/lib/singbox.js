// Ninety · sing-box 1.13.x config builder
// Protocol parsers живут в protocol-parsers.js; здесь builder + storage-фасад.

import { DEFAULT_OPTIONS } from "/lib/options.js";
import { t } from "/lib/i18n/index.js";
import { uid } from "/lib/uid.js";
import { hashRuntimeValue, stableNodeId } from "/lib/runtime-identity.js";
import {
  resolveRuntimePrivacyPolicy,
  selectStrictPrivacyCandidate,
  StrictPrivacyPolicyError,
} from "/lib/strict-privacy-policy.js";
import {
  parsePort,
  safeAtob,
  splitHostPort,
} from "/lib/url-helpers.js";
import { parseLink, parseTrustTunnelToml, profileProto } from "/lib/protocol-parsers.js";
import { isNodeQuarantined } from "/lib/node-quarantine.js";
import {
  nodeConfigIssue,
  normalizeFingerprint,
  normalizeFlow,
  normalizeRealityPublicKey,
  usableNodes,
} from "/lib/node-validation.js";
import {
  getActiveKindFromStore,
  getActiveProfileIdFromStore,
  getActiveSubscriptionIdFromStore,
  loadProfilesFromStore,
  loadSubscriptionsFromStore,
  saveProfilesToStore,
  setActiveKindInStore,
  setActiveProfileIdInStore,
} from "/lib/profile-store.js";

export {
  parseHysteria2,
  parseLink,
  parseNaive,
  parseShadowsocks,
  parseTrojan,
  parseTrustTunnelDeepLink,
  parseTrustTunnelToml,
  parseTuic,
  parseVless,
  parseVmess,
  profileProto,
} from "/lib/protocol-parsers.js";

const MODE_KEY = "ninety.mode";
export const ENGINE_PROCESS_NAMES = [
  "sing-box.exe",
  "sing-box-x86_64-pc-windows-msvc.exe",
  "xray.exe",
  "xray-x86_64-pc-windows-msvc.exe",
  "naive.exe",
  "naive-x86_64-pc-windows-msvc.exe",
  "trusttunnel_client.exe",
  "trusttunnel_client-x86_64-pc-windows-msvc.exe",
];

// Списки правил — из первоисточников, а не из чужих зеркал.
const GEOSITE_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
const GEOIP_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";
// Списки вредоносного/фишинга/майнеров ведёт отдельный проект: ни в sing-geosite,
// ни в sing-geoip таких категорий нет.
const SECURITY_BASE = "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set";

const BLOCK_AD_SETS = [
  ["geosite-ads", `${GEOSITE_BASE}/geosite-category-ads-all.srs`],
  ["geosite-malware", `${SECURITY_BASE}/geosite-malware.srs`],
  ["geosite-phishing", `${SECURITY_BASE}/geosite-phishing.srs`],
  ["geosite-cryptominers", `${SECURITY_BASE}/geosite-cryptominers.srs`],
  ["geoip-malware", `${SECURITY_BASE}/geoip-malware.srs`],
  ["geoip-phishing", `${SECURITY_BASE}/geoip-phishing.srs`],
];

// Страновой geosite существует не для каждого региона — только эти три.
// Для остальных правило по доменам не выпускаем вовсе: маршрутизация опирается
// на geoip. Раньше сюда подставлялось зеркало, где для tr лежал файл с доменами
// госсайтов РФ, а для by не лежало ничего — правило молча не работало.
const COUNTRY_GEOSITE = {
  ru: "geosite-category-ru",
  cn: "geosite-cn",
  ir: "geosite-category-ir",
};
// Доменные суффиксы Discord — дублируют geosite-discord на случай, если правило
// не подтянулось, и ловят по sniffed-SNI. Только домены Discord уходят в direct
// (без IP-листа: кривой CIDR увёл бы чужой трафик мимо VPN = утечка).
const DISCORD_SUFFIXES = [
  "discord.com", "discordapp.com", "discordapp.net", "discord.gg",
  "discord.media", "discord.dev", "discordstatus.com", "dis.gd",
];
// Десктопные клиенты Discord. Голосовой медиа-поток идёт по UDP на голый IP:
// домена в пакете нет, sniff его не достаёт (там не TLS и не QUIC, а RTP +
// IP discovery), доменные правила по нему не срабатывают. Матчинг по процессу —
// единственный способ увести голос в direct, не выдумывая CIDR-лист Discord.
const DISCORD_PROCESS_NAMES = [
  "Discord.exe", "DiscordCanary.exe", "DiscordPTB.exe", "DiscordDevelopment.exe",
];

const IPV6_STRATEGY_MAP = {
  disable: "ipv4_only",
  enable: "prefer_ipv4",
  prefer: "prefer_ipv6",
  only: "ipv6_only",
};

// ── общие части (TLS, transport) ───────────────────────────
function buildTls(p) {
  // Для vless reality/tls; vmess/trojan/tuic — обычный TLS
  const tlsMode = p.tlsMode || p.security; // vmess использует tlsMode, остальные security
  if (tlsMode !== "tls" && tlsMode !== "reality") return null;
  const tls = {
    enabled: true,
    server_name: p.sni,
    utls: { enabled: true, fingerprint: normalizeFingerprint(p.fp) },
  };
  if (p.alpn) tls.alpn = String(p.alpn).split(",").map(s => s.trim()).filter(Boolean);
  if (tlsMode === "reality") {
    // Панели отдают ключ и в обычном base64, и с паддингом, а ядро принимает
    // только base64url без «=». Нормализуем; заведомо нерабочий ключ отсеивает
    // nodeConfigIssue ещё до сборки.
    tls.reality = {
      enabled: true,
      public_key: normalizeRealityPublicKey(p.pbk) || p.pbk,
      short_id: p.sid,
    };
  }
  return tls;
}

// xhttp base-ключи, у которых имена json совпадают в Xray и форке sing-box.
const XHTTP_PASS_KEYS = [
  "host", "path", "headers", "xPaddingBytes", "noGRPCHeader", "noSSEHeader",
  "scMaxEachPostBytes", "scMinPostsIntervalMs", "scMaxBufferedPosts",
  "scStreamUpServerSecs", "xmux",
];

// Xray tlsSettings/realitySettings → OutboundTLSOptions форка sing-box.
function xrayTlsToSingbox(ds) {
  const sec = ds.security;
  if (sec !== "tls" && sec !== "reality") return null;
  const ts = ds.tlsSettings || ds.realitySettings || {};
  const tls = { enabled: true };
  const sni = ts.serverName || ts.server_name;
  if (sni) tls.server_name = sni;
  tls.utls = { enabled: true, fingerprint: normalizeFingerprint(ts.fingerprint) };
  const alpn = ts.alpn;
  if (Array.isArray(alpn) && alpn.length) tls.alpn = alpn;
  else if (typeof alpn === "string" && alpn) tls.alpn = alpn.split(",").map(s => s.trim()).filter(Boolean);
  if (ts.allowInsecure || ts.insecure) tls.insecure = true;
  if (sec === "reality") {
    const realityKey = ts.publicKey || ts.public_key || "";
    tls.reality = {
      enabled: true,
      public_key: normalizeRealityPublicKey(realityKey) || realityKey,
      short_id: ts.shortId || ts.short_id || "",
    };
  }
  return tls;
}

// Xray downloadSettings (StreamSettings) → V2RayXHTTPDownloadOptions форка.
// address→server, port→server_port, xhttpSettings.* → плоские base-поля, tls.
function xrayDownloadToSingbox(ds) {
  if (!ds || typeof ds !== "object") return null;
  const d = {};
  if (ds.address) d.server = String(ds.address);
  if (ds.port != null) d.server_port = Number(ds.port);
  const xs = (ds.xhttpSettings && typeof ds.xhttpSettings === "object") ? ds.xhttpSettings : {};
  for (const k of XHTTP_PASS_KEYS) if (xs[k] !== undefined) d[k] = xs[k];
  const tls = xrayTlsToSingbox(ds);
  if (tls) d.tls = tls;
  return Object.keys(d).length ? d : null;
}

// Безопасный мерж Xray-extra в xhttp-транспорт форка. Эмитим только
// поля, известные форку (иначе unknown-field роняет ВЕСЬ конфиг).
function mergeXhttpExtra(t, ex) {
  for (const k of XHTTP_PASS_KEYS) if (ex[k] !== undefined) t[k] = ex[k];
  if (ex.mode) t.mode = ex.mode;
  if (ex.downloadSettings) {
    const d = xrayDownloadToSingbox(ex.downloadSettings);
    if (d) t.downloadSettings = d;
  }
}

function buildTransport(p) {
  switch (p.type) {
    case "ws": {
      const t = { type: "ws" };
      if (p.path) t.path = p.path;
      if (p.host_header) t.headers = { Host: p.host_header };
      return t;
    }
    case "grpc": {
      const t = { type: "grpc" };
      if (p.serviceName) t.service_name = p.serviceName;
      return t;
    }
    case "http":
    case "h2": {
      const t = { type: "http" };
      if (p.path) t.path = p.path;
      if (p.host_header) t.host = p.host_header.split(",").map(s => s.trim());
      return t;
    }
    case "httpupgrade": {
      const t = { type: "httpupgrade" };
      if (p.host_header || p.sni) t.host = p.host_header || p.sni;
      if (p.path) t.path = p.path;
      return t;
    }
    case "quic":
      // У v2ray-QUIC в ядре нет опций: дополнительное шифрование транспорта из
      // Xray оно не реализует (такие ноды отсеивает nodeConfigIssue).
      return { type: "quic" };
    case "xhttp": {
      const t = { type: "xhttp" };
      if (p.path) t.path = p.path;
      if (p.host_header) t.host = p.host_header;
      if (p.mode) t.mode = p.mode;
      // extra={...} из ссылки несёт xhttp-подопции (xPaddingBytes,
      // scMaxEachPostBytes, downloadSettings, noGRPCHeader, headers, xmux…).
      // Без них download-канал уходит в дефолт и сервер рвёт handshake.
      // ВАЖНО: extra — в Xray-схеме. Скаляры и xmux по именам совпадают с
      // форком sing-box, но downloadSettings — это Xray StreamSettings
      // (address/port/security/xhttpSettings) и форк его не понимает.
      // Поэтому мержим только whitelisted-ключи и транслируем downloadSettings,
      // эмитя строго известные форку поля — иначе один узел роняет весь конфиг
      // (json: unknown field "address").
      if (p.extra) {
        try {
          const ex = JSON.parse(p.extra);
          if (ex && typeof ex === "object") mergeXhttpExtra(t, ex);
        } catch { /* битый extra — игнорируем, базовых полей достаточно */ }
      }
      // Ядро требует непустой mode, иначе падает весь конфиг
      // ("mode is not set" на этапе загрузки). auto — безопасный дефолт.
      if (!t.mode) t.mode = "auto";
      return t;
    }
    default:
      return null;
  }
}

function applyMux(out, options) {
  if (!options?.mux?.enable) return;
  out.multiplex = {
    enabled: true,
    protocol: options.mux.protocol || "h2mux",
    max_streams: options.mux.maxStreams || 8,
    padding: !!options.mux.padding,
  };
}

// TLS-фрагментация + tls_tricks.
// ВАЖНО: upstream 1.12 убрал experimental.tls_tricks и перенёс эти трюки в
// per-outbound tls{}: fragment / record_fragment / fragment_fallback_delay +
// tls.tls_tricks{ mixedcase_sni, padding_size }. Парсер 1.12+ строгий — любое
// неизвестное поле роняет ВЕСЬ конфиг (json: unknown field) и ядро не стартует
// (это и был баг «при включении ВПН перестаёт работать»). Пишем строго эти поля.
// Применяем только к прокси-outbound с TCP-TLS handshake; QUIC (hysteria2/tuic)
// сюда не доходит — те делают return раньше, фрагментация TLS-записей к ним
// неприменима.
function applyTlsTricks(out, options) {
  const t = options?.tlsTricks;
  if (!t || !out.tls?.enabled) return;
  if (t.enableFragment) {
    if (t.fragmentMode === "tcp") {
      // fragment и record_fragment взаимоисключающие — ставим что-то одно.
      out.tls.fragment = true;
      if (t.fragmentFallbackDelay) out.tls.fragment_fallback_delay = t.fragmentFallbackDelay;
    } else {
      out.tls.record_fragment = true;
    }
  }
  // Дальше — только tls_tricks. Фрагментация выше применима и к Reality, а вот
  // сами трюки переписывают ClientHello, который Reality собирает сам и поверх
  // которого запечатывает аутентификацию. При этом Reality и так шлёт побайтовый
  // отпечаток браузера с настоящим SNI — ради этого он и существует. Ядро на
  // такой конфиг отвечает ошибкой, поэтому не шлём.
  if (out.tls.reality?.enabled) return;
  const tricks = {};
  if (t.enablePadding) {
    const ps = t.paddingSize || { from: 100, to: 900 };
    tricks.padding_size = `${ps.from}-${ps.to}`;
  }
  if (t.mixedSniCase) tricks.mixedcase_sni = true;
  if (Object.keys(tricks).length) out.tls.tls_tricks = tricks;
}

// ── outbound dispatcher по протоколу ───────────────────────
function buildOutbound(p, options) {
  const proto = profileProto(p);
  const base = { tag: "proxy", server: p.host, server_port: p.port };
  let out;
  switch (proto) {
    case "vmess": {
      out = {
        ...base,
        type: "vmess",
        uuid: p.uuid,
        // Реестры ядра регистрозависимы: имя шифра/метода из ссылки приводим к
        // нижнему регистру, иначе «AES-128-GCM» роняет конфиг как неизвестное.
        security: String(p.security || "auto").toLowerCase(),
        alter_id: p.alterId || 0,
        packet_encoding: "xudp",
      };
      break;
    }
    case "trojan": {
      out = { ...base, type: "trojan", password: p.password };
      break;
    }
    case "shadowsocks": {
      out = {
        ...base,
        type: "shadowsocks",
        method: String(p.method || "").toLowerCase(),
        password: p.password,
      };
      if (p.plugin) {
        out.plugin = p.plugin;
        if (p.plugin_opts) out.plugin_opts = p.plugin_opts;
      }
      break;
    }
    case "hysteria2": {
      out = {
        ...base,
        type: "hysteria2",
        password: p.password,
      };
      if (p.upMbps) out.up_mbps = p.upMbps;
      if (p.downMbps) out.down_mbps = p.downMbps;
      if (p.obfs) {
        out.obfs = { type: String(p.obfs).toLowerCase() };
        if (p.obfsPassword) out.obfs.password = p.obfsPassword;
      }
      // hysteria2 всегда поверх QUIC/TLS — TLS обязателен
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        alpn: (p.alpn || "h3").split(",").map(s => s.trim()).filter(Boolean),
      };
      if (p.pinSHA256) out.tls.certificate_public_key_sha256 = p.pinSHA256;
      return out;
    }
    case "anytls": {
      out = { ...base, type: "anytls", password: p.password };
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        utls: { enabled: true, fingerprint: normalizeFingerprint(p.fp) },
      };
      const anytlsAlpn = String(p.alpn || "").split(",").map(x => x.trim()).filter(Boolean);
      if (anytlsAlpn.length) out.tls.alpn = anytlsAlpn;
      return out;
    }
    case "hysteria": {
      // v1: аутентификация строкой, обфускация — общий секрет (строкой же),
      // скорости идут в контроллер перегрузки Brutal и потому обязательны.
      out = { ...base, type: "hysteria" };
      if (p.authString) out.auth_str = p.authString;
      if (p.obfs) out.obfs = p.obfs;
      out.up_mbps = p.upMbps || 50;
      out.down_mbps = p.downMbps || 100;
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
      };
      const hyAlpn = String(p.alpn || "").split(",").map(x => x.trim()).filter(Boolean);
      if (hyAlpn.length) out.tls.alpn = hyAlpn;
      return out;
    }
    case "socks": {
      out = { ...base, type: "socks", version: p.version === "4" || p.version === "4a" ? "4" : "5" };
      if (p.username) out.username = p.username;
      if (p.password) out.password = p.password;
      return out;
    }
    case "tuic": {
      out = {
        ...base,
        type: "tuic",
        uuid: p.uuid,
        password: p.password,
        congestion_control: String(p.congestionControl || "bbr").toLowerCase(),
        udp_relay_mode: p.udpRelayMode || "native",
        zero_rtt_handshake: !!p.zeroRttHandshake,
      };
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        disable_sni: !!p.disableSni,
        alpn: (p.alpn || "h3").split(",").map(s => s.trim()).filter(Boolean),
      };
      return out;
    }
    case "naive":
    case "trusttunnel":
      // Эти протоколы всегда идут через локальный sidecar-клиент (SOCKS5-мост):
      // нативного outbound в sing-box нет. Заглушка-socks; реальный порт
      // подставит bridge-loop в buildConfig (server_port=0 будет перезаписан).
      return { ...base, type: "socks", server: "127.0.0.1", server_port: 0, version: "5" };
    case "vless":
    default: {
      out = {
        ...base,
        type: "vless",
        uuid: p.uuid,
        packet_encoding: "xudp",
      };
      // Xray-суффикс «-udp443» ядро не знает; normalizeFlow приводит flow к
      // тому, что оно принимает (сам протокол на проводе тот же).
      const flow = normalizeFlow(p.flow);
      if (flow) out.flow = flow;
      break;
    }
  }

  const tls = buildTls(p);
  if (tls) out.tls = tls;
  const transport = buildTransport(p);
  if (transport) out.transport = transport;
  applyMux(out, options);
  applyTlsTricks(out, options);
  return out;
}

function isIpLiteral(value) {
  const host = String(value || "").trim().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host.includes(":")) {
    try {
      return new URL(`http://[${host}]/`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
  );
}

function endpointContainsIp(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    return close > 0 && isIpLiteral(raw.slice(1, close));
  }
  const colons = (raw.match(/:/g) || []).length;
  if (colons === 1) return isIpLiteral(raw.slice(0, raw.lastIndexOf(":")));
  return isIpLiteral(raw);
}

// Все адреса, к которым реально подключается xhttp-клиент. Кроме самого сервера
// это отдельный download-канал из `extra` (Xray StreamSettings): его адрес
// уезжает в конфиг xray как есть, а xray в строгом режиме ходит мимо туннеля
// (process-правило direct) — значит доменное имя оттуда резолвится системным
// DNS в обход всей политики. Проверка только node.host этого не ловила.
function xhttpEndpointHosts(node) {
  const hosts = [node?.host];
  if (!node?.extra) return hosts;
  try {
    const extra = JSON.parse(node.extra);
    const download = extra?.downloadSettings;
    if (download && typeof download === "object" && download.address) {
      hosts.push(String(download.address));
    }
  } catch { /* битый extra — до конфига он всё равно не доедет */ }
  return hosts;
}

function assertStrictBootstrapSafe(node) {
  const proto = profileProto(node);
  if (node?.type === "xhttp" && xhttpEndpointHosts(node).some((host) => !isIpLiteral(host))) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
      "XHTTP-клиенту нужен прямой DNS для адресов сервера и download-канала. В строгом режиме выберите XHTTP-ноду, у которой оба адреса заданы IP.",
    );
  }
  if (proto === "naive" && !isIpLiteral(node.host)) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
      "Naive-клиенту нужен прямой DNS для адреса сервера. В строгом режиме выберите ноду с IP-адресом.",
    );
  }
  if (proto === "trusttunnel") {
    const addresses = Array.isArray(node.addresses) ? node.addresses : [];
    if (!addresses.length || addresses.some((address) => !endpointContainsIp(address))) {
      throw new StrictPrivacyPolicyError(
        "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
        "TrustTunnel-клиенту нужны IP-адреса endpoint в строгом режиме.",
      );
    }
  }
}

// ── rule_sets для региона + block_ads ───────────────────────
function buildRuleSets(options, mode, downloadDetour = "proxy") {
  const sets = [];
  // TUN + split Discord: правило для маршрутизации доменов Discord мимо туннеля.
  if (mode === "tun" && options.route?.tunSplitDiscord) {
    sets.push({
      type: "remote", tag: "geosite-discord", format: "binary",
      url: `${GEOSITE_BASE}/geosite-discord.srs`,
      update_interval: "120h", download_detour: downloadDetour,
    });
  }
  const region = options.region;
  if (region && region !== "other") {
    sets.push({
      type: "remote", tag: `geoip-${region}`, format: "binary",
      url: `${GEOIP_BASE}/geoip-${region}.srs`,
      update_interval: "120h", download_detour: downloadDetour,
    });
    const geositeName = COUNTRY_GEOSITE[region];
    if (geositeName) {
      sets.push({
        type: "remote", tag: `geosite-${region}`, format: "binary",
        url: `${GEOSITE_BASE}/${geositeName}.srs`,
        update_interval: "120h", download_detour: downloadDetour,
      });
    }
  }
  if (options.blockAds) {
    for (const [tag, url] of BLOCK_AD_SETS) {
      sets.push({
        type: "remote", tag, format: "binary",
        url, update_interval: "120h", download_detour: downloadDetour,
      });
    }
  }
  return sets;
}

// ── DNS server: парсер строки в новый формат sing-box 1.12+ ─
// Поддерживаемые входы:
//   https://host/path   → {type: "https", server, path?}
//   tls://host[:port]   → {type: "tls",   server, server_port?}
//   tcp://host[:port]   → {type: "tcp",   server, server_port?}
//   udp://host[:port]   → {type: "udp",   server, server_port?}
//   quic://host[:port]  → {type: "quic",  server, server_port?}
//   1.2.3.4 / host      → {type: "udp",   server} (дефолт)
//   local | system      → {type: "local"}
export function parseDnsAddress(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "local" || s === "system") return { type: "local" };
  const m = s.match(/^([a-z]+):\/\/(.+)$/i);
  if (!m) {
    if (/\s|\//.test(s)) throw new Error(`invalid DNS server address: ${s}`);
    const hp = parseOptionalHostPort(s);
    const out = { type: "udp", server: hp.host };
    if (hp.port != null) out.server_port = hp.port;
    return out;
  }
  const scheme = m[1].toLowerCase();
  const rest = m[2];
  if (scheme === "https") {
    const u = (() => { try { return new URL(s); } catch { return null; } })();
    if (!u || !u.hostname || u.username || u.password) throw new Error(`invalid DoH URL: ${s}`);
    const o = { type: "https", server: u.hostname };
    if (u.port) o.server_port = parsePort(u.port, "sb.err.badPort");
    if (u.pathname && u.pathname !== "/") o.path = u.pathname;
    return o;
  }
  if (["tls", "tcp", "udp", "quic"].includes(scheme)) {
    const hp = parseOptionalHostPort(rest);
    const o = { type: scheme, server: hp.host };
    if (hp.port != null) o.server_port = hp.port;
    return o;
  }
  throw new Error(`unsupported DNS scheme: ${scheme}`);
}

function parseOptionalHostPort(rest) {
  const s = String(rest || "").trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) throw new Error(`invalid bracketed DNS address: ${s}`);
    const host = s.slice(1, close);
    if (!host) throw new Error("empty DNS host");
    const tail = s.slice(close + 1);
    if (tail.startsWith(":")) return { host, port: parsePort(tail.slice(1), "sb.err.badPort") };
    if (tail) throw new Error(`invalid DNS address suffix: ${tail}`);
    return { host };
  }
  if (!s || /\s|\//.test(s)) throw new Error(`invalid DNS host: ${s}`);
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount === 1) {
    const idx = s.lastIndexOf(":");
    const host = s.slice(0, idx);
    if (!host) throw new Error("empty DNS host");
    return { host, port: parsePort(s.slice(idx + 1), "sb.err.badPort") };
  }
  return { host: s };
}

// mode — фактический режим runtime. FakeIP имеет смысл ТОЛЬКО в TUN: перехватить
// выданный 198.18.x.x адрес может лишь TUN-инбаунд. В proxy/systemProxy тот же
// ответ уезжает в direct-маршруты (bypass, process_name, пользовательские
// правила direct) и соединение не встаёт — при этом симптом выглядит как
// «отдельные приложения не работают», а не как проблема DNS. Неизвестный режим
// трактуем консервативно: без FakeIP.
function buildDns(options, protectedOutbound = "proxy", mode = "") {
  const ipv6Strategy = IPV6_STRATEGY_MAP[options.route.ipv6Mode] || "prefer_ipv4";

  const remoteSrv = {
    tag: "dns-remote",
    ...parseDnsAddress(options.dns.remoteAddress),
    domain_resolver: "dns-direct",
    detour: protectedOutbound,
  };

  // detour "direct" в sing-box 1.13 не задаём — direct outbound у нас пустой
  // (без bind_interface), а 1.13 на пустой direct outbound выдаёт
  // "detour to an empty direct outbound makes no sense" и падает на старте.
  const directSrv = {
    tag: "dns-direct",
    ...parseDnsAddress(options.dns.directAddress),
  };

  const dns = {
    servers: [remoteSrv, directSrv],
    rules: [],
    independent_cache: !!options.dns.independentCache,
    strategy: ipv6Strategy,
    final: "dns-remote",
  };

  if (options.region && options.region !== "other") {
    dns.rules.push({
      domain_suffix: [`.${options.region}`],
      server: "dns-direct",
      rewrite_ttl: 86400,
    });
    if (COUNTRY_GEOSITE[options.region]) {
      dns.rules.push({
        rule_set: [`geosite-${options.region}`],
        server: "dns-direct",
        rewrite_ttl: 86400,
      });
    }
  }

  if (options.dns.enableFakeDns && mode === "tun") {
    dns.servers.push({
      tag: "dns-fake",
      type: "fakeip",
      inet4_range: "198.18.0.0/15",
      inet6_range: "fc00::/18",
    });
    dns.rules.push({ query_type: ["A", "AAAA"], server: "dns-fake" });
  }

  return dns;
}

// ── route ──────────────────────────────────────────────────
// Пользовательские правила маршрутизации (options.route.customRules) → правила
// sing-box. Одно правило юзера = один route-rule. Действие: proxy/direct → outbound,
// block → action:"reject" (как blockAds). Пропускаем выключенные и без значений.
// Тип:
//   domain  + match → domain_suffix (дефолт) / domain (exact) / domain_keyword
//   ip            → ip_cidr (одиночный IP нормализуем в /32, IPv6 в /128)
//   process       → process_name (работает во ВСЕХ режимах — sing-box резолвит
//                   процесс по локальному сокету mixed-inbound, привязки к TUN нет)
function customRulesToSingbox(customRules, protectedOutbound = "proxy") {
  if (!Array.isArray(customRules)) return [];
  const out = [];
  for (const r of customRules) {
    if (!r || r.enabled === false) continue;
    const values = (Array.isArray(r.values) ? r.values : [])
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (!values.length) continue;

    const rule = {};
    if (r.type === "domain") {
      const field =
        r.match === "exact" ? "domain" : r.match === "keyword" ? "domain_keyword" : "domain_suffix";
      rule[field] = values;
    } else if (r.type === "ip") {
      rule.ip_cidr = values.map((v) => (v.includes("/") ? v : `${v}/${v.includes(":") ? 128 : 32}`));
    } else if (r.type === "process") {
      rule.process_name = values;
    } else {
      continue; // неизвестный тип — пропускаем
    }

    if (r.action === "block") rule.action = "reject";
    else rule.outbound = r.action === "direct" ? "direct" : protectedOutbound;

    out.push(rule);
  }
  return out;
}

function buildRoute(options, mode, protectedOutbound = "proxy", strictPrivacy = false) {
  const rules = [
    { action: "sniff" },
    { protocol: "dns", action: "hijack-dns" },
    // Принудительный process-lookup для ВСЕХ соединений (во всех режимах). В
    // стоковом sing-box нет глобального find_process — процесс резолвится, только
    // когда правило его требует. Это правило с несуществующим именем форсит резолв
    // сокет→PID→exe (sing-box кладёт имя в metadata.process для clash API), но само
    // НЕ матчится → маршрутизацию не меняет. Благодаря ему монитор соединений
    // показывает имя приложения у каждого соединения (как Throne), а не только под
    // process-правилом. Стоит выше bypass/custom/region, чтобы lookup срабатывал до
    // первого терминального правила. Накладные: один lookup на соединение (sing-box
    // кэширует TCP-таблицу). Сентинел заведомо не совпадёт ни с одним реальным exe.
    // Opt-out (route.processLookup === false): монитор перестаёт показывать имена
    // процессов, зато исчезает per-connection резолв — дешевле на нагруженном канале.
    ...(options.route?.processLookup !== false
      ? [{ process_name: ["\u0000ninety-force-process-lookup"], outbound: "direct" }]
      : []),
  ];

  // ProcessName bypass — критично для TUN-режима. Без него собственный трафик
  // Ninety (Tauri webview HTTP-запросы к ipwho.is и т.п.), самого sing-box и
  // всех мостов (xray, naive, trusttunnel_client — каждый сам дозванивается до
  // реального сервера) петлял бы обратно в TUN-интерфейс: коннект к endpoint'у
  // ловит TUN → final:proxy → socks-мост → снова тот же клиент, рекурсия.
  // В proxy/systemProxy это bypass-правило не нужно: свой трафик Ninety туда не
  // петляет (no_proxy reqwest + нет auto_route, перехватывающего всё), поэтому
  // добавляем только в TUN. ВАЖНО: сам process-матчинг работает во ВСЕХ режимах
  // (sing-box резолвит процесс по локальному сокету mixed-inbound) — ограничения
  // «process_name только в TUN» НЕТ; здесь речь исключительно про bypass-петлю.
  if (mode === "tun") {
    // Проба качества (probe-in) — в туннель, ДО bypass-правила ниже: иначе
    // process-матч Ninety.exe увёл бы её в direct и мерился бы голый канал
    // вместо туннеля. При активном WARP buildConfig переставит outbound → warp.
    rules.push({ inbound: ["probe-in"], outbound: protectedOutbound });
    // Список обязан покрывать ВСЕ движки, дозванивающиеся наружу (= ENGINES в
    // killswitch.rs + Ninety.exe) — пропущенный sidecar зацикливается сам в себя.
    // В обычном TUN собственные HTTP-запросы Ninety идут напрямую. Строгая
    // сессия исключает только движки: контроллер тоже обязан идти через TUN,
    // иначе updater/служебный fetch мог бы раскрыть реальный адрес.
    rules.push({
      process_name: strictPrivacy ? ENGINE_PROCESS_NAMES : ["Ninety.exe", ...ENGINE_PROCESS_NAMES],
      outbound: "direct",
    });
  }

  // TUN + split Discord: Discord идёт direct (мимо туннеля), чтобы winws
  // десинхрил его на реальном интерфейсе. winws при этом НЕ паузится в TUN (см.
  // dpi-view.setDpiVpnMode). VPN-нода уже в exclude winws — её трафик не трогаем.
  //
  // Процесс + домены, а не что-то одно: доменные правила покрывают Discord в
  // браузере, но не голосовой UDP (см. DISCORD_PROCESS_NAMES), а процесс
  // покрывает десктопный клиент целиком, включая голос. Без процессного правила
  // голос уходил в туннель — ровно то, что фича должна была убрать.
  if (mode === "tun" && options.route?.tunSplitDiscord) {
    rules.push({ process_name: DISCORD_PROCESS_NAMES, outbound: "direct" });
    rules.push({ rule_set: ["geosite-discord"], outbound: "direct" });
    rules.push({ domain_suffix: DISCORD_SUFFIXES, outbound: "direct" });
  }

  // Пользовательские правила — ВЫШЕ региона/рекламы/LAN (приоритетнее базы), но
  // ниже служебных safety-правил. Порядок в массиве = приоритет (первое совпадение
  // выигрывает): кастом перекрывает регион (напр. «Telegram → через VPN» победит
  // .ru-direct для трафика Telegram), а весь остальной трафик слушает базу ниже.
  rules.push(...customRulesToSingbox(options.route?.customRules, protectedOutbound));

  if (options.route.bypassLan) {
    rules.push({ ip_is_private: true, outbound: "direct" });
  }

  if (options.region && options.region !== "other") {
    rules.push({ domain_suffix: [`.${options.region}`], outbound: "direct" });
    rules.push({
      rule_set: COUNTRY_GEOSITE[options.region]
        ? [`geosite-${options.region}`, `geoip-${options.region}`]
        : [`geoip-${options.region}`],
      outbound: "direct",
    });
  }

  if (options.blockAds) {
    rules.push({
      rule_set: ["geosite-ads", "geosite-malware", "geosite-phishing", "geosite-cryptominers", "geoip-malware", "geoip-phishing"],
      action: "reject",
    });
  }

  const route = {
    rules,
    rule_set: buildRuleSets(options, mode, protectedOutbound),
    final: "proxy",
    auto_detect_interface: true,
    default_domain_resolver: {
      server: options.route.resolveDestination ? "dns-remote" : "dns-direct",
    },
  };

  return route;
}

// ── inbounds (sing-box 1.13: sniff/tun.address — через route rules / inet4_address) ─
// Возвращает МАССИВ инбаундов. В TUN, кроме tun-in, поднимаем probe-in — mixed
// на loopback для пробы движка качества: собственный трафик Ninety.exe в TUN
// уходит в direct bypass-правилом (защита от петли), поэтому «прямая» проба
// мерила бы голый канал, а не туннель. Правило inbound=probe-in → proxy/warp
// в buildRoute стоит ВЫШЕ bypass и гонит пробу сквозь аутбаунд.
function buildInbounds(mode, options) {
  if (mode === "tun") {
    return [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: "ninety-tun",
        // IPv4 + IPv6 обязательны оба: auto_route строит маршруты только для тех
        // семейств, чей адрес есть на интерфейсе. С одним IPv4-адресом весь
        // нативный IPv6-трафик уходил мимо туннеля физическим интерфейсом —
        // приложения со своим резолвером (Chromium/Electron с DoH получают AAAA
        // в обход hijack-dns) утекали с реальным адресом даже в TUN. ULA-префикс,
        // в публичную маршрутизацию не попадает.
        address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
        mtu: options.inbound.mtu || 9000,
        auto_route: true,
        strict_route: !!options.inbound.strictRoute,
        stack: options.inbound.tunStack || "mixed",
      },
      {
        type: "mixed",
        tag: "probe-in",
        listen: "127.0.0.1",
        listen_port: options.inbound.mixedPort || 7890,
      },
    ];
  }
  return [{
    type: "mixed",
    tag: "mixed-in",
    listen: options.inbound.allowConnectionFromLan ? "0.0.0.0" : "127.0.0.1",
    listen_port: options.inbound.mixedPort || 7890,
  }];
}

// ── WARP endpoint (Cloudflare WireGuard) ───────────────────
// Принимает WarpInfo из Tauri-команды warp_status (см. src-tauri/src/warp.rs)
// и собирает sing-box endpoint type=wireguard. Возвращает [endpoint, finalTag]
// или null если WARP не сконфигурирован.
//
//   mode "direct": WARP — единственный outbound, route.final = "warp",
//                  proxy selector в outbounds для UI/clash-API остаётся.
//   mode "chain":  WARP поверх proxy (endpoint.detour = "proxy"), route.final = "warp".
function buildWarpEndpoint(warpOpts, warpInfo) {
  if (!warpOpts?.enabled || !warpInfo?.private_key || !warpInfo?.peer_public_key) {
    return null;
  }
  const endpointStr = warpOpts.endpoint || "engage.cloudflareclient.com:2408";
  // hostPort: либо host:port, либо auto4/auto6/auto → host = строка, port = 2408
  let host = endpointStr, port = 2408;
  if (/^auto[46]?$/.test(endpointStr)) {
    host = endpointStr;
  } else {
    try {
      const { host: h, port: p } = splitHostPort(endpointStr);
      host = h;
      if (p) port = p;
    } catch {
      // fallback: оставляем endpointStr как host
    }
  }

  // client_id base64 → 3 байта reserved (CF проверяет первые 3)
  const clientIdRaw = safeAtob(warpInfo.client_id || "");
  const reserved = [];
  for (let i = 0; i < 3; i++) reserved.push(clientIdRaw.charCodeAt(i) || 0);

  const address = [];
  if (warpInfo.local_ipv4) address.push(`${warpInfo.local_ipv4}/32`);
  if (warpInfo.local_ipv6) address.push(`${warpInfo.local_ipv6}/128`);
  if (!address.length) return null;

  const endpoint = {
    type: "wireguard",
    tag: "warp",
    address,
    private_key: warpInfo.private_key,
    mtu: warpOpts.mtu || 1280,
    peers: [
      {
        address: host,
        port,
        public_key: warpInfo.peer_public_key,
        allowed_ips: ["0.0.0.0/0", "::/0"],
        reserved,
      },
    ],
  };

  // AmneziaWG-обфускация. Поле noise.fake_packet
  // вписывается прямо в WG-endpoint sing-box форка (см. hsb/option/wireguard.go).
  // Range сериализуется как "from-to" string (Range.MarshalJSON в ядре).
  const noisePreset = warpOpts.noisePreset || "off";
  let noise = WARP_NOISE_PRESETS[noisePreset];
  if (noisePreset === "custom") {
    noise = buildCustomNoise(warpOpts.customNoise);
  }
  if (noise) {
    endpoint.noise = { fake_packet: noise };
  }

  if (warpOpts.mode === "chain") {
    // detour: WG-пакеты WARP отправляются через активный selector "proxy"
    endpoint.detour = "proxy";
  }
  return endpoint;
}

const WARP_NOISE_PRESETS = {
  off: null,
  default: {
    enabled: true,
    count: "1-3",
    size: "10-30",
    delay: "10-30",
    mode: "random",
  },
  aggressive: {
    enabled: true,
    count: "3-8",
    size: "30-90",
    delay: "5-15",
    mode: "random",
  },
  custom: null, // собирается из warp.customNoise через buildCustomNoise
};

function buildCustomNoise(cn) {
  if (!cn) return null;
  const range = (r, defFrom, defTo) => {
    const f = Number.isFinite(r?.from) ? r.from : defFrom;
    const t = Number.isFinite(r?.to)   ? r.to   : defTo;
    const lo = Math.min(f, t), hi = Math.max(f, t);
    return `${lo}-${hi}`;
  };
  return {
    enabled: true,
    count: range(cn.count, 2, 5),
    size:  range(cn.size, 20, 60),
    delay: range(cn.delay, 8, 20),
    mode: "random",
  };
}

// ── two-core bridge: xhttp через xray-core ─────────────────
// Порт xhttp в форке sing-box (packet-up) надёжно тащит только пинг, реальный
// поток рассыпается. Эталон — xray-core. Поэтому xhttp-ноды уводим в локальный
// xray (per-node socks-inbound), а в sing-box оставляем socks-мост на 127.0.0.1.
// urltest/balancer sing-box продолжают пинговать ноду сквозь socks → xray.
// Важно: xhttpSettings для xray — это РОВНО то, что в ссылке (host/path/mode +
// extra с downloadSettings в Xray-схеме), без какой-либо трансляции.
const XRAY_BRIDGE_BASE_PORT = 31100;
// Локальные SOCKS5-порты sidecar-клиентов naive / trusttunnel_client. Раздельные
// диапазоны, чтобы не пересечься между собой и с xray (31100+).
const NAIVE_BRIDGE_BASE_PORT = 31200;
const TT_BRIDGE_BASE_PORT = 31300;

// Сколько loopback-мостов нужно источнику — по одному порту на xhttp/naive/TT
// ноду. main.js по этим счётчикам просит Rust (plan_bridge_ports) подобрать
// свободные базы bind-пробой: дефолтные 31100+ может занять чужой процесс, и
// мост умирал бы на старте. Результат уходит в buildConfig({ bridgePorts }).
export function bridgeNeeds(nodes) {
  const needs = { xray: 0, naive: 0, trusttunnel: 0 };
  for (const n of nodes || []) {
    if (needsXrayBridge(n)) needs.xray++;
    const proto = profileProto(n);
    if (proto === "naive") needs.naive++;
    else if (proto === "trusttunnel") needs.trusttunnel++;
  }
  return needs;
}

// config.json клиента naive (klzgrad): один proxy → один локальный SOCKS5.
// IPv6-литерал в authority URL обязан быть в скобках: парсер снимает их при
// разборе ссылки, и без обратной сборки получался `https://u:p@2001:db8::1:443`,
// который klzgrad-клиент не разбирает — нода молча не поднималась.
function urlAuthorityHost(host) {
  const value = String(host || "");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function naiveSidecarConfig(p, port) {
  const u = encodeURIComponent(p.username);
  const pw = encodeURIComponent(p.password);
  const scheme = p.scheme === "quic" ? "quic" : "https";
  return JSON.stringify({
    listen: `socks://127.0.0.1:${port}`,
    proxy: `${scheme}://${u}:${pw}@${urlAuthorityHost(p.host)}:${p.port}`,
  }, null, 2);
}

// Экранирование значения для TOML basic-string. Помимо \ и ", обязательно
// экранируем управляющие символы: TOML запрещает сырой перевод строки/таб
// внутри basic-string, поэтому поле подписки с \n (username/password/customSni/
// certificate) иначе даёт невалидный конфиг → trusttunnel_client падает на
// парсинге и нода молча не поднимается.
function tomlStr(v) {
  const s = String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // прочие control-символы (U+0000–U+001F, плюс DEL U+007F); \n \r \t уже
    // заменены выше и в диапазон не попадут.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) =>
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
  return `"${s}"`;
}
function tomlArr(list) {
  return `[${(list || []).map(tomlStr).join(", ")}]`;
}

// Уровень логов из настроек (opts.log.level) → формат конкретного движка.
// Настройка одна, но движки называют уровни по-разному. Базовая шкала —
// sing-box: trace/debug/info/warn/error.
const SB_LEVELS = ["trace", "debug", "info", "warn", "error"];
function sbLevel(opts) {
  const l = opts?.log?.level;
  return SB_LEVELS.includes(l) ? l : "info";
}
// xray: debug/info/warning/error/none (warn → warning).
function xrayLevel(opts) {
  return ({ trace: "debug", debug: "debug", info: "info", warn: "warning", error: "error" })[sbLevel(opts)] || "warning";
}
// trusttunnel: trace/debug/info/warn/error — имена совпадают с sing-box.
function ttLevel(opts) { return sbLevel(opts); }

// trusttunnel_client.toml в режиме SOCKS5-листенера (без TUN → без админ-прав).
// killswitch выключен: в socks-мосте он не нужен и мог бы резать локальный трафик.
function trustTunnelSidecarConfig(p, port, opts) {
  const lines = [
    `loglevel = ${tomlStr(ttLevel(opts))}`,
    // vpn_mode обязателен (top-level): клиент падает «Unexpected VPN mode: » при
    // его отсутствии (build_config парсит его до listener). general = весь трафик
    // socks-листенера в endpoint; selective гонит в туннель только exclusions —
    // нам нужен general, т.к. маршрутизацию делает sing-box, а TT — чистый мост.
    `vpn_mode = "general"`,
    `killswitch_enabled = false`,
    // Дефолт официального setup_wizard — true; выравниваем 1:1 (post-quantum
    // группа в TLS-handshake). Не влияет на auth, но убирает единственное
    // расхождение нашего settings-конфига с каноническим выводом визарда.
    `post_quantum_group_enabled = true`,
    ``,
    `[endpoint]`,
    `hostname = ${tomlStr(p.hostname)}`,
    `addresses = ${tomlArr(p.addresses)}`,
    `has_ipv6 = ${p.hasIpv6 ? "true" : "false"}`,
    `username = ${tomlStr(p.username)}`,
    `password = ${tomlStr(p.password)}`,
    `skip_verification = ${p.skipVerification ? "true" : "false"}`,
    `upstream_protocol = ${tomlStr(p.upstreamProtocol || "http2")}`,
    `anti_dpi = ${p.antiDpi ? "true" : "false"}`,
  ];
  // custom_sni: переопределяет SNI/authority для endpoint'а. Если подписка его
  // задаёт, без него запрос уходит на неверный vhost → сервер может вернуть
  // «Authorization Required». Раньше поле терялось.
  if (p.customSni) lines.push(`custom_sni = ${tomlStr(p.customSni)}`);
  if (p.clientRandom) lines.push(`client_random = ${tomlStr(p.clientRandom)}`);
  if (p.certificate) lines.push(`certificate = ${tomlStr(p.certificate)}`);
  if (p.dnsUpstreams && p.dnsUpstreams.length) lines.push(`dns_upstreams = ${tomlArr(p.dnsUpstreams)}`);
  lines.push(``, `[listener.socks]`, `address = "127.0.0.1:${port}"`);
  return lines.join("\n") + "\n";
}

function nodeToXrayStream(p) {
  // Мост поднимается не только под xhttp: mKCP ядро не умеет вовсе, а xray умеет.
  const network = p.type === "kcp" ? "kcp" : "xhttp";
  const ss = { network };
  const sec = p.tlsMode || p.security;
  if (sec === "reality") {
    ss.security = "reality";
    ss.realitySettings = {
      serverName: p.sni || "",
      fingerprint: p.fp || "chrome",
      publicKey: p.pbk || "",
      shortId: p.sid || "",
    };
  } else if (sec === "tls") {
    ss.security = "tls";
    ss.tlsSettings = { serverName: p.sni || "", fingerprint: p.fp || "chrome" };
    if (p.alpn) ss.tlsSettings.alpn = String(p.alpn).split(",").map(s => s.trim()).filter(Boolean);
  } else {
    ss.security = "none";
  }
  if (network === "kcp") {
    // Остальные параметры mKCP (mtu/tti/окна/congestion) в ссылках не передают —
    // оставляем дефолты xray, они совпадают с дефолтами серверной стороны.
    ss.kcpSettings = { header: { type: p.headerType || "none" } };
    if (p.seed) ss.kcpSettings.seed = p.seed;
    return ss;
  }
  const xs = { host: p.host_header || p.sni || "", path: p.path || "/", mode: p.mode || "auto" };
  if (p.extra) {
    try { const ex = JSON.parse(p.extra); if (ex && typeof ex === "object") Object.assign(xs, ex); }
    catch { /* битый extra — базовых полей достаточно */ }
  }
  ss.xhttpSettings = xs;
  return ss;
}

// Протоколы, которые локальный xray-мост умеет поднять для xhttp. Раньше сюда
// проваливалось ВСЁ, что не trojan: vmess+xhttp собирался как vless-outbound с
// его же uuid — конфиг валиден, ядро стартует, нода мертва без единой строки в
// логе. Предикат один на bridgeNeeds и на сборку конфига: расхождение этих двух
// мест означало бы, что портов запланировано не столько, сколько занято.
const XRAY_BRIDGE_PROTOS = new Set(["vless", "vmess", "trojan"]);
// Транспорты, которых нет в ядре: их несёт локальный xray, а в sing-box
// остаётся socks-мост.
const XRAY_BRIDGE_TYPES = new Set(["xhttp", "kcp"]);
export function needsXrayBridge(node) {
  return XRAY_BRIDGE_TYPES.has(node?.type) && XRAY_BRIDGE_PROTOS.has(profileProto(node));
}

function nodeToXrayOutbound(p, tag) {
  const proto = profileProto(p);
  if (proto === "trojan") {
    return {
      tag, protocol: "trojan",
      settings: { servers: [{ address: p.host, port: p.port, password: p.password }] },
      streamSettings: nodeToXrayStream(p),
    };
  }
  if (proto === "vmess") {
    // alterId>0 — это legacy MD5-аутентификация, которой в текущем xray-core уже
    // нет; шлём 0, как это делают все актуальные панели.
    const user = { id: p.uuid, alterId: 0, security: p.security || "auto" };
    return {
      tag, protocol: "vmess",
      settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
      streamSettings: nodeToXrayStream(p),
    };
  }
  const user = { id: p.uuid, encryption: p.encryption || "none" };
  if (p.flow) user.flow = p.flow;
  return {
    tag, protocol: "vless",
    settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
    streamSettings: nodeToXrayStream(p),
  };
}

// ── главный builder ────────────────────────────────────────
// Поддерживает оба вызова:
//   buildConfig({ profile, mode, options }) — одиночный vless (legacy)
//   buildConfig({ source, mode, options })  — { kind, profile|nodes }
// Если nodes.length >= 2 → собирает urltest group: outbound "auto" с
// дочерними vless'ами; route.final → auto.
//
// warpInfo: опциональный объект WarpInfo от warp_status команды.
//   Если options.warp.enabled === true и warpInfo передан с валидными ключами —
//   добавляется WireGuard endpoint и route.final переключается на "warp".
//
// runtimePolicy: чистая runtime-политика из strict-privacy-policy.js. Строгая
// политика всегда переводит builder в TUN, применяет безопасную копию options и
// для multi-node подписки требует один конкретный selectedNodeTag.
export function buildConfig({
  profile,
  source,
  mode,
  options,
  runtimePolicy,
  warpInfo,
  xray = false,
  bridgePorts,
}) {
  const runtime = resolveRuntimePrivacyPolicy({
    mode,
    options: options || DEFAULT_OPTIONS,
    runtimePolicy,
  });
  const opts = runtime.options || DEFAULT_OPTIONS;
  const effectiveMode = runtime.mode;
  const src = source ?? (profile ? { kind: "single", profile } : null);

  const warpEndpoint = buildWarpEndpoint(opts.warp, warpInfo);
  const warpOnly = !src && !!warpEndpoint && opts.warp?.mode === "direct";
  if (!src && !warpOnly) throw new Error(t("sb.err.buildNoSource"));

  // Базы портов loopback-мостов: план из plan_bridge_ports (свободные диапазоны)
  // либо статические дефолты (экспорт конфига, тесты — там bind не нужен).
  const basePorts = {
    xray: bridgePorts?.xray || XRAY_BRIDGE_BASE_PORT,
    naive: bridgePorts?.naive || NAIVE_BRIDGE_BASE_PORT,
    trusttunnel: bridgePorts?.trusttunnel || TT_BRIDGE_BASE_PORT,
  };

  // URL/интервал теста соединения — из настроек (ключи connectionTestUrl/intervalSec,
  // Раньше buildConfig читал несуществующие url/interval и
  // конфиг юзера игнорировался.
  const testUrl = opts.urlTest?.connectionTestUrl || "https://www.gstatic.com/generate_204";
  const intervalSec = Number(opts.urlTest?.intervalSec) > 0 ? Number(opts.urlTest.intervalSec) : 600;
  const testInterval = `${intervalSec}s`;

  let nodes = warpOnly ? [] : (src.kind === "sub" ? src.nodes : [src.profile]);
  if (!warpOnly && !nodes?.length) throw new Error(t("sb.err.buildNoNodes"));
  // Ядро инициализирует конфиг целиком: одна нода с параметрами, которых оно не
  // принимает, роняет весь старт. Подписку чистим и работаем на оставшихся,
  // одиночный профиль чистить нечем — отдаём понятную ошибку вместо FATAL ядра.
  if (!warpOnly && src.kind === "sub") {
    nodes = usableNodes(nodes).filter(node => !isNodeQuarantined(node));
    if (!nodes.length) throw new Error(t("sb.err.buildAllNodesInvalid"));
  } else if (!warpOnly && nodeConfigIssue(nodes[0])) {
    throw new Error(t("sb.err.nodeInvalid", { name: nodes[0]?.name || nodes[0]?.host || "" }));
  }
  let pinnedNodeTag = null;
  if (runtime.strictPrivacy && nodes.length) {
    const selected = selectStrictPrivacyCandidate(
      nodes.map((node, index) => ({ tag: nodeTag(index, node), value: node })),
      runtime.selectedNodeTag,
    );
    nodes = [selected.value];
    pinnedNodeTag = selected.tag;
    assertStrictBootstrapSafe(selected.value);
  }

  const protectedOutbound = warpEndpoint ? "warp" : "proxy";
  const route = buildRoute(opts, effectiveMode, protectedOutbound, runtime.strictPrivacy);
  const useUrltest = nodes.length >= 2;
  const vlessOutbounds = nodes.map((n, i) => {
    const ob = buildOutbound(n, opts);
    ob.tag = useUrltest ? nodeTag(i, n) : "proxy";
    // Адрес самого VPN-сервера неизбежно резолвится до готовности туннеля.
    // В strict используем отдельный IP-hosted DoH без detour; DNS пользовательских
    // назначений по-прежнему идёт через dns-remote внутри proxy.
    if (runtime.strictPrivacy && !isIpLiteral(ob.server)) {
      ob.domain_resolver = "dns-direct";
    }
    return ob;
  });

  // Two-core bridge: xhttp-ноды → локальный xray, в sing-box остаётся socks-мост.
  let xrayConfig = null;
  if (xray) {
    const xIn = [], xOut = [], xRules = [];
    nodes.forEach((n, i) => {
      if (!needsXrayBridge(n)) return;
      const idx = xOut.length;
      const port = basePorts.xray + idx;
      const inTag = `in-${idx}`, outTag = `out-${idx}`;
      xIn.push({ tag: inTag, listen: "127.0.0.1", port, protocol: "socks", settings: { auth: "noauth", udp: true } });
      xOut.push(nodeToXrayOutbound(n, outTag));
      xRules.push({ type: "field", inboundTag: [inTag], outboundTag: outTag });
      // Мост вместо vless+xhttp; тег outbound'а сохраняем — селектор/urltest
      // ссылаются на него.
      vlessOutbounds[i] = {
        tag: vlessOutbounds[i].tag,
        type: "socks", server: "127.0.0.1", server_port: port, version: "5",
      };
    });
    if (xOut.length) {
      xrayConfig = {
        log: { loglevel: xrayLevel(opts) },
        inbounds: xIn,
        outbounds: xOut,
        routing: { domainStrategy: "AsIs", rules: xRules },
      };
    }
  }

  // Sidecar-мост для naive / trusttunnel (всегда, не зависит от флага xray):
  // у этих протоколов нет нативного outbound — каждая нода поднимает свой
  // клиент-процесс на 127.0.0.1:PORT (SOCKS5), а в sing-box остаётся socks-мост.
  // urltest/balancer пингуют ноду сквозь socks → клиент, как и с xray.
  const sidecars = [];
  let naiveN = 0, ttN = 0;
  nodes.forEach((n, i) => {
    const proto = profileProto(n);
    let port, config, kind;
    if (proto === "naive") {
      port = basePorts.naive + naiveN++; kind = "naive"; config = naiveSidecarConfig(n, port);
    } else if (proto === "trusttunnel") {
      port = basePorts.trusttunnel + ttN++; kind = "trusttunnel"; config = trustTunnelSidecarConfig(n, port, opts);
    } else return;
    sidecars.push({ kind, port, config });
    vlessOutbounds[i] = {
      tag: vlessOutbounds[i].tag,
      type: "socks", server: "127.0.0.1", server_port: port, version: "5",
    };
  });

  let outbounds;
  if (warpOnly) {
    outbounds = [
      { type: "direct", tag: "direct" },
    ];
  } else if (useUrltest) {
    // "Auto" — это НЕ URLTest, а Balancer со strategy=lowest-delay. Он выбирает
    // outbound с минимальной задержкой, а interrupt_exist_connections обрывает
    // старые соединения при смене лидера → реальное "live" переключение.
    // Сам он ничего не измеряет: задержки берёт из общей URLTest-истории,
    // которую наполняет health-чекер "lowest" рядом. Без него balancer не знает
    // задержек и остаётся на первой ноде.
    const nodeTags = vlessOutbounds.map(o => o.tag);

    // Health-checker (скрыт из proxies UI, юзер про него не знает).
    const urlTest = {
      type: "urltest",
      tag: "lowest",
      outbounds: nodeTags,
      url: testUrl,
      interval: testInterval,
      tolerance: 50,
      // false — URLTest сам не должен обрывать TCP. Прерывание — задача
      // Balancer, иначе sing-box будет дважды дёргать interrupt при rotation.
      interrupt_exist_connections: false,
    };
    // "Авто" в UI — Balancer, lowest-delay per-connection.
    const auto = {
      type: "balancer",
      tag: "auto",
      outbounds: nodeTags,
      strategy: "lowest-delay",
      interrupt_exist_connections: true,
    };
    const selector = {
      type: "selector",
      tag: "proxy",
      outbounds: ["auto", "lowest", ...nodeTags],
      default: "auto",
      // Главный фикс hot-switch: с false старые соединения держатся
      // на прошлом outbound — браузер качает страницу через старый сервер
      // даже после переключения. Поэтому true для всех селекторов.
      interrupt_exist_connections: true,
    };
    outbounds = [
      selector,
      auto,
      urlTest,
      ...vlessOutbounds,
      { type: "direct", tag: "direct" },
    ];
  } else {
    outbounds = [
      vlessOutbounds[0],
      { type: "direct", tag: "direct" },
    ];
  }

  // WARP endpoint (опционально): подмешиваем wireguard endpoint и
  // переключаем route.final на "warp".
  if (warpEndpoint) {
    route.final = "warp";
    // Проба качества следует за final: мерить надо то плечо, которым реально
    // идёт трафик (правило probe-in в buildRoute собрано с outbound=proxy).
    for (const r of route.rules) {
      if (Array.isArray(r.inbound) && r.inbound.includes("probe-in")) r.outbound = "warp";
    }
  }

  const config = {
    log: {
      level: sbLevel(opts),
      timestamp: true, // нужен для парсера/фильтра экрана Логи
      ...(opts.log?.disabled ? { disabled: true } : {}),
    },
    dns: buildDns(opts, warpEndpoint ? "warp" : "proxy", effectiveMode),
    inbounds: buildInbounds(effectiveMode, opts),
    outbounds,
    route,
    experimental: {
      cache_file: { enabled: true, store_rdrc: true },
    },
  };
  if (warpEndpoint) {
    config.endpoints = [warpEndpoint];
  }

  // clash_api — не опция, а панель управления рантаймом: через него идут выбор
  // ноды, пинги, трафик и вся диагностика, а Rust вообще отказывается стартовать
  // без external_controller. Раньше это стояло под флагом, и снятый флаг (руками
  // или из старого бэкапа) давал конфиг, с которым подключение не поднималось
  // ни в одном режиме. Порт остаётся настраиваемым; loopback дожимает Rust.
  config.experimental.clash_api = {
    external_controller: `127.0.0.1:${opts.experimental?.clashApiPort || 9090}`,
  };

  // Unified delay: ядро делает второй замер по уже поднятому соединению и отдаёт
  // чистый RTT без TCP/TLS-хендшейка. Без него пинг для VLESS+Reality раздут в
  // 2-3 раза. Глобальный флаг — влияет и на UI-пинг (urltest history + ручной
  // /delay), и на balancer "auto".
  config.experimental.unified_delay = { enabled: true };

  // TLS-tricks (фрагментация/padding/mixedcase) более НЕ пишутся глобально:
  // experimental.tls_tricks в ядре нет. Теперь они
  // применяются per-outbound в applyTlsTricks() при сборке прокси-outbound.

  validateConfigReferences(config);
  // Карта «индекс outbound'а → нода»: именно этим индексом ядро называет
  // виновника в «initialize outbound[N]». Считать его арифметикой по позиции
  // селектора нельзя — состав outbound'ов меняется от режима к режиму.
  const nodeByOutbound = new Map(vlessOutbounds.map((outbound, i) => [outbound, nodes[i]]));
  const outboundNodes = outbounds.map(outbound => nodeByOutbound.get(outbound) || null);
  return {
    config,
    xray: xrayConfig,
    outboundNodes,
    sidecars,
    runtime: {
      mode: effectiveMode,
      strictPrivacy: runtime.strictPrivacy,
      pinnedNodeTag,
      options: opts,
    },
  };
}

// Semantic guard поверх JSON-схемы: sing-box принимает ссылки на теги строками,
// поэтому опечатка/ветка WARP-only иначе обнаруживается только при запуске ядра.
export function validateConfigReferences(config) {
  const outboundTags = new Set([
    ...(config.outbounds || []).map((o) => o?.tag),
    ...(config.endpoints || []).map((o) => o?.tag),
  ].filter(Boolean));
  const dnsTags = new Set((config.dns?.servers || []).map((s) => s?.tag).filter(Boolean));
  // rule_set-ссылки ядро резолвит так же строго, как outbound-теги: правило,
  // указывающее на невыпущенный набор, роняет старт целиком.
  const ruleSetTags = new Set((config.route?.rule_set || []).map((s) => s?.tag).filter(Boolean));
  const missing = [];
  const requireOutbound = (tag, path) => {
    if (tag && !outboundTags.has(tag)) missing.push(`${path} -> ${tag}`);
  };
  const requireDns = (tag, path) => {
    if (tag && !dnsTags.has(tag)) missing.push(`${path} -> ${tag}`);
  };
  const requireRuleSets = (value, path) => {
    const tags = Array.isArray(value) ? value : value ? [value] : [];
    for (const [i, tag] of tags.entries()) {
      if (tag && !ruleSetTags.has(tag)) missing.push(`${path}[${i}] -> ${tag}`);
    }
  };

  requireOutbound(config.route?.final, "route.final");
  for (const [i, rule] of (config.route?.rules || []).entries()) {
    requireOutbound(rule?.outbound, `route.rules[${i}].outbound`);
    requireRuleSets(rule?.rule_set, `route.rules[${i}].rule_set`);
  }
  for (const [i, set] of (config.route?.rule_set || []).entries()) {
    requireOutbound(set?.download_detour, `route.rule_set[${i}].download_detour`);
  }
  for (const [i, outbound] of (config.outbounds || []).entries()) {
    for (const [j, tag] of (outbound?.outbounds || []).entries()) {
      requireOutbound(tag, `outbounds[${i}].outbounds[${j}]`);
    }
    requireOutbound(outbound?.default, `outbounds[${i}].default`);
    requireOutbound(outbound?.detour, `outbounds[${i}].detour`);
    requireDns(outbound?.domain_resolver, `outbounds[${i}].domain_resolver`);
  }
  // endpoints (WARP) участвуют в маршрутизации наравне с outbound'ами: в chain
  // WARP уходит detour'ом в selector, и опечатка там так же не даёт ядру встать.
  for (const [i, endpoint] of (config.endpoints || []).entries()) {
    requireOutbound(endpoint?.detour, `endpoints[${i}].detour`);
    requireDns(endpoint?.domain_resolver, `endpoints[${i}].domain_resolver`);
  }
  for (const [i, server] of (config.dns?.servers || []).entries()) {
    requireOutbound(server?.detour, `dns.servers[${i}].detour`);
    requireDns(server?.domain_resolver, `dns.servers[${i}].domain_resolver`);
  }
  requireDns(config.dns?.final, "dns.final");
  for (const [i, rule] of (config.dns?.rules || []).entries()) {
    requireDns(rule?.server, `dns.rules[${i}].server`);
    requireRuleSets(rule?.rule_set, `dns.rules[${i}].rule_set`);
  }

  if (missing.length) {
    throw new Error(`sing-box config references missing tags: ${missing.join(", ")}`);
  }
  return true;
}

// Единая логика тэга outbound'а для multi-node подписки.
// Должна совпадать между builder'ом и proxies-view, иначе селектор будет бить мимо.
export function nodeTag(i, node) {
  void i; // legacy argument; identity intentionally does not depend on ordering.
  const stable = hashRuntimeValue(stableNodeId(node, "node"));
  return `node-${stable}`;
}

// ── профили (storage) ──────────────────────────────────────
export function loadProfiles() {
  return loadProfilesFromStore();
}

export function saveProfiles(list) {
  saveProfilesToStore(list);
}

export function getActiveProfileId() {
  return getActiveProfileIdFromStore();
}

export function setActiveProfileId(id) {
  setActiveProfileIdInStore(id);
}

export function getActiveProfile() {
  const id = getActiveProfileId();
  if (!id) return null;
  return loadProfiles().find(p => p.id === id) || null;
}

export function addProfileFromVless(raw) {
  return addProfileFromLink(raw);
}

// Универсальный добавитель — работает для любого supported протокола.
function storeProfile(parsed) {
  const id = uid("p_");
  const list = loadProfiles();
  list.push({ ...parsed, id });
  saveProfiles(list);
  return { id, profile: parsed };
}

export function addProfileFromLink(raw) {
  return storeProfile(parseLink(raw));
}

// Импорт TrustTunnel из endpoint-.toml (вставлен текстом или загружен файлом).
export function addTrustTunnelFromToml(tomlText, displayName) {
  return storeProfile(parseTrustTunnelToml(tomlText, displayName));
}

// ── unified active source (profile | subscription) ─────────
export function getActiveKind() {
  return getActiveKindFromStore();
}

export function setActiveKind(kind) {
  setActiveKindInStore(kind);
}

function loadSubsRaw() {
  return loadSubscriptionsFromStore();
}

/**
 * Источник по записи подписки. Ноды, которые ядро не примет, отсекаются прямо
 * здесь, а не в сборщике: конфиг, список серверов, clash-теги и fingerprint
 * обязаны видеть один и тот же набор нод, иначе топология не сойдётся.
 */
export function subscriptionSource(sub) {
  if (!sub) return null;
  const nodes = usableNodes(sub.profiles || []).filter(node => !isNodeQuarantined(node));
  if (!nodes.length) return null;
  return { kind: "sub", subscription: sub, nodes };
}

/**
 * Возвращает текущий активный источник для коннекта.
 * { kind: "single", profile } — одиночный vless
 * { kind: "sub", subscription, nodes } — подписка (>=1 нод)
 * null — ничего не активно
 */
export function getActiveSource() {
  const kind = getActiveKind();
  if (kind === "sub") {
    const subId = getActiveSubscriptionIdFromStore();
    if (!subId) return null;
    const sub = loadSubsRaw().find(s => s.id === subId);
    if (!sub || !sub.profiles?.length) return null;
    return subscriptionSource(sub);
  }
  const p = getActiveProfile();
  return p ? { kind: "single", profile: p } : null;
}

export function removeProfile(id) {
  const wasActive = getActiveProfileId() === id;
  const list = loadProfiles().filter(p => p.id !== id);
  saveProfiles(list);
  if (wasActive) {
    setActiveProfileId(list[0]?.id ?? null);
  }
}

// Точечное обновление полей одиночного профиля (rename и т.п.).
export function updateProfile(id, patch) {
  const list = loadProfiles();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  saveProfiles(list);
  return list[idx];
}

// 3 режима:
//   proxy       — sing-box локально на 127.0.0.1:mixedPort, системный прокси НЕ
//                 трогаем. Юзер сам направляет браузер/приложения в SOCKS+HTTP.
//   systemProxy — sing-box + автоматически выставляем HKCU Internet Settings.
//                 Это default на desktop.
//   tun         — TUN intercept всего трафика. sing-box поднимает TUN-интерфейс
//                 как наш child (Ninety запущен от админа, Throne-style).
//
// Старое значение "proxy" из pre-alpha34 = systemProxy (мы всегда выставляли
// system proxy). При чтении мигрируем — старые юзеры не теряют поведение.
const VALID_MODES = new Set(["proxy", "systemProxy", "tun"]);

export function getMode() {
  const m = localStorage.getItem(MODE_KEY);
  if (m === "tun") return "tun";
  if (m === "systemProxy") return "systemProxy";
  if (m === "proxy") {
    // Миграция: если флаг миграции стоит — это новый "proxy" (без системного),
    // иначе старое поведение → systemProxy.
    if (localStorage.getItem(MODE_KEY + ".migrated") === "1") return "proxy";
    localStorage.setItem(MODE_KEY, "systemProxy");
    localStorage.setItem(MODE_KEY + ".migrated", "1");
    return "systemProxy";
  }
  return "systemProxy"; // default desktop
}

export function setMode(m) {
  const v = VALID_MODES.has(m) ? m : "systemProxy";
  localStorage.setItem(MODE_KEY, v);
  localStorage.setItem(MODE_KEY + ".migrated", "1");
}
