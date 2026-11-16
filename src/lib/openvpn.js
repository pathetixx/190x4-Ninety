// Ninety · перенос однофайловых OpenVPN-профилей в endpoint ядра.
// Внешние файлы не читаем: профиль должен оставаться переносимым между ПК.
import { t } from "/lib/i18n/index.js";

const INLINE = new Set(["ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2", "secret", "auth-user-pass"]);
const SILENT = new Set([
  "nobind", "persist-key", "persist-tun", "resolv-retry", "verb", "mute", "mute-replay-warnings",
  "setenv", "script-security", "up", "down", "dhcp-option", "block-outside-dns", "route-method",
  "route-delay", "pull", "tls-client", "float", "sndbuf", "rcvbuf", "push-peer-info", "auth-nocache",
  "register-dns", "server-poll-timeout",
]);
const COMPRESS = new Set(["", "none", "no", "lz4", "lz4-v2", "stub", "stub-v2", "disabled", "off"]);
const LZO = new Set(["", "none", "no", "yes", "adaptive", "asym", "disabled", "off"]);
const ALLOW_COMPRESSION = new Set(["no", "asym", "yes"]);
const TLS_VERSIONS = ["1.0", "1.1", "1.2", "1.3"];

function profileError(key, directive) {
  return new Error(t(`sb.err.${key}`, directive ? { directive } : undefined));
}

// Кавычки сохраняют пробелы (в частности, префикс «route » в pull-filter).
// Комментарий начинается за пределами кавычек на границе аргументов.
function words(line, directive = "profile") {
  const result = [];
  let token = "", quote = "", active = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (!quote && !active && (char === "#" || char === ";")) break;
    if (char === "\\") {
      if (index + 1 >= line.length) throw profileError("ovpnSyntax", directive);
      token += line[++index];
      active = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) result.push(token);
      token = "";
      active = false;
    } else {
      token += char;
      active = true;
    }
  }
  if (quote) throw profileError("ovpnSyntax", directive);
  if (active) result.push(token);
  return result;
}

function readProfile(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || /^[#;]/.test(line)) continue;
    const opening = /^<([\w-]+)>/.exec(line);
    if (opening) {
      const directive = opening[1].toLowerCase();
      const closing = `</${opening[1]}>`;
      let content = lines[index].slice(lines[index].indexOf(">") + 1);
      while (!content.toLowerCase().includes(closing.toLowerCase())) {
        if (++index >= lines.length) throw profileError("ovpnSyntax", directive);
        content += `\n${lines[index]}`;
      }
      const end = content.toLowerCase().indexOf(closing.toLowerCase());
      if (words(content.slice(end + closing.length), directive).length) throw profileError("ovpnSyntax", directive);
      content = content.slice(0, end).replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "");
      entries.push({ directive, args: [], block: content });
      continue;
    }
    const tokens = words(line);
    if (!tokens.length) continue;
    const directive = tokens.shift().replace(/^--/, "").toLowerCase();
    entries.push({ directive, args: tokens });
  }
  return entries;
}

export function looksLikeOpenvpnConf(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  return /^\s*(?:--)?remote\s+\S+/im.test(source)
    && /^\s*(?:(?:--)?(?:client|dev|proto|ca|secret|tls-client|auth-user-pass)(?:\s|$)|<(?:ca|secret)>)/im.test(source);
}

export function openvpnNeedsCredentials(text) {
  try {
    const entries = readProfile(text);
    if (!entries.some(entry => entry.directive === "auth-user-pass")) return false;
    const inline = entries.find(entry => entry.directive === "auth-user-pass" && entry.block !== undefined);
    const [username, password] = String(inline?.block || "").split(/\r?\n/);
    return !username?.trim() || !password;
  } catch {
    return false;
  }
}

function network(value, directive) {
  if (["udp", "udp4", "udp6"].includes(value)) return "udp";
  if (["tcp", "tcp-client", "tcp4", "tcp6", "tcp4-client", "tcp6-client"].includes(value)) return "tcp";
  throw profileError("ovpnOption", directive);
}

function integer(value, directive, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value ?? ""))) throw profileError("ovpnOption", directive);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw profileError("ovpnOption", directive);
  return parsed;
}

function direction(value, directive) {
  if (value === undefined || value === "") return undefined;
  if (value === "0") return "server";
  if (value === "1") return "client";
  throw profileError("ovpnOption", directive);
}

function hasContent(value) {
  return typeof value === "string" ? !!value.trim()
    : Array.isArray(value) && value.length > 0 && value.every(line => typeof line === "string") && value.some(line => line.trim());
}

function addressFamily(value) {
  const match = /^([0-9a-fA-F.:]+)\/(\d{1,3})$/.exec(String(value || ""));
  if (!match) return 0;
  if (match[1].includes(":")) return Number(match[2]) <= 128 ? 6 : 0;
  return Number(match[2]) <= 32 && validIpv4(match[1]) ? 4 : 0;
}

function validIpv4(value) {
  const parts = String(value || "").split(".");
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// Ядро использует Go duration: «1m30s» и «1000ms» тоже означают целые секунды.
function validDuration(value, wholeSeconds = false) {
  if (typeof value !== "string" || !value) return false;
  if (value === "0") return true;
  const units = { ns: 1e-9, us: 1e-6, "µs": 1e-6, "μs": 1e-6, ms: 0.001, s: 1, m: 60, h: 3600 };
  const pattern = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gy;
  let seconds = 0, end = 0, part;
  while ((part = pattern.exec(value))) {
    seconds += Number(part[1]) * units[part[2]];
    end = pattern.lastIndex;
  }
  return end === value.length && Number.isFinite(seconds)
    && (!wholeSeconds || Math.abs(seconds - Math.round(seconds)) < 1e-9);
}

// Проверки общие для .ovpn и готового JSON sing-box: битый endpoint роняет
// инициализацию всего конфига, даже если выбран совсем другой сервер.
export function openvpnEndpointIssue(endpoint, authUserPass = false) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return { code: "ovpnEndpoint" };
  if (String(endpoint.dev || "").toLowerCase().startsWith("tap")) return { code: "ovpnTun" };
  const mode = endpoint.mode || "tls";
  if (mode !== "tls" && mode !== "static_key") return { code: "ovpnOption" };
  const transport = endpoint.network || "udp";
  if (!["udp", "tcp"].includes(transport)) return { code: "ovpnNetwork" };
  if (endpoint.server && endpoint.servers) return { code: "ovpnEndpoint" };
  const servers = endpoint.server ? [{ server: endpoint.server, server_port: endpoint.server_port }] : endpoint.servers;
  if (!Array.isArray(servers) || !servers.length) return { code: "ovpnEndpoint" };
  for (const remote of servers) {
    if (!remote || typeof remote.server !== "string" || !remote.server.trim()
      || !Number.isInteger(remote.server_port) || remote.server_port < 1 || remote.server_port > 65535) return { code: "ovpnEndpoint" };
    if (remote.network !== undefined && !["udp", "tcp"].includes(remote.network)) return { code: "ovpnNetwork" };
  }
  if (authUserPass || endpoint.username || endpoint.password) {
    if (typeof endpoint.username !== "string" || !endpoint.username.trim()
      || typeof endpoint.password !== "string" || !endpoint.password) return { code: "ovpnCredentials" };
    if (mode !== "tls") return { code: "ovpnOption" };
  }
  if (mode === "tls") {
    const tls = endpoint.tls;
    if (!tls || typeof tls !== "object" || !hasContent(tls.certificate)) return { code: "ovpnCa" };
    if (tls.certificate_path || tls.client_certificate_path || tls.client_key_path) return { code: "ovpnOption" };
    if (hasContent(tls.client_certificate) !== hasContent(tls.client_key)) return { code: "ovpnOption" };
    const choices = {
      server_name_type: ["subject", "name", "name-prefix"],
      remote_certificate_tls: ["server", "client", "none"],
      ns_certificate_type: ["server", "client"],
      certificate_profile: ["insecure", "legacy", "preferred", "suiteb"],
      version_min: TLS_VERSIONS,
      version_max: TLS_VERSIONS,
    };
    for (const [key, values] of Object.entries(choices)) {
      if (tls[key] && !values.includes(tls[key])) return { code: "ovpnOption" };
    }
    if (tls.version_max && Number(tls.version_max) < Number(tls.version_min || "1.2")) return { code: "ovpnOption" };
    if (tls.remote_certificate_tls && tls.remote_certificate_eku) return { code: "ovpnOption" };
    if (tls.remote_certificate_ku !== undefined && (!Array.isArray(tls.remote_certificate_ku)
      || tls.remote_certificate_ku.some(mask => !/^[0-9a-f]+$/i.test(String(mask))))) return { code: "ovpnOption" };
    const wrap = tls.control_wrap;
    if (wrap && (typeof wrap !== "object" || Array.isArray(wrap))) return { code: "ovpnOption" };
    if (wrap && (wrap.type || hasContent(wrap.key) || wrap.key_path || wrap.direction)
      && (!hasContent(wrap.key) || wrap.key_path || !["tls_auth", "tls_crypt", "tls_crypt_v2"].includes(wrap.type)
        || (wrap.direction && (wrap.type !== "tls_auth" || !["server", "client"].includes(wrap.direction))))) return { code: "ovpnOption" };
    if (endpoint.cipher) return { code: "ovpnOption" };
  } else {
    const addresses = Array.isArray(endpoint.address) ? endpoint.address : typeof endpoint.address === "string" ? [endpoint.address] : [];
    if (!hasContent(endpoint.static_key) || endpoint.static_key_path || !addresses.length || addresses.some(address => !addressFamily(address))) return { code: "ovpnStatic" };
    if (addresses.some(address => addressFamily(address) === 4) && !validIpv4(endpoint.peer_address)) return { code: "ovpnStatic" };
    if (addresses.some(address => addressFamily(address) === 6) && !String(endpoint.peer_address_ipv6 || "").includes(":")) return { code: "ovpnStatic" };
    if (endpoint.key_direction && !["server", "client"].includes(endpoint.key_direction)) return { code: "ovpnOption" };
    if (endpoint.data_ciphers || endpoint.data_ciphers_fallback) return { code: "ovpnOption" };
  }
  if ((endpoint.compression !== undefined && !COMPRESS.has(endpoint.compression))
    || (endpoint.compression_lzo !== undefined && !LZO.has(endpoint.compression_lzo))
    || (endpoint.allow_compression !== undefined && !ALLOW_COMPRESSION.has(endpoint.allow_compression))) return { code: "ovpnCompression" };
  const activeCompression = ["lz4", "lz4-v2"].includes(endpoint.compression)
    || ["yes", "adaptive", "asym"].includes(endpoint.compression_lzo);
  if ((endpoint.allow_compression || "no") === "no" && activeCompression) return { code: "ovpnCompression" };
  if (endpoint.auth_retry && !["none", "nointeract", "interact"].includes(endpoint.auth_retry)) return { code: "ovpnOption" };
  if (endpoint.topology && !["net30", "p2p", "subnet"].includes(endpoint.topology)) return { code: "ovpnOption" };
  if (endpoint.pull_filters !== undefined && (!Array.isArray(endpoint.pull_filters)
    || endpoint.pull_filters.some(filter => !filter || !["accept", "ignore", "reject"].includes(filter.action) || typeof filter.text !== "string"))) return { code: "ovpnOption" };
  if (endpoint.redirect_gateway_flags !== undefined && (!Array.isArray(endpoint.redirect_gateway_flags)
    || endpoint.redirect_gateway_flags.some(flag => !["!ipv4", "def1", "ipv6", "local", "autolocal", "bypass-dhcp", "bypass-dns"].includes(flag)))) return { code: "ovpnOption" };
  for (const key of ["mss_fix", "fragment", "mtu", "renegotiate_bytes", "renegotiate_packets", "explicit_exit_notify"]) {
    if (endpoint[key] !== undefined && (!Number.isSafeInteger(endpoint[key]) || endpoint[key] < 0)) return { code: "ovpnOption" };
  }
  if (endpoint.mtu === 0 || (endpoint.fragment && (endpoint.fragment < 68 || servers.some(remote => (remote.network || transport) === "tcp")))) return { code: "ovpnOption" };
  if (endpoint.mss_fix_disabled && (endpoint.mss_fix || endpoint.mss_fix_mode)) return { code: "ovpnOption" };
  if (endpoint.mss_fix_mode && (!endpoint.mss_fix || !["mtu", "fixed"].includes(endpoint.mss_fix_mode))) return { code: "ovpnOption" };
  if (endpoint.ping_restart_disabled && endpoint.ping_restart) return { code: "ovpnOption" };
  if (endpoint.renegotiate_disabled && endpoint.renegotiate_interval) return { code: "ovpnOption" };
  for (const key of ["ping_interval", "ping_restart", "renegotiate_interval", "tls_timeout", "handshake_window"]) {
    if (endpoint[key] !== undefined && endpoint[key] !== "" && !validDuration(endpoint[key], key === "ping_interval" || key === "ping_restart")) return { code: "ovpnOption" };
  }
  return null;
}

export function parseOpenvpnConf(text, displayName = "", credentials = {}) {
  const original = String(text || "");
  if (!looksLikeOpenvpnConf(original)) throw profileError("ovpnNotProfile");
  const entries = readProfile(original);
  const blocks = new Map(entries.filter(entry => entry.block !== undefined && INLINE.has(entry.directive)).map(entry => [entry.directive, entry.block]));
  const ignored = [];
  const ignore = directive => { if (!ignored.includes(directive)) ignored.push(directive); };
  const endpoint = { mode: blocks.has("secret") || entries.some(entry => entry.directive === "secret") ? "static_key" : "tls" };
  const tls = {};
  let port = 1194, transport = "udp", legacyCipher, keyDirection, ifconfig, authUserPass = false;
  const remotes = [];
  const inlineFields = { ca: "certificate", cert: "client_certificate", key: "client_key" };
  const wraps = { "tls-auth": "tls_auth", "tls-crypt": "tls_crypt", "tls-crypt-v2": "tls_crypt_v2" };
  for (const { directive, args, block } of entries) {
    const value = args[0];
    if (block !== undefined && !INLINE.has(directive)) { ignore(directive); continue; }
    if (SILENT.has(directive) || directive.startsWith("connect-retry")) continue;
    if (inlineFields[directive]) {
      if (blocks.has(directive)) tls[inlineFields[directive]] = blocks.get(directive).split("\n");
      if (block === undefined && value !== "[inline]") ignore(directive);
      continue;
    }
    if (wraps[directive]) {
      if (blocks.has(directive)) {
        tls.control_wrap = { type: wraps[directive], key: blocks.get(directive).split("\n") };
        if (directive === "tls-auth" && args[1] !== undefined) keyDirection = direction(args[1], directive);
      }
      if (block === undefined && value !== "[inline]") ignore(directive);
      continue;
    }
    switch (directive) {
      case "client": break;
      case "dev":
      case "dev-type":
        if (String(value || "").toLowerCase().startsWith("tap")) throw profileError("ovpnTap");
        if (!/^tun\d*$/.test(value || "")) throw profileError("ovpnOption", directive);
        break;
      case "proto": transport = network(value, directive); break;
      case "port": port = integer(value, directive, 1, 65535); break;
      case "remote": remotes.push(args); break;
      case "remote-random": endpoint.remote_random = true; break;
      case "cipher":
        if (!value) throw profileError("ovpnSyntax", directive);
        legacyCipher = value;
        break;
      case "data-ciphers":
      case "ncp-ciphers": endpoint.data_ciphers = String(value || "").split(":").filter(Boolean); if (!endpoint.data_ciphers.length) throw profileError("ovpnSyntax", directive); break;
      case "data-ciphers-fallback": endpoint.data_ciphers_fallback = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "auth": endpoint.auth = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "key-direction": keyDirection = direction(value, directive); break;
      case "remote-cert-tls": tls.remote_certificate_tls = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "verify-x509-name":
        if (!value) throw profileError("ovpnSyntax", directive);
        tls.server_name = value;
        tls.server_name_type = args[1] || "subject";
        break;
      case "tls-version-min": tls.version_min = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "tls-version-max": tls.version_max = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "tls-cipher": tls.cipher = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "tls-groups": tls.groups = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "tls-cert-profile": tls.certificate_profile = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "ns-cert-type": tls.ns_certificate_type = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "remote-cert-ku": tls.remote_certificate_ku = args; if (!args.length) throw profileError("ovpnSyntax", directive); break;
      case "remote-cert-eku": tls.remote_certificate_eku = args.join(" "); if (!value) throw profileError("ovpnSyntax", directive); break;
      case "compress": endpoint.compression = value || "stub"; break;
      case "comp-lzo": endpoint.compression_lzo = value || "adaptive"; break;
      case "allow-compression": endpoint.allow_compression = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "mssfix":
        if (value !== undefined) {
          const size = integer(value, directive);
          delete endpoint.mss_fix;
          delete endpoint.mss_fix_disabled;
          delete endpoint.mss_fix_mode;
          if (!size) endpoint.mss_fix_disabled = true;
          else { endpoint.mss_fix = size; if (args[1]) endpoint.mss_fix_mode = args[1]; }
        }
        break;
      case "fragment": endpoint.fragment = integer(value, directive); break;
      case "tun-mtu": endpoint.mtu = integer(value, directive, 1); break;
      case "route-nopull": endpoint.route_no_pull = true; break;
      case "pull-filter":
        if (args.length !== 2) throw profileError("ovpnSyntax", directive);
        (endpoint.pull_filters ||= []).push({ action: value, text: args[1] });
        break;
      case "redirect-gateway": endpoint.redirect_gateway = true; if (args.length) endpoint.redirect_gateway_flags = args; break;
      case "block-ipv6": endpoint.block_ipv6 = true; break;
      case "ping": endpoint.ping_interval = `${integer(value, directive)}s`; break;
      case "ping-restart": {
        const seconds = integer(value, directive);
        delete endpoint.ping_restart;
        delete endpoint.ping_restart_disabled;
        if (!seconds) endpoint.ping_restart_disabled = true;
        else endpoint.ping_restart = `${seconds}s`;
        break;
      }
      case "reneg-sec": {
        const seconds = integer(value, directive);
        delete endpoint.renegotiate_interval;
        delete endpoint.renegotiate_disabled;
        if (!seconds) endpoint.renegotiate_disabled = true;
        else endpoint.renegotiate_interval = `${seconds}s`;
        break;
      }
      case "reneg-bytes": endpoint.renegotiate_bytes = integer(value, directive); break;
      case "reneg-pkts": endpoint.renegotiate_packets = integer(value, directive); break;
      case "tls-timeout": endpoint.tls_timeout = `${integer(value, directive)}s`; break;
      case "hand-window": endpoint.handshake_window = `${integer(value, directive)}s`; break;
      case "explicit-exit-notify": endpoint.explicit_exit_notify = value === undefined ? 1 : integer(value, directive); break;
      case "auth-user-pass":
        authUserPass = true;
        if (block === undefined && value !== undefined && value !== "[inline]") ignore(directive);
        break;
      case "auth-retry": endpoint.auth_retry = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      case "static-challenge":
        if (!value || !["0", "1"].includes(args[1])) throw profileError("ovpnSyntax", directive);
        endpoint.static_challenge = value;
        endpoint.static_challenge_echo = args[1] === "1";
        break;
      case "secret":
        if (blocks.has(directive)) endpoint.static_key = blocks.get(directive).split("\n");
        if (block === undefined && value !== "[inline]") ignore(directive);
        if (args[1] !== undefined) keyDirection = direction(args[1], directive);
        break;
      case "ifconfig":
        if (args.length !== 2 || !validIpv4(value) || !validIpv4(args[1])) throw profileError("ovpnStatic");
        ifconfig = args;
        break;
      case "topology": endpoint.topology = value; if (!value) throw profileError("ovpnSyntax", directive); break;
      default: ignore(directive);
    }
  }
  endpoint.network = transport;
  endpoint.servers = remotes.map(args => {
    const [rawHost, remotePort, remoteProto] = args;
    const host = String(rawHost || "").replace(/^\[([^\]]+)\]$/, "$1");
    if (!host || /[\s/]/.test(host) || args.length > 3) throw profileError("ovpnRemote");
    return { server: host, server_port: remotePort === undefined ? port : integer(remotePort, "remote", 1, 65535), network: remoteProto === undefined ? transport : network(remoteProto, "remote") };
  });
  if (!endpoint.servers.length) throw profileError("ovpnRemote");
  if (ifconfig) {
    if (endpoint.topology === "subnet") {
      // В subnet второе поле ifconfig — маска, а не адрес peer. В static_key
      // шлюз обязателен и из одной маски не выводится; такой импорт отклоняем.
      if (endpoint.mode === "static_key") throw profileError("ovpnStatic");
      const mask = ifconfig[1].split(".").map(part => Number(part).toString(2).padStart(8, "0")).join("");
      if (!/^1*0*$/.test(mask)) throw profileError("ovpnOption", "ifconfig");
      endpoint.address = [`${ifconfig[0]}/${mask.indexOf("0") < 0 ? 32 : mask.indexOf("0")}`];
    } else {
      endpoint.address = [`${ifconfig[0]}/32`];
      endpoint.peer_address = ifconfig[1];
    }
  }
  if (entries.some(({ directive }) => (inlineFields[directive] || wraps[directive]) && !hasContent(blocks.get(directive)))) {
    throw profileError("ovpnInlineFiles");
  }
  if (new Set(entries.filter(entry => wraps[entry.directive]).map(entry => entry.directive)).size > 1) throw profileError("ovpnOption", "tls-auth/tls-crypt");
  if (endpoint.mode === "tls") {
    endpoint.tls = tls;
    if (legacyCipher && !endpoint.data_ciphers_fallback) endpoint.data_ciphers_fallback = legacyCipher;
    if (keyDirection && tls.control_wrap?.type === "tls_auth") tls.control_wrap.direction = keyDirection;
  } else {
    if (Object.keys(tls).length) throw profileError("ovpnOption", "tls");
    if (legacyCipher) endpoint.cipher = legacyCipher;
    if (keyDirection) endpoint.key_direction = keyDirection;
  }
  if (authUserPass) {
    const [inlineUser, inlinePassword] = String(blocks.get("auth-user-pass") || "").split(/\r?\n/);
    endpoint.username = credentials?.username || inlineUser || "";
    endpoint.password = credentials?.password || inlinePassword || "";
    if (!endpoint.username.trim() || !endpoint.password) {
      const error = profileError("ovpnCredentials");
      error.code = "openvpn-credentials";
      throw error;
    }
  }
  // Явно включённое сжатие означает приём сжатых пакетов. У ядра безопасный
  // default «no», поэтому переносим это намерение без исходящего сжатия.
  if (endpoint.allow_compression === undefined && (["lz4", "lz4-v2"].includes(endpoint.compression)
    || ["yes", "adaptive", "asym"].includes(endpoint.compression_lzo))) endpoint.allow_compression = "asym";
  const issue = openvpnEndpointIssue(endpoint, authUserPass);
  if (issue) {
    if (issue.code === "ovpnCa" || (issue.code === "ovpnOption" && hasContent(tls.client_certificate) !== hasContent(tls.client_key))) throw profileError("ovpnInlineFiles");
    if (issue.code === "ovpnStatic") throw profileError("ovpnStatic");
    throw profileError("ovpnOption", issue.code === "ovpnCompression" ? "compression" : "endpoint");
  }
  const primary = endpoint.servers[0];
  return {
    raw: `ovpn://${primary.server}:${primary.server_port}`,
    proto: "openvpn",
    name: displayName || primary.server,
    host: primary.server,
    port: primary.server_port,
    network: primary.network,
    endpoint,
    ovpn: original,
    ignored,
    ...(authUserPass ? { authUserPass: true } : {}),
  };
}

export function openvpnConfText(profile) {
  if (typeof profile?.ovpn === "string" && profile.ovpn) return profile.ovpn;
  throw profileError("ovpnNoOriginal");
}
