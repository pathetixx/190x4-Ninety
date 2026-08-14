// Ninety · protocol link parsers.
// Чистый слой: входная ссылка/endpoint text -> нормализованный profile object.

import { t } from "/lib/i18n/index.js";
import {
  bytesFromB64url,
  parsePort,
  safeDecode,
  safeDecodeBase64,
  splitHostPort,
  splitQuery,
  splitTrailingHashName,
} from "/lib/url-helpers.js";

// Разрез `method:password` / `uuid:password` по ПЕРВОМУ двоеточию.
// `split(":", 2)` здесь неверен: второй аргумент JS-split ограничивает длину
// результата, а не число разрезов, поэтому пароль с двоеточием молча терялся
// хвостом (`pa:ss` → `pa`). Конфиг при этом собирался, ядро стартовало, и нода
// падала только на аутентификации — без единого сообщения.
// Отсутствие разделителя даёт undefined, как и прежний split: пустое поле не
// должно превращаться в JSON `null` внутри конфига движка.
function splitFirstColon(value) {
  const s = String(value ?? "");
  const sep = s.indexOf(":");
  return sep < 0 ? [s, undefined] : [s.slice(0, sep), s.slice(sep + 1)];
}

// Булев query-параметр ссылки. Спека hysteria2 описывает `insecure=1`, но
// панели одинаково часто отдают `insecure=true`; TUIC-ссылки — наоборот.
// Принимаем обе формы: иначе нода с самоподписанным сертификатом не встаёт,
// а причина («сертификат не проверился») пользователю нигде не видна.
// Xray переименовал транспорт дважды: tcp → raw и splithttp → xhttp. Ссылки со
// старыми именами панели раздают до сих пор. `raw` уже понимали, а `splithttp`
// проваливал валидацию транспорта, и нода молча выбрасывалась из подписки.
// Нормализуем на входе, чтобы дальше по коду жило одно имя.
const TRANSPORT_ALIASES = { splithttp: "xhttp" };

function normalizeTransportType(value) {
  const type = String(value || "").trim().toLowerCase();
  return TRANSPORT_ALIASES[type] || type;
}

function boolParam(value, fallback = false) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

// ── vless парсер ────────────────────────────────────────────
export function parseVless(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("vless://")) throw new Error(t("sb.err.notVless"));
  const rest = url.slice("vless://".length);
  const hashIdx = rest.indexOf("#");
  const name = hashIdx >= 0 ? safeDecode(rest.slice(hashIdx + 1)) : "VLESS";
  const main = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const qIdx = main.indexOf("?");
  const head = qIdx >= 0 ? main.slice(0, qIdx) : main;
  const query = qIdx >= 0 ? main.slice(qIdx + 1) : "";

  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.noHostPort"));
  // UUID приходит percent-encoded так же, как пароли остальных схем: панели
  // экранируют его наравне с прочим userinfo. Пустой UUID собрал бы конфиг,
  // который падает уже в ядре на аутентификации — ловим здесь.
  const uuid = safeDecode(head.slice(0, atIdx)).trim();
  if (!uuid) throw new Error(t("sb.err.vlessUuid"));
  const hostPort = head.slice(atIdx + 1);

  const { host, port } = splitHostPort(hostPort, "sb.err.badPort");

  const params = new URLSearchParams(query);
  const get = (k, def = "") => params.get(k) ?? def;

  return {
    raw: url,
    name,
    uuid,
    host,
    port,
    security: get("security", "none"),
    encryption: get("encryption", "none"),
    type: normalizeTransportType(get("type", "tcp")),
    flow: get("flow", ""),
    sni: get("sni") || host,
    fp: get("fp", "chrome"),
    pbk: get("pbk", ""),
    sid: get("sid", ""),
    alpn: get("alpn", ""),
    path: get("path", ""),
    host_header: get("host", ""),
    serviceName: get("serviceName", ""),
    mode: get("mode", ""),
    extra: get("extra", ""),
    // mKCP: маскировка пакетов и общий секрет обфускации. Без них нода с
    // type=kcp собиралась как обычный TCP и молча не работала.
    headerType: get("headerType") || get("headertype", ""),
    seed: get("seed", ""),
    // v2ray-QUIC: ядро умеет только «сырой» QUIC без дополнительного шифрования
    // транспорта, поэтому значение проверяется, а не переносится.
    quicSecurity: get("quicSecurity") || get("quicsecurity", ""),
  };
}

// ── vmess парсер (base64 JSON) ──────────────────────────────
export function parseVmess(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("vmess://")) throw new Error(t("sb.err.notVmess"));
  const payload = url.slice("vmess://".length);
  const { name: hashName, main } = splitTrailingHashName(payload, null);
  // Декодируем как UTF-8, а не через голый atob: тот отдаёт latin1-строку,
  // где каждый байт стал отдельным кодпоинтом. Пейлоад vmess — UTF-8 JSON,
  // поэтому имя ноды (ps) из любой неанглоязычной панели приезжало мохибаке,
  // а вместе с ним host и пароль с не-ASCII.
  const decoded = safeDecodeBase64(main);
  if (!decoded) throw new Error(t("sb.err.vmessB64"));
  let j;
  try { j = JSON.parse(decoded); } catch { throw new Error(t("sb.err.vmessJson")); }
  const port = parsePort(j.port, "sb.err.vmessPort");
  return {
    raw: url,
    proto: "vmess",
    name: hashName || j.ps || j.remarks || "VMESS",
    host: j.add,
    port,
    uuid: j.id,
    alterId: parseInt(j.aid || j.alterId || "0", 10),
    security: j.scy || j.security || "auto",
    tlsMode: (j.tls || "") === "tls" || j.tls === "reality" ? j.tls : "none",
    sni: j.sni || j.host || j.add,
    fp: j.fp || "chrome",
    alpn: j.alpn || "",
    type: normalizeTransportType(j.net || "tcp"),
    path: j.path || "",
    host_header: j.host || "",
    serviceName: j.path || "",
    mode: j.type || "",
    // В vmess-JSON `type` — это заголовок маскировки, а `path` для mKCP несёт
    // seed обфускации: у остальных транспортов оба поля значат другое.
    headerType: j.type || "",
    seed: j.net === "kcp" ? (j.path || "") : "",
  };
}

// ── trojan парсер ───────────────────────────────────────────
export function parseTrojan(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("trojan://")) throw new Error(t("sb.err.notTrojan"));
  const rest = url.slice("trojan://".length);
  const { name, main } = splitTrailingHashName(rest, "TROJAN");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.trojanHostPort"));
  const password = decodeURIComponent(head.slice(0, atIdx));
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.trojanHostPort");
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url,
    proto: "trojan",
    name,
    host, port,
    password,
    security: get("security", "tls"),
    type: normalizeTransportType(get("type", "tcp")),
    sni: get("sni") || host,
    fp: get("fp", "chrome"),
    alpn: get("alpn", ""),
    path: get("path", ""),
    host_header: get("host", ""),
    serviceName: get("serviceName", ""),
    mode: get("mode", ""),
    extra: get("extra", ""),
  };
}

// ── shadowsocks (SIP002) ────────────────────────────────────
export function parseShadowsocks(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("ss://")) throw new Error(t("sb.err.notSs"));
  const rest = url.slice("ss://".length);
  const { name, main } = splitTrailingHashName(rest, "SS");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) {
    // Legacy form: base64(method:password@host:port)
    // UTF-8-декод по той же причине, что в parseVmess: пароль с не-ASCII иначе
    // уезжает в конфиг побайтово перевранным и нода падает на аутентификации.
    const decoded = safeDecodeBase64(head);
    if (!decoded) throw new Error(t("sb.err.ssB64"));
    const at2 = decoded.lastIndexOf("@");
    if (at2 < 0) throw new Error(t("sb.err.ssHostPort"));
    const credsRaw = decoded.slice(0, at2);
    const [method, password] = splitFirstColon(credsRaw);
    const { host, port } = splitHostPort(decoded.slice(at2 + 1), "sb.err.ssHostPort");
    return { raw: url, proto: "shadowsocks", name, host, port, method, password };
  }
  const credsRaw = head.slice(0, atIdx);
  // SIP002: userinfo может быть как раз base64url(method:password)
  let method, password;
  if (credsRaw.includes(":")) {
    [method, password] = splitFirstColon(credsRaw);
    // safeDecode на обеих половинах: метод панели тоже экранируют, а битый
    // %-escape в пароле раньше ронял decodeURIComponent и весь импорт ссылки.
    method = safeDecode(method);
    password = safeDecode(password);
  } else {
    const decoded = safeDecodeBase64(credsRaw);
    const sep = decoded.indexOf(":");
    if (sep < 0) throw new Error("ss: bad userinfo");
    method = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
  }
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.ssHostPort");
  const plugin = query.get("plugin") || "";
  let pluginName = "", pluginOpts = "";
  if (plugin) {
    const semi = plugin.indexOf(";");
    pluginName = semi >= 0 ? plugin.slice(0, semi) : plugin;
    pluginOpts = semi >= 0 ? plugin.slice(semi + 1) : "";
  }
  return {
    raw: url, proto: "shadowsocks", name, host, port,
    method, password,
    plugin: pluginName, plugin_opts: pluginOpts,
  };
}

// ── hysteria2 ───────────────────────────────────────────────
export function parseHysteria2(raw) {
  const url = String(raw || "").trim();
  const scheme = url.startsWith("hysteria2://") ? "hysteria2://" : (url.startsWith("hy2://") ? "hy2://" : null);
  if (!scheme) throw new Error(t("sb.err.notHy2"));
  const rest = url.slice(scheme.length);
  const { name, main } = splitTrailingHashName(rest, "HYSTERIA2");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.hy2HostPort"));
  const password = decodeURIComponent(head.slice(0, atIdx));
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.hy2HostPort");
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "hysteria2", name,
    host, port, password,
    sni: get("sni") || host,
    obfs: get("obfs", ""),
    obfsPassword: get("obfs-password") || get("obfsPassword", ""),
    alpn: get("alpn", "h3"),
    insecure: boolParam(get("insecure")),
    pinSHA256: get("pinSHA256", ""),
    upMbps: parseInt(get("up") || "0", 10) || undefined,
    downMbps: parseInt(get("down") || "0", 10) || undefined,
  };
}

// ── tuic v5 ────────────────────────────────────────────────
export function parseTuic(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("tuic://")) throw new Error(t("sb.err.notTuic"));
  const rest = url.slice("tuic://".length);
  const { name, main } = splitTrailingHashName(rest, "TUIC");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.tuicHostPort"));
  const auth = head.slice(0, atIdx);
  const [uuid, passwordRaw] = splitFirstColon(auth);
  const password = decodeURIComponent(passwordRaw || "");
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.tuicHostPort");
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "tuic", name,
    host, port, uuid, password,
    sni: get("sni") || host,
    alpn: get("alpn", "h3"),
    congestionControl: get("congestion_control") || get("congestionControl", "bbr"),
    udpRelayMode: get("udp_relay_mode") || get("udpRelayMode", "native"),
    zeroRttHandshake: boolParam(get("zero_rtt_handshake")),
    disableSni: boolParam(get("disable_sni")),
    // Поле читает buildOutbound (tls.insecure). Без него нода TUIC с
    // самоподписанным сертификатом молча не вставала: ссылка про это говорила,
    // парсер — нет. Панели пишут и `insecure`, и `allow_insecure`.
    insecure: boolParam(get("insecure") || get("allow_insecure")),
  };
}

// ── anytls ──────────────────────────────────────────────────
// anytls://password@host:port?sni=&insecure=&alpn=#name — формат, на котором
// сошлись клиенты экосистемы sing-box. Транспорта у протокола нет: он всегда
// поверх TLS, поэтому type/flow здесь бессмысленны.
export function parseAnyTls(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("anytls://")) throw new Error(t("sb.err.notAnyTls"));
  const rest = url.slice("anytls://".length);
  const { name, main } = splitTrailingHashName(rest, "AnyTLS");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.anytlsHostPort"));
  const password = safeDecode(head.slice(0, atIdx));
  if (!password) throw new Error(t("sb.err.anytlsPassword"));
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.anytlsHostPort");
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "anytls", name,
    host, port, password,
    sni: get("sni") || get("peer") || host,
    fp: get("fp", "chrome"),
    alpn: get("alpn", ""),
    insecure: boolParam(get("insecure") || get("allowInsecure") || get("allow_insecure")),
  };
}

// ── hysteria v1 ─────────────────────────────────────────────
// hysteria://host:port?auth=…&peer=…&upmbps=&downmbps=&obfs=…&protocol=udp
// Первая версия протокола: аутентификация строкой, обфускация — общий секрет
// (не salamander, как в hysteria2), скорости обязательны для его контроллера.
export function parseHysteria(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("hysteria://")) throw new Error(t("sb.err.notHysteria"));
  const rest = url.slice("hysteria://".length);
  const { name, main } = splitTrailingHashName(rest, "HYSTERIA");
  const { head, query } = splitQuery(main);
  // Учётные данные у v1 живут в query (auth/auth_str), а не в userinfo.
  const hostPart = head.includes("@") ? head.slice(head.lastIndexOf("@") + 1) : head;
  const { host, port } = splitHostPort(hostPart, "sb.err.hysteriaHostPort");
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "hysteria", name,
    host, port,
    authString: safeDecode(get("auth") || get("auth_str") || get("authStr", "")),
    sni: get("peer") || get("sni") || host,
    alpn: get("alpn", ""),
    obfs: safeDecode(get("obfs", "")),
    // v1 в sing-box работает только поверх обычного UDP: faketcp и
    // wechat-video из оригинального клиента ядро не реализует.
    hysteriaProtocol: get("protocol", "udp"),
    upMbps: parseInt(get("upmbps") || get("up") || "0", 10) || undefined,
    downMbps: parseInt(get("downmbps") || get("down") || "0", 10) || undefined,
    insecure: boolParam(get("insecure") || get("allowInsecure")),
  };
}

// ── SOCKS ───────────────────────────────────────────────────
// socks://[user:pass@]host:port#name (а также socks5/socks5h/socks4/socks4a).
// Обычный прокси без шифрования: полезен как промежуточное звено или локальный
// клиент чужого движка. http-прокси-ссылки намеренно не поддержаны: http(s)://
// в этом же поле означает адрес подписки, и различить их надёжно нельзя.
const SOCKS_SCHEMES = {
  "socks://": "5", "socks5://": "5", "socks5h://": "5",
  "socks4://": "4", "socks4a://": "4a",
};
export function parseSocks(raw) {
  const url = String(raw || "").trim();
  const scheme = Object.keys(SOCKS_SCHEMES).find(prefix => url.toLowerCase().startsWith(prefix));
  if (!scheme) throw new Error(t("sb.err.notSocks"));
  const rest = url.slice(scheme.length);
  const { name, main } = splitTrailingHashName(rest, "SOCKS");
  const { head } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  let username = "", password = "";
  if (atIdx >= 0) {
    const cred = head.slice(0, atIdx);
    // v2rayN пишет userinfo и открытым текстом, и base64url — берём то, что
    // после декода похоже на пару «логин:пароль».
    const decoded = cred.includes(":") ? cred : (safeDecodeBase64(cred) || cred);
    const [user, pass] = splitFirstColon(decoded);
    username = safeDecode(user || "");
    password = safeDecode(pass || "");
  }
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.socksHostPort");
  return {
    raw: url, proto: "socks", name,
    host, port, username, password,
    version: SOCKS_SCHEMES[scheme],
  };
}

// ── NaiveProxy ──────────────────────────────────────────────
// Формат подписки: naive+https://user:pass@host:port#name (также naive+quic://).
// Внутри после naive+ лежит ровно значение `proxy` клиента naive (klzgrad).
// Движок — sidecar naive.exe на стеке Chromium; в sing-box идёт socks-мост.
export function parseNaive(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("naive+")) throw new Error(t("sb.err.notNaive"));
  const inner = url.slice("naive+".length); // https://user:pass@host:port#name
  const scheme = inner.startsWith("https://") ? "https" : (inner.startsWith("quic://") ? "quic" : null);
  if (!scheme) throw new Error(t("sb.err.naiveScheme"));
  const rest = inner.slice(`${scheme}://`.length);
  const { name, main } = splitTrailingHashName(rest, "Naive");
  const { head } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.naiveUserPassHost"));
  const cred = head.slice(0, atIdx);
  const colon = cred.indexOf(":");
  if (colon < 0) throw new Error(t("sb.err.naiveUserPass"));
  const username = decodeURIComponent(cred.slice(0, colon));
  const password = decodeURIComponent(cred.slice(colon + 1));
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.naivePort");
  return { raw: url, proto: "naive", name, host, port, username, password, scheme };
}

// ── TrustTunnel (AdGuard, Apache-2.0) ───────────────────────
// Два источника одной и той же конфигурации: deep-link tt://?<base64url TLV>
// и endpoint-.toml (export from endpoint). Оба -> единый профиль. Движок —
// sidecar trusttunnel_client.exe в режиме [listener.socks]; sing-box socks-мост.

// QUIC/TLS variable-length integer (RFC 9000 §16): 2 старших бита первого байта
// задают размер (00->1,01->2,10->4,11->8 байт), big-endian, без верхних 2 бит.
function readQuicVarint(buf, pos) {
  if (pos >= buf.length) throw new Error(t("sb.err.ttVarintOOB"));
  const first = buf[pos];
  const lenLog = first >> 6;            // 0..3
  const n = 1 << lenLog;                // 1,2,4,8
  if (pos + n > buf.length) throw new Error(t("sb.err.ttVarintTrunc"));
  let v = BigInt(first & 0x3f);
  for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(buf[pos + i]);
  return { value: Number(v), next: pos + n };
}

const TT_UPSTREAM = { 1: "http2", 2: "http3" };

// Разбор TLV-пейлоада (после base64url-декода) в поля endpoint-конфига.
function parseTrustTunnelTlv(buf) {
  const td = new TextDecoder();
  const f = { addresses: [], dnsUpstreams: [] };
  let pos = 0;
  while (pos < buf.length) {
    const typeVarint = readQuicVarint(buf, pos); pos = typeVarint.next;
    const lengthVarint = readQuicVarint(buf, pos); pos = lengthVarint.next;
    const end = pos + lengthVarint.value;
    if (end > buf.length) throw new Error(t("sb.err.ttTlvOOB"));
    const val = buf.subarray(pos, end);
    const str = () => td.decode(val);
    const bool = () => val.length >= 1 && val[0] === 0x01;
    switch (typeVarint.value) {
      case 0x00: f.version = readQuicVarint(val, 0).value; break;
      case 0x01: f.hostname = str(); break;
      case 0x02: f.addresses.push(str()); break;          // повторяемый
      case 0x03: f.customSni = str(); break;
      case 0x04: f.hasIpv6 = bool(); break;
      case 0x05: f.username = str(); break;
      case 0x06: f.password = str(); break;
      case 0x07: f.skipVerification = bool(); break;
      case 0x08: f.certificateDer = Uint8Array.from(val); break; // DER (raw)
      case 0x09: f.upstreamProtocol = TT_UPSTREAM[readQuicVarint(val, 0).value] || "http2"; break;
      case 0x0A: f.antiDpi = bool(); break;
      case 0x0B: f.clientRandom = str(); break;
      case 0x0C: f.name = str(); break;
      case 0x0D: {                                         // String[] dns_upstreams
        let p = 0;
        while (p < val.length) {
          const ln = readQuicVarint(val, p); p = ln.next;
          f.dnsUpstreams.push(td.decode(val.subarray(p, p + ln.value)));
          p += ln.value;
        }
        break;
      }
      default: break; // неизвестные теги игнорируем (forward-compat, см. спеку)
    }
    pos = end;
  }
  if (!f.hostname || !f.addresses.length || f.username == null || f.password == null) {
    throw new Error(t("sb.err.ttDeeplinkFields"));
  }
  return f;
}

// Deep-link отдаёт сертификат сырым DER (TLV 0x08), .toml — готовым PEM.
// trusttunnel_client понимает только PEM, поэтому конвертируем здесь: иначе
// узел из tt:// уходил в мост вообще без своего CA и падал на TLS, тогда как
// тот же endpoint из .toml работал. Uint8Array в профиле не оставляем — в
// JSON-хранилище он превращается в {"0":..,"1":..}.
function pemFromDer(der) {
  if (!der || !der.length) return "";
  let bin = "";
  for (let i = 0; i < der.length; i++) bin += String.fromCharCode(der[i]);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// Сборка профиля trusttunnel из полей (общая для deep-link и .toml).
function ttProfile(f, rawForStorage) {
  const first = f.addresses[0] || "";
  let host = f.hostname, port = 443;
  try { const hp = splitHostPort(first); host = hp.host || f.hostname; port = hp.port || 443; } catch {}
  return {
    raw: rawForStorage,
    proto: "trusttunnel",
    name: f.name || f.hostname || "TrustTunnel",
    host: f.hostname || host, // для отображения — hostname endpoint'а
    port,
    hostname: f.hostname,
    addresses: f.addresses.slice(),
    username: f.username,
    password: f.password,
    skipVerification: !!f.skipVerification,
    upstreamProtocol: f.upstreamProtocol || "http2",
    antiDpi: !!f.antiDpi,
    customSni: f.customSni || "",
    hasIpv6: f.hasIpv6 !== false,
    clientRandom: f.clientRandom || "",
    certificate: f.certificate || pemFromDer(f.certificateDer), // PEM: .toml как есть, deep-link из DER
    dnsUpstreams: (f.dnsUpstreams || []).slice(),
  };
}

export function parseTrustTunnelDeepLink(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("tt://")) throw new Error(t("sb.err.notTt"));
  // tt://?<payload> — payload в query-части (case-sensitive), без префикса '?'
  const q = url.indexOf("?");
  if (q < 0) throw new Error(t("sb.err.ttNoPayload"));
  const payload = url.slice(q + 1).split(/[#&]/)[0];
  if (!payload) throw new Error(t("sb.err.ttEmptyPayload"));
  const f = parseTrustTunnelTlv(bytesFromB64url(payload));
  return ttProfile(f, url);
}

// Мини-парсер endpoint-.toml (плоский: key = value, массивы строк, без секций).
// Достаточно для конфига, который экспортирует endpoint (см. trusttunnel_nl.toml).
export function parseTrustTunnelToml(text, displayName) {
  const src = String(text || "");
  const get = (key) => {
    const m = src.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m"));
    return m ? m[1].trim() : undefined;
  };
  const unescapeBasic = (s) => s.replace(/\\(["\\btnfrt])/g, (_, c) => ({
    '"': '"', "\\": "\\", b: "\b", t: "\t", n: "\n", f: "\f", r: "\r",
  })[c]);
  const unq = (v) => {
    if (v == null) return v;
    const s = String(v).trim();
    if (s.startsWith('"""') || s.startsWith("'''")) {
      throw new Error(t("sb.err.ttTomlFields"));
    }
    if (s.startsWith('"') && s.endsWith('"')) return unescapeBasic(s.slice(1, -1));
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return s;
  };
  const arr = (v) => {
    if (v == null) return [];
    const m = v.match(/\[(.*)\]/s);
    if (!m) return [];
    const items = [];
    let cur = "", quote = "", esc = false;
    for (const ch of m[1]) {
      if (esc) { cur += "\\" + ch; esc = false; continue; }
      if (quote === '"' && ch === "\\") { esc = true; continue; }
      if (quote) {
        if (ch === quote) quote = "";
        cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === ",") { items.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (quote || esc) throw new Error(t("sb.err.ttTomlFields"));
    items.push(cur);
    return items.map(s => unq(s.trim())).filter(Boolean);
  };
  const boolv = (v, d) => (v == null ? d : /true/i.test(v));
  const hostname = unq(get("hostname"));
  const addresses = arr(get("addresses"));
  const username = unq(get("username"));
  const password = unq(get("password"));
  if (!hostname || !addresses.length || !username || password == null) {
    throw new Error(t("sb.err.ttTomlFields"));
  }
  const up = (unq(get("upstream_protocol")) || "http2").toLowerCase();
  const f = {
    hostname, addresses, username, password,
    skipVerification: boolv(get("skip_verification"), false),
    upstreamProtocol: up === "http3" ? "http3" : "http2",
    antiDpi: boolv(get("anti_dpi"), false),
    customSni: unq(get("custom_sni")) || "",
    hasIpv6: boolv(get("has_ipv6"), true),
    clientRandom: unq(get("client_random")) || "",
    certificate: unq(get("certificate")) || "",
    dnsUpstreams: arr(get("dns_upstreams")),
    name: unq(get("name")) || displayName || hostname,
  };
  return ttProfile(f, `tt-toml://${hostname}`); // raw — синтетический маркер для storage
}

// ── главный dispatcher ─────────────────────────────────────
// Возвращает профиль с .proto полем. Назад-совместимо со старыми vless-only
// профилями (у тех .proto не было; считаем "vless").
export function parseLink(raw) {
  const s = String(raw || "").trim();
  if (s.startsWith("vless://"))     return { ...parseVless(s), proto: "vless" };
  if (s.startsWith("vmess://"))     return parseVmess(s);
  if (s.startsWith("trojan://"))    return parseTrojan(s);
  if (s.startsWith("ss://"))        return parseShadowsocks(s);
  if (s.startsWith("hysteria2://") || s.startsWith("hy2://")) return parseHysteria2(s);
  if (s.startsWith("hysteria://"))  return parseHysteria(s);
  if (s.startsWith("anytls://"))    return parseAnyTls(s);
  if (/^socks(5h?|4a?)?:\/\//i.test(s)) return parseSocks(s);
  if (s.startsWith("tuic://"))      return parseTuic(s);
  if (s.startsWith("naive+"))       return parseNaive(s);
  if (s.startsWith("tt://"))        return parseTrustTunnelDeepLink(s);
  throw new Error(t("sb.err.unsupported", { proto: s.split("://")[0] || s.slice(0, 16) }));
}

export function profileProto(p) {
  return p?.proto || "vless";
}
