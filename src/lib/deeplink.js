// Ninety · разбор deep-link URL в намерение импорта. Чистая функция без DOM —
// вынесена из main.js, чтобы покрыть форматы тестами (node --test).
//
// Поддерживаемые форматы:
//   ninety://import/<encoded-url>             — подписка (legacy, оставлено)
//   ninety://import?url=...&name=...          — подписка (query-style)
//   ninety://config/<encoded-link>            — одиночный конфиг (vless/vmess/...)
//   ninety://add/<base64-url>                 — подписка (Happ-style, base64 URL)
//   <proto>://...                             — top-level link (vless/vmess/ss/
//                                               trojan/hysteria2/tuic/sub), если юзер
//                                               включил opt-in регистрацию схем в
//                                               Settings → Общие
//
// Возврат: { url, name } для add-modal (prefillUrl/prefillName) или null,
// если ссылка не распознана. Авто-импорта нет — юзер видит prefilled URL и
// подтверждает (защита от malicious links).

// Хвост после action может начинаться и с "/" (path-style), и с "?" (query-style:
// ninety://import?url=...). Прежний паттерн (?:\/(.*))? требовал "/" — query-style
// не матчился вовсе и молча игнорировался (поймано тестом).
const NINETY_RE = /^ninety:\/\/([a-z]+)([/?].*)?$/i;
const TOP_LEVEL_PROTOS = ["vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "tuic", "sub"];

export function safeAtobUrl(s) {
  try {
    const cleaned = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
    return atob(padded);
  } catch { return ""; }
}

export function parseDeepLink(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return null;

  // top-level proto:// (vless/vmess/...) — opt-in
  const protoIdx = raw.indexOf("://");
  if (protoIdx > 0) {
    const proto = raw.slice(0, protoIdx).toLowerCase();
    if (TOP_LEVEL_PROTOS.includes(proto)) {
      if (proto === "sub") {
        // sub://<base64-url> → раскрываем и шлём как подписку
        const decoded = safeAtobUrl(raw.slice(protoIdx + 3));
        if (decoded) return { url: decoded, name: "" };
      }
      return { url: raw, name: "" };
    }
  }

  // ninety://<action>/<rest>
  const m = raw.match(NINETY_RE);
  if (!m) return null;
  const action = m[1].toLowerCase();
  let rest = m[2] || "";
  if (rest.startsWith("/")) rest = rest.slice(1); // path-style; query-style оставляем с "?"

  // Хвост ?name=... — общий для import/config
  let name = "";
  let queryUrl = "";
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    const tail = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
    try {
      const params = new URLSearchParams(tail);
      const n = params.get("name");
      if (n) name = n;
      const u = params.get("url");
      if (u) queryUrl = u;
    } catch {}
  }
  // ninety://import?url=... — путь пустой, URL пришёл в query
  if (!rest && queryUrl) rest = queryUrl;

  try { rest = decodeURIComponent(rest); } catch {}

  if (!rest) return null;

  if (action === "add") {
    // ninety://add/<base64-url> — раскрываем base64
    const decoded = safeAtobUrl(rest);
    if (decoded) return { url: decoded, name };
  }

  // import / config / add (если base64 не распознали) — кидаем сырой URL
  return { url: rest, name };
}
