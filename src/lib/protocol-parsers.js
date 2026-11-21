// Ninety · protocol link parsers.
// A pure layer: input link/endpoint text -> a normalized profile object.

import { t } from "/lib/i18n/index.js";
export { looksLikeOpenvpnConf, openvpnNeedsCredentials, parseOpenvpnConf, openvpnConfText } from "/lib/openvpn.js";
import {
  bytesFromB64url,
  parsePort,
  safeDecode,
  safeDecodeBase64,
  splitHostPort,
  splitQuery,
  splitTrailingHashName,
  withoutUrlPath,
} from "/lib/url-helpers.js";

// Splitting `method:password` / `uuid:password` at the FIRST colon.
// `split(":", 2)` is wrong here: JS split's second argument limits the length of
// the result, not the number of splits, so a password with a colon silently lost
// its tail (`pa:ss` → `pa`). The config still built, the core started, and the node
// failed only on authentication — without a single message.
// A missing separator gives undefined, as the old split did: an empty field must not
// turn into JSON `null` inside the engine config.
// The login/password separator in userinfo: a literal ":" or "%3A" — some
// clients encode the whole userinfo. We take whichever comes first: a
// UUID and an SS method name contain neither, while a password may contain either.
function splitUserinfo(value) {
  const s = String(value ?? "");
  const colon = s.indexOf(":");
  const encoded = s.search(/%3a/i);
  if (colon < 0 && encoded < 0) return null;
  const at = encoded >= 0 && (colon < 0 || encoded < colon) ? encoded : colon;
  const len = at === encoded ? 3 : 1;
  return [s.slice(0, at), s.slice(at + len)];
}

function splitFirstColon(value) {
  const s = String(value ?? "");
  const sep = s.indexOf(":");
  return sep < 0 ? [s, undefined] : [s.slice(0, sep), s.slice(sep + 1)];
}

// A boolean query parameter of a link. The hysteria2 spec describes `insecure=1`, but
// panels return `insecure=true` just as often; TUIC links — the other way around.
// We accept both forms: otherwise a node with a self-signed certificate doesn't come up,
// and the cause ("the certificate didn't verify") isn't visible to the user anywhere.
// Xray renamed transports twice: tcp → raw and splithttp → xhttp. Panels still hand out links
// with the old names. `raw` was already understood, but `splithttp`
// failed transport validation, and the node was silently thrown out of the subscription.
// We normalize on input so that one name lives on further down the code.
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

// ws early data: `ed` — how many bytes can be sent together with
// the handshake, `eh` — in which header. sing-box clients write them as separate
// parameters; the Xray form ("path=/x?ed=2560") is deliberately NOT parsed — the core sends
// a path with a query as is anyway, and the behavior of already working nodes must not be touched
// for cosmetics.
//
// The fields appear in the profile only when they're actually set: the node fingerprint
// is computed from its contents, and a permanent `earlyData: 0` would change the identity
// of all existing nodes — together with the remembered server choice and the quarantine.
function earlyDataFields(params) {
  const raw = params.get("ed");
  const size = parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(size) || size <= 0) return {};
  return {
    earlyData: size,
    earlyDataHeader: params.get("eh") || "Sec-WebSocket-Protocol",
  };
}

// Self-signed certificate: panels write both allowInsecure and insecure.
function insecureField(params) {
  const value = params.get("allowInsecure") ?? params.get("insecure");
  return boolParam(value) ? { insecure: true } : {};
}

// ── vless parser ────────────────────────────────────────────
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
  // The UUID arrives percent-encoded just like the passwords of other schemes: panels
  // escape it like the rest of the userinfo. An empty UUID would build a config
  // that fails in the core on authentication — we catch it here.
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
    // mKCP: packet masking and the shared obfuscation secret. Without them a node with
    // type=kcp was built as regular TCP and silently didn't work.
    headerType: get("headerType") || get("headertype", ""),
    seed: get("seed", ""),
    // v2ray QUIC: the core supports only "raw" QUIC without additional transport
    // encryption, so the value is checked rather than carried over.
    quicSecurity: get("quicSecurity") || get("quicsecurity", ""),
    ...earlyDataFields(params),
    ...insecureField(params),
  };
}

// ── vmess parser (base64 JSON) ──────────────────────────────
export function parseVmess(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("vmess://")) throw new Error(t("sb.err.notVmess"));
  const payload = url.slice("vmess://".length);
  const { name: hashName, main } = splitTrailingHashName(payload, null);
  // Decode as UTF-8, not via bare atob: that returns a latin1 string
  // where every byte became a separate code point. The vmess payload is UTF-8 JSON,
  // so the node name (ps) from any non-English panel arrived as mojibake,
  // and with it a host and password with non-ASCII.
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
    mode: j.type && j.type !== "none" ? j.type : "",
    ...(j.extra ? { extra: typeof j.extra === "string" ? j.extra : JSON.stringify(j.extra) } : {}),
    // In vmess JSON `type` is the masking header, and for mKCP `path` carries
    // the obfuscation seed: for other transports both fields mean something else.
    headerType: j.type || "",
    seed: j.net === "kcp" ? (j.path || "") : "",
    // Early data and a self-signed certificate: the original v2rayN format
    // doesn't have these fields, clients add them. We read them so that a config
    // imported from a ready sing-box comes back without losses;
    // missing fields don't get into the profile — see earlyDataFields.
    ...earlyDataFields(new URLSearchParams({
      ...(j.ed ? { ed: String(j.ed) } : {}),
      ...(j.eh ? { eh: String(j.eh) } : {}),
    })),
    ...(boolParam(j.allowInsecure ?? j.insecure) ? { insecure: true } : {}),
  };
}

// ── trojan parser ───────────────────────────────────────────
export function parseTrojan(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("trojan://")) throw new Error(t("sb.err.notTrojan"));
  const rest = url.slice("trojan://".length);
  const { name, main } = splitTrailingHashName(rest, "TROJAN");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.trojanHostPort"));
  const password = safeDecode(head.slice(0, atIdx));
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
    ...earlyDataFields(query),
    ...insecureField(query),
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
    // UTF-8 decoding for the same reason as in parseVmess: a password with non-ASCII otherwise
    // goes into the config garbled byte by byte and the node fails on authentication.
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
  // SIP002: userinfo may be exactly base64url(method:password)
  let method, password;
  // "method:password" or a fully encoded "method%3Apassword"; base64
  // (SIP002) contains neither ":" nor "%", so the branch is unambiguous.
  const parts = splitUserinfo(credsRaw);
  if (parts) {
    // safeDecode on both halves: panels escape the method too, and a broken
    // %-escape in the password used to crash decodeURIComponent and the whole link import.
    method = safeDecode(parts[0]);
    password = safeDecode(parts[1]);
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
// Port hopping: "host:443,20000-30000" per the Hysteria spec
// and the mport=20000-30000 parameter in v2rayN. The core accepts such a node with a server_ports
// list ("start:end") instead of a single server_port; the profile's main port
// is the first one in the list, which is also what the interface shows. Without a port at all
// the spec implies 443.
const HY2_PORT_ITEM = /^(\d{1,5})(?:-(\d{1,5}))?$/;

function hysteria2PortRanges(spec) {
  const ranges = [];
  for (const item of String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = item.match(HY2_PORT_ITEM);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] == null ? from : Number(m[2]);
    if (from < 1 || to > 65535 || from > to) return null;
    ranges.push([from, to]);
  }
  return ranges;
}

function splitHysteria2Endpoint(rawHostPort, mport) {
  const hostPort = withoutUrlPath(rawHostPort);
  const close = hostPort.startsWith("[") ? hostPort.indexOf("]") : -1;
  if (hostPort.startsWith("[") && close < 0) throw new Error(t("sb.err.badIpv6"));
  const sep = close >= 0 ? close + 1 : hostPort.lastIndexOf(":");
  const hasPort = sep >= 0 && hostPort[sep] === ":";
  const host = close >= 0 ? hostPort.slice(1, close) : (hasPort ? hostPort.slice(0, sep) : hostPort);
  const spec = hasPort ? hostPort.slice(sep + 1) : "";
  const main = hasPort ? hysteria2PortRanges(spec) : [[443, 443]];
  const extra = hysteria2PortRanges(mport);
  if (!host || !main?.length || !extra) throw new Error(t("sb.err.hy2HostPort"));
  const ranges = [...main, ...extra];
  const port = ranges[0][0];
  const hopping = ranges.length > 1 || ranges[0][0] !== ranges[0][1];
  return hopping ? { host, port, ports: ranges.map(([from, to]) => `${from}:${to}`) } : { host, port };
}

export function parseHysteria2(raw) {
  const url = String(raw || "").trim();
  const scheme = url.startsWith("hysteria2://") ? "hysteria2://" : (url.startsWith("hy2://") ? "hy2://" : null);
  if (!scheme) throw new Error(t("sb.err.notHy2"));
  const rest = url.slice(scheme.length);
  const { name, main } = splitTrailingHashName(rest, "HYSTERIA2");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.hy2HostPort"));
  const password = safeDecode(head.slice(0, atIdx));
  const { host, port, ports } = splitHysteria2Endpoint(head.slice(atIdx + 1), query.get("mport"));
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "hysteria2", name,
    host, port, password,
    // The field appears only for nodes with port hopping: the node fingerprint is computed
    // from the contents, and an extra field would change the identity of all old nodes.
    ...(ports ? { ports } : {}),
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
  // "uuid:password" or a fully encoded "uuid%3Apassword" — without the second
  // variant the node went to the rejected ones with an empty password.
  const parts = splitUserinfo(auth);
  const uuid = safeDecode(parts ? parts[0] : auth).trim();
  const password = safeDecode(parts ? parts[1] : "");
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
    // The field is read by buildOutbound (tls.insecure). Without it a TUIC node with
    // a self-signed certificate silently didn't come up: the link said so,
    // the parser didn't. Panels write both `insecure` and `allow_insecure`.
    insecure: boolParam(get("insecure") || get("allow_insecure")),
  };
}

// ── anytls ──────────────────────────────────────────────────
// anytls://password@host:port?sni=&insecure=&alpn=#name — the format the sing-box
// ecosystem clients settled on. The protocol has no transport: it's always
// over TLS, so type/flow are meaningless here.
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

// ── Mieru ──────────────────────────────────────────────────
// A simple mierus:// link: port and protocol repeat and form pairs in
// order. The core accepts one transport, so if TCP is present we take it,
// otherwise UDP. A full mieru:// contains protobuf and isn't parsed here.
export function parseMieru(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("mierus://")) throw new Error(t("sb.err.notMieru"));
  const rest = url.slice("mierus://".length);
  const { name: hashName, main } = splitTrailingHashName(rest, "");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error(t("sb.err.mieruAuth"));
  const [user, pass] = splitFirstColon(head.slice(0, atIdx));
  const username = safeDecode(user || "");
  const password = safeDecode(pass || "");
  if (!username || !password) throw new Error(t("sb.err.mieruAuth"));
  const endpoint = withoutUrlPath(head.slice(atIdx + 1));
  const host = endpoint.startsWith("[") && endpoint.endsWith("]") ? endpoint.slice(1, -1) : endpoint;
  if (!host || (endpoint.includes(":") && !(endpoint.startsWith("[") && endpoint.endsWith("]")))) {
    throw new Error(t("sb.err.mieruAuth"));
  }
  const bindings = query.getAll("port");
  const protocols = query.getAll("protocol");
  if (!bindings.length || bindings.length !== protocols.length) {
    throw new Error(t("sb.err.mieruPorts"));
  }
  const parsed = bindings.map((binding, index) => {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(binding);
    if (!match) throw new Error(t("sb.err.badPort"));
    const from = parsePort(match[1]);
    const to = match[2] === undefined ? from : parsePort(match[2]);
    if (from > to) throw new Error(t("sb.err.badPort"));
    const transport = protocols[index];
    if (transport !== "TCP" && transport !== "UDP") throw new Error(t("sb.err.mieruPorts"));
    return { from, to, range: match[2] !== undefined, transport };
  });
  const transport = parsed.some(binding => binding.transport === "TCP") ? "TCP" : "UDP";
  const selected = parsed.filter(binding => binding.transport === transport);
  const single = selected.find(binding => !binding.range);
  const port = single ? single.from : selected[0].from;
  // Additional single ports are passed as single-port ranges:
  // there's one server_port in the config, while server_ports can contain several.
  const ports = selected.filter(binding => binding !== single).map(binding => `${binding.from}-${binding.to}`);
  const optional = {};
  for (const [key, field] of [["multiplexing", "multiplexing"], ["handshake-mode", "handshakeMode"]]) {
    if (query.has(key)) optional[field] = query.get(key);
  }
  if (query.has("mtu")) optional.mtu = Number(query.get("mtu"));
  if (query.has("traffic-pattern")) {
    // base64 contains "+": we don't turn it into a space as form-urlencoded does.
    const queryText = main.slice(main.indexOf("?") + 1);
    const item = queryText.split("&").find(part => safeDecode(part.split("=", 1)[0]) === "traffic-pattern");
    const valueAt = item.indexOf("=");
    optional.trafficPattern = valueAt < 0 ? "" : safeDecode(item.slice(valueAt + 1));
  }
  return {
    raw: url, proto: "mieru", name: hashName || query.get("profile") || host,
    host, port, transport, username, password,
    ...(ports.length ? { ports } : {}),
    // There's no single port: .port is just the start of the first range for the list and
    // measurements, it must not go into the core config. The field is present only when true.
    ...(single ? {} : { rangesOnly: true }),
    ...optional,
  };
}

// ── hysteria v1 ─────────────────────────────────────────────
// hysteria://host:port?auth=…&peer=…&upmbps=&downmbps=&obfs=…&protocol=udp
// The first protocol version: authentication by string, obfuscation is a shared secret
// (not salamander as in hysteria2), speeds are mandatory for its controller.
export function parseHysteria(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("hysteria://")) throw new Error(t("sb.err.notHysteria"));
  const rest = url.slice("hysteria://".length);
  const { name, main } = splitTrailingHashName(rest, "HYSTERIA");
  const { head, query } = splitQuery(main);
  // v1 credentials live in the query (auth/auth_str), not in userinfo.
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
    // v1 in sing-box works only over regular UDP: the core doesn't implement faketcp and
    // wechat-video from the original client.
    hysteriaProtocol: get("protocol", "udp"),
    upMbps: parseInt(get("upmbps") || get("up") || "0", 10) || undefined,
    downMbps: parseInt(get("downmbps") || get("down") || "0", 10) || undefined,
    insecure: boolParam(get("insecure") || get("allowInsecure")),
  };
}

// ── SOCKS ───────────────────────────────────────────────────
// socks://[user:pass@]host:port#name (also socks5/socks5h/socks4/socks4a).
// A regular proxy without encryption: useful as an intermediate hop or a local
// client of another engine. http proxy links are deliberately not supported: http(s)://
// in this same field means a subscription address, and they can't be reliably told apart.
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
    // v2rayN writes userinfo both in plain text and as base64url — we take whatever
    // looks like a "login:password" pair after decoding.
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
// Subscription format: naive+https://user:pass@host:port#name (also naive+quic://).
// What follows naive+ is exactly the `proxy` value of the naive client (klzgrad).
// The engine is the naive.exe sidecar on the Chromium stack; a socks bridge goes into sing-box.
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
  const username = safeDecode(cred.slice(0, colon));
  const password = safeDecode(cred.slice(colon + 1));
  const { host, port } = splitHostPort(head.slice(atIdx + 1), "sb.err.naivePort");
  return { raw: url, proto: "naive", name, host, port, username, password, scheme };
}

// ── TrustTunnel (AdGuard, Apache-2.0) ───────────────────────
// Two sources of the same configuration: the deep link tt://?<base64url TLV>
// and the endpoint .toml (export from endpoint). Both -> one profile. The engine is
// the trusttunnel_client.exe sidecar in [listener.socks] mode; a sing-box socks bridge.

// QUIC/TLS variable-length integer (RFC 9000 §16): the 2 high bits of the first byte
// set the size (00->1,01->2,10->4,11->8 bytes), big-endian, without the top 2 bits.
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

// Parsing the TLV payload (after base64url decoding) into endpoint config fields.
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
      case 0x02: f.addresses.push(str()); break;          // repeatable
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
      default: break; // unknown tags are ignored (forward-compat, see the spec)
    }
    pos = end;
  }
  if (!f.hostname || !f.addresses.length || f.username == null || f.password == null) {
    throw new Error(t("sb.err.ttDeeplinkFields"));
  }
  return f;
}

// The deep link gives the certificate as raw DER (TLV 0x08), .toml as ready PEM.
// trusttunnel_client understands only PEM, so we convert here: otherwise
// a node from tt:// went into the bridge without its CA at all and failed on TLS, while
// the same endpoint from .toml worked. We don't leave a Uint8Array in the profile — in
// JSON storage it turns into {"0":..,"1":..}.
function pemFromDer(der) {
  if (!der || !der.length) return "";
  let bin = "";
  for (let i = 0; i < der.length; i++) bin += String.fromCharCode(der[i]);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// Building a trusttunnel profile from fields (shared by the deep link and .toml).
function ttProfile(f, rawForStorage) {
  const first = f.addresses[0] || "";
  let host = f.hostname, port = 443;
  try { const hp = splitHostPort(first); host = hp.host || f.hostname; port = hp.port || 443; } catch {}
  return {
    raw: rawForStorage,
    proto: "trusttunnel",
    name: f.name || f.hostname || "TrustTunnel",
    host: f.hostname || host, // for display — the endpoint's hostname
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
    certificate: f.certificate || pemFromDer(f.certificateDer), // PEM: .toml as is, deep link from DER
    dnsUpstreams: (f.dnsUpstreams || []).slice(),
  };
}

export function parseTrustTunnelDeepLink(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("tt://")) throw new Error(t("sb.err.notTt"));
  // tt://?<payload> — the payload in the query part (case-sensitive), without the '?' prefix
  const q = url.indexOf("?");
  if (q < 0) throw new Error(t("sb.err.ttNoPayload"));
  const payload = url.slice(q + 1).split(/[#&]/)[0];
  if (!payload) throw new Error(t("sb.err.ttEmptyPayload"));
  const f = parseTrustTunnelTlv(bytesFromB64url(payload));
  return ttProfile(f, url);
}

// A mini parser of the endpoint .toml (flat: key = value, string arrays, no sections).
// Enough for the config the endpoint exports (see trusttunnel_nl.toml).
export function parseTrustTunnelToml(text, displayName) {
  const lines = String(text || "").split(/\r?\n/);
  // A comment is cut only outside quotes: "skip_verification = false # true"
  // otherwise read as true and disabled certificate verification.
  const stripComment = (line) => {
    let quote = "", esc = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (esc) { esc = false; continue; }
      if (quote === '"' && ch === "\\") { esc = true; continue; }
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "#") return line.slice(0, i).trim();
    }
    return line.trim();
  };
  const get = (key) => {
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      let value = stripComment(m[1]);
      // A multiline array is collected up to the closing bracket.
      if (value.startsWith("[") && !value.includes("]")) {
        for (let j = i + 1; j < lines.length; j++) {
          const part = stripComment(lines[j]);
          value += ` ${part}`;
          if (part.includes("]")) break;
        }
      }
      return value;
    }
    return undefined;
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
  const boolv = (v, d) => (v == null ? d : /^true$/i.test(unq(v)));
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
  return ttProfile(f, `tt-toml://${hostname}`); // raw — a synthetic marker for storage
}

// ── WireGuard / AmneziaWG .conf ────────────────────────────
// A file, not a link: the user pastes the .conf contents as text or
// drags the file in. The format is the same ini that wg-quick and Amnezia read,
// so we parse it literally, including AmneziaWG shaping (Jc/Jmin/Jmax,
// S1..S4, H1..H4, I1..I5) — otherwise a paid profile is imported into a client
// that speaks the wrong protocol to the peer and silently doesn't come up.
// AmneziaWG 2.0 is S3/S4 and "100-200" ranges in H1..H4; AmneziaWG 3 is
// HeaderProtectionKey, ContentPaddingAddition and RandomTrailers.

// The keys we read. Everything else goes into profile.ignored and
// is shown to the user: a silently lost line from a .conf is a tunnel
// that behaves differently than in Amnezia, without a single word why.
const WG_INTERFACE_KEYS = new Set([
  "privatekey", "address", "mtu", "listenport",
  "jc", "jmin", "jmax", "s1", "s2", "s3", "s4",
  "h1", "h2", "h3", "h4",
  "i1", "i2", "i3", "i4", "i5",
  "headerprotectionkey", "contentpaddingaddition", "randomtrailers",
]);
const WG_PEER_KEYS = new Set([
  "publickey", "presharedkey", "allowedips", "endpoint", "persistentkeepalive",
]);

export function looksLikeWireguardConf(text) {
  const s = String(text || "");
  return /^\s*\[interface\]/im.test(s) && /^\s*privatekey\s*=/im.test(s);
}

// The core decodes keys as regular base64 and requires exactly 32 bytes. A malformed
// key brings down the whole config at initialization, so we catch it here.
function wgKeyValid(value) {
  const s = String(value || "").trim();
  if (!/^[A-Za-z0-9+/]{42,43}=*$/.test(s)) return false;
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/")).length === 32;
  } catch {
    return false;
  }
}

function wgList(value) {
  return String(value || "").split(",").map(x => x.trim()).filter(Boolean);
}

function wgNumber(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

const UINT32_MAX = 0xFFFFFFFF;

/**
 * The AmneziaWG magic header (H1..H4) in profile form: a number for 1.x,
 * a "from-to" string for a 2.0 range. A single value stays a number so that
 * old profiles' fingerprint doesn't change. Empty — 0, garbage — null.
 * @returns {number|string|null}
 */
export function parseAwgHeader(raw) {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= UINT32_MAX ? raw : null;
  }
  const text = String(raw).trim();
  if (!text) return 0;
  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(text);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from > UINT32_MAX || to > UINT32_MAX || to < from) return null;
  return from === to ? from : `${from}-${to}`;
}

/** Profile header → {from, to}; 0/empty → null. */
export function awgHeaderRange(value) {
  const parsed = parseAwgHeader(value);
  if (!parsed) return null;
  if (typeof parsed === "number") return { from: parsed, to: parsed };
  const [from, to] = parsed.split("-").map(Number);
  return { from, to };
}

/** The profile uses AmneziaWG 3: header protection, content padding or trailers. */
export function isAmneziaWg3(awg) {
  return !!awg && (!!awg.headerProtectionKey || !!awg.contentPaddingAddition || awg.randomTrailers === true);
}

// RandomTrailers in .conf is "on/off"; Amnezia also writes true/false.
function wgSwitch(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(text)) return true;
  if (["off", "false", "0", "no", ""].includes(text)) return false;
  return null;
}

/** The profile uses what AmneziaWG 1.x doesn't have: S3/S4 or H ranges. */
export function isAmneziaWg2(awg) {
  if (!awg) return false;
  if (Number(awg.s3) > 0 || Number(awg.s4) > 0) return true;
  return ["h1", "h2", "h3", "h4"].some((key) => {
    const range = awgHeaderRange(awg[key]);
    return !!range && range.from !== range.to;
  });
}

// [Interface]/[Peer] in ini style: sections, `key = value`, # and ; comments.
// There may be several peers — we store all of them and take the first for display.
function parseWireguardIni(text) {
  const iface = {};
  const peers = [];
  const ignored = [];
  let current = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      const name = section[1].trim().toLowerCase();
      if (name === "interface") {
        current = iface;
      } else if (name === "peer") {
        current = {};
        peers.push(current);
      } else {
        current = null;
        ignored.push(`[${section[1].trim()}]`);
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !current) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const lower = key.toLowerCase();
    const known = current === iface ? WG_INTERFACE_KEYS : WG_PEER_KEYS;
    if (!known.has(lower)) {
      // DNS from the file goes here too: DNS routing in Ninety is managed by its own
      // settings section, and it must not be overridden by a line from someone else's profile.
      if (!ignored.includes(key)) ignored.push(key);
      continue;
    }
    current[lower] = value;
  }
  return { iface, peers, ignored };
}

export function parseWireguardConf(text, displayName) {
  const src = String(text || "");
  if (!looksLikeWireguardConf(src)) throw new Error(t("sb.err.notWgConf"));
  const { iface, peers, ignored } = parseWireguardIni(src);

  if (!wgKeyValid(iface.privatekey)) throw new Error(t("sb.err.wgPrivateKey"));
  const addresses = wgList(iface.address);
  if (!addresses.length) throw new Error(t("sb.err.wgAddress"));

  const parsedPeers = peers.map((peer) => {
    if (!wgKeyValid(peer.publickey)) throw new Error(t("sb.err.wgPublicKey"));
    if (peer.presharedkey && !wgKeyValid(peer.presharedkey)) {
      throw new Error(t("sb.err.wgPresharedKey"));
    }
    if (!peer.endpoint) throw new Error(t("sb.err.wgEndpoint"));
    const { host, port } = splitHostPort(peer.endpoint, "sb.err.wgEndpoint");
    if (!host || !port) throw new Error(t("sb.err.wgEndpoint"));
    return {
      host,
      port,
      publicKey: peer.publickey.trim(),
      presharedKey: (peer.presharedkey || "").trim(),
      // A client .conf almost always routes all traffic into the tunnel;
      // the core rejects an empty AllowedIPs, so we substitute both defaults.
      allowedIps: wgList(peer.allowedips).length ? wgList(peer.allowedips) : ["0.0.0.0/0", "::/0"],
      keepalive: wgNumber(peer.persistentkeepalive),
    };
  });
  if (!parsedPeers.length) throw new Error(t("sb.err.wgNoPeer"));

  const awg = {
    jc: wgNumber(iface.jc),
    jmin: wgNumber(iface.jmin),
    jmax: wgNumber(iface.jmax),
    s1: wgNumber(iface.s1),
    s2: wgNumber(iface.s2),
    // S3/S4 exist only in 2.0: the field appears when set — otherwise every
    // already saved profile's fingerprint would change.
    ...(wgNumber(iface.s3) ? { s3: wgNumber(iface.s3) } : {}),
    ...(wgNumber(iface.s4) ? { s4: wgNumber(iface.s4) } : {}),
    h1: parseAwgHeader(iface.h1) ?? 0,
    h2: parseAwgHeader(iface.h2) ?? 0,
    h3: parseAwgHeader(iface.h3) ?? 0,
    h4: parseAwgHeader(iface.h4) ?? 0,
    i1: iface.i1 || "",
    i2: iface.i2 || "",
    i3: iface.i3 || "",
    i4: iface.i4 || "",
    i5: iface.i5 || "",
  };
  // AmneziaWG 3. The fields appear only when set: old profiles'
  // fingerprint stays the same.
  const headerKey = String(iface.headerprotectionkey || "").trim();
  if (headerKey) awg.headerProtectionKey = headerKey;
  const contentPadding = parseAwgHeader(iface.contentpaddingaddition);
  if (contentPadding) awg.contentPaddingAddition = contentPadding;
  if (wgSwitch(iface.randomtrailers) === true) awg.randomTrailers = true;

  // A shaping field that failed to parse used to silently become zero:
  // the tunnel spoke the wrong protocol to the peer and didn't come up without a single
  // word why. We don't pass the value to the core, but name the field among
  // the non-portable ones. H1..H4 — a number or a "from-to" range (AmneziaWG 2.0).
  for (const key of ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4"]) {
    const rawValue = String(iface[key] ?? "").trim();
    if (!rawValue) continue;
    const readable = key[0] === "h" ? parseAwgHeader(rawValue) !== null : Number.isFinite(Number(rawValue));
    if (readable) continue;
    const label = key[0].toUpperCase() + key.slice(1);
    if (!ignored.includes(label)) ignored.push(label);
  }
  if (String(iface.contentpaddingaddition ?? "").trim() && parseAwgHeader(iface.contentpaddingaddition) === null) {
    if (!ignored.includes("ContentPaddingAddition")) ignored.push("ContentPaddingAddition");
  }
  if (wgSwitch(iface.randomtrailers) === null && !ignored.includes("RandomTrailers")) {
    ignored.push("RandomTrailers");
  }

  const primary = parsedPeers[0];
  return {
    raw: `wg-conf://${primary.host}:${primary.port}`, // a synthetic marker for storage
    proto: "wireguard",
    name: displayName || primary.host,
    host: primary.host,
    port: primary.port,
    privateKey: iface.privatekey.trim(),
    addresses,
    mtu: wgNumber(iface.mtu) || 0,
    listenPort: wgNumber(iface.listenport) || 0,
    peers: parsedPeers,
    awg,
    ignored,
  };
}

// Back to .conf — in the same format it came in. Needed for exporting the profile
// to another client: WireGuard has no share link of its own.
export function wireguardConfText(profile) {
  const awg = profile?.awg || {};
  const lines = ["[Interface]"];
  lines.push(`PrivateKey = ${profile.privateKey}`);
  lines.push(`Address = ${(profile.addresses || []).join(", ")}`);
  if (profile.mtu) lines.push(`MTU = ${profile.mtu}`);
  if (profile.listenPort) lines.push(`ListenPort = ${profile.listenPort}`);
  for (const key of ["jc", "jmin", "jmax", "s1", "s2", "s3", "s4", "h1", "h2", "h3", "h4"]) {
    if (awg[key]) lines.push(`${key.toUpperCase()} = ${awg[key]}`);
  }
  for (const key of ["i1", "i2", "i3", "i4", "i5"]) {
    if (awg[key]) lines.push(`${key.toUpperCase()} = ${awg[key]}`);
  }
  if (awg.headerProtectionKey) lines.push(`HeaderProtectionKey = ${awg.headerProtectionKey}`);
  if (awg.contentPaddingAddition) lines.push(`ContentPaddingAddition = ${awg.contentPaddingAddition}`);
  if (awg.randomTrailers) lines.push("RandomTrailers = on");
  for (const peer of profile.peers || []) {
    lines.push("", "[Peer]");
    lines.push(`PublicKey = ${peer.publicKey}`);
    if (peer.presharedKey) lines.push(`PresharedKey = ${peer.presharedKey}`);
    lines.push(`AllowedIPs = ${(peer.allowedIps || []).join(", ")}`);
    // wg-quick won't parse an IPv6 address without brackets: the parser strips them on import.
    const endpointHost = String(peer.host).includes(":") ? `[${peer.host}]` : peer.host;
    lines.push(`Endpoint = ${endpointHost}:${peer.port}`);
    if (peer.keepalive) lines.push(`PersistentKeepalive = ${peer.keepalive}`);
  }
  return lines.join("\n") + "\n";
}

// ── main dispatcher ─────────────────────────────────────
// Returns a profile with a .proto field. Backward-compatible with old vless-only
// profiles (those had no .proto; we treat them as "vless").
export function parseLink(raw) {
  const s = String(raw || "").trim();
  if (s.startsWith("vless://"))     return { ...parseVless(s), proto: "vless" };
  if (s.startsWith("vmess://"))     return parseVmess(s);
  if (s.startsWith("trojan://"))    return parseTrojan(s);
  if (s.startsWith("ss://"))        return parseShadowsocks(s);
  if (s.startsWith("hysteria2://") || s.startsWith("hy2://")) return parseHysteria2(s);
  if (s.startsWith("hysteria://"))  return parseHysteria(s);
  if (s.startsWith("anytls://"))    return parseAnyTls(s);
  if (s.startsWith("mierus://"))    return parseMieru(s);
  if (/^socks(5h?|4a?)?:\/\//i.test(s)) return parseSocks(s);
  if (s.startsWith("tuic://"))      return parseTuic(s);
  if (s.startsWith("naive+"))       return parseNaive(s);
  if (s.startsWith("tt://"))        return parseTrustTunnelDeepLink(s);
  throw new Error(t("sb.err.unsupported", { proto: s.split("://")[0] || s.slice(0, 16) }));
}

export function profileProto(p) {
  return p?.proto || "vless";
}

// Xray outbound fields through which the engine reads or writes files itself: the TLS key
// log and certificates from disk. A ready outbound from a subscription goes into xray almost
// as is, and in TUN the bridge inherits administrator rights — the subscription owner
// could point such fields at any path. The bridge doesn't need local paths:
// certificates are given by content. Rust repeats the cleaning before launching xray.
//
// Case doesn't matter: Go's JSON decoder accepts field names case-insensitively.
// A certificate that had only a file path is empty after cleaning, and xray rejects
// such an element when building TLS — and brings down the whole bridge; we remove it.
export function stripXrayFileFields(value) {
  if (Array.isArray(value)) {
    value.forEach(stripXrayFileFields);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      if (lower === "masterkeylog" || lower.endsWith("file")) {
        delete value[key];
        continue;
      }
      stripXrayFileFields(value[key]);
      if (lower === "certificates" && Array.isArray(value[key])) {
        value[key] = value[key].filter((cert) => cert && typeof cert === "object"
          && Object.keys(cert).some((name) => name.toLowerCase() === "certificate"));
        if (!value[key].length) delete value[key];
      }
    }
  }
  return value;
}

// The VLESS encryption format xray accepts: "none" or
// mlkem768x25519plus.<mode>.<0rtt|1rtt>.<parameters and key>. Any other
// value is rejected by xray when building the config — and together with one node it brings down
// the whole bridge with all xray nodes of the subscription.
export function vlessEncryptionValid(value) {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "none") return true;
  return /^mlkem768x25519plus\.(native|xorpub|random)\.(0rtt|1rtt)(\.[A-Za-z0-9_=+/-]+)+$/.test(text);
}

// VLESS encryption (ML-KEM, etc.), if set and not "none"; otherwise null.
// Only xray supports it — the builder and validation decide based on this value.
export function vlessEncryptionOf(node) {
  const value = String(node?.encryption ?? "").trim();
  return profileProto(node) === "vless" && value && value.toLowerCase() !== "none" ? value : null;
}
