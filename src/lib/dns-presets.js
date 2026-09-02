// Ninety · пресеты DNS для настроек.
//
// Поле DNS раньше было свободным вводом: опечатка вроде udp://8.8.8.8/dns-query
// молча сохранялась и роняла подключение позже, уже на сборке конфига. Здесь —
// готовый список плюс проверка ручного ввода тем же парсером, что собирает
// конфиг (parseDnsAddress), чтобы UI и ядро не расходились в том, что считать
// валидным адресом.
//
// Наборы для remote и direct РАЗНЫЕ намеренно. remote работает внутри тоннеля,
// где :443 никто не режет, — там уместен шифрованный DoH/DoT. direct обязан
// подняться ДО тоннеля (им резолвится домен ноды), а DoH в РФ срезают классом,
// поэтому там первым идёт обычный UDP. Все адреса из цепочки резервов dns-guard
// присутствуют в direct-списке: иначе автопереключение уводило бы селект в
// «Свой адрес» вместо понятного имени.

import { t } from "/lib/i18n/index.js";
import { parseDnsAddress } from "/lib/singbox.js";

export const DNS_CUSTOM = "__custom__";
export const DNS_SEPARATOR = "__sep__";

// type: system | doh | dot | plain — влияет только на подпись пункта.
export const DNS_PRESETS = {
  // Системного резолвера здесь намеренно нет: remote с "local" резолвит мимо
  // тоннеля — запросы видит провайдер. Вписать вручную по-прежнему можно, тогда
  // UI показывает предупреждение.
  remote: [
    { value: "https://1.1.1.1/dns-query", brand: "Cloudflare", type: "doh" },
    { value: "tls://1.1.1.1", brand: "Cloudflare", type: "dot" },
    { value: "https://8.8.8.8/dns-query", brand: "Google", type: "doh" },
    { value: "tls://8.8.8.8", brand: "Google", type: "dot" },
    { value: "https://9.9.9.9/dns-query", brand: "Quad9", type: "doh" },
    { value: "tls://9.9.9.9", brand: "Quad9", type: "dot" },
    { value: "https://94.140.14.14/dns-query", brand: "AdGuard", type: "doh" },
    { value: "tls://94.140.14.14", brand: "AdGuard", type: "dot" },
  ],
  // Порядок plain-группы — по устойчивости к подмене, а не по задержке.
  // Открытый UDP:53 фильтр не обязан блокировать: он может ПОДДЕЛАТЬ ответ.
  // На домен из реестра часть публичных резолверов отдаёт мгновенный NXDOMAIN
  // вместо адресов, и это выглядит как честное «такого домена нет» — клиент не
  // ретраится и не уходит на резерв, а direct-резолвер как раз поднимает домен
  // ноды до тоннеля. Замер из РФ: Yandex, Quad9 и AdGuard отвечают верно,
  // Cloudflare и Google — подделанным NXDOMAIN, поэтому стоят ниже. Дефолт
  // (options.js) — Yandex, то есть подделка не достаётся никому по умолчанию.
  // По DoH подмены нет ни у кого: ответ шифрован, подставить NXDOMAIN нельзя,
  // поэтому в нижней группе те же операторы уместны без оговорок.
  direct: [
    { value: "local", type: "system" },
    { value: DNS_SEPARATOR },
    { value: "udp://77.88.8.8", brand: "Yandex", type: "plain" },
    { value: "udp://149.112.112.112", brand: "Quad9", type: "plain" },
    { value: "udp://94.140.14.14", brand: "AdGuard", type: "plain" },
    { value: "udp://1.1.1.1", brand: "Cloudflare", type: "plain" },
    { value: "udp://8.8.8.8", brand: "Google", type: "plain" },
    { value: DNS_SEPARATOR },
    { value: "https://149.112.112.112/dns-query", brand: "Quad9", type: "doh" },
    { value: "https://77.88.8.8/dns-query", brand: "Yandex", type: "doh" },
    { value: "https://94.140.14.14/dns-query", brand: "AdGuard", type: "doh" },
    { value: "https://8.8.8.8/dns-query", brand: "Google", type: "doh" },
  ],
};

// Хост адреса для подписи пункта и для тостов dns-guard. Схему и путь
// /dns-query показывать незачем: внутри одного типа они у всех одинаковые, а
// различает пункты как раз адрес. Порт сохраняем — он единственное, чем
// нестандартный резолвер отличается от обычного.
export function dnsHostLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (raw.startsWith("https://")) return new URL(raw).host;
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  } catch { return raw; }
}

// «Бренд · адрес · тип». Тип обязателен и убрать его нельзя: у Cloudflare
// https://1.1.1.1/dns-query и tls://1.1.1.1 дают один и тот же хост, у Yandex в
// direct — та же пара на 77.88.8.8. Без типа эти пункты стали бы неразличимы.
// UDP/DoT/DoH не переводятся: это имена протоколов, а не термины интерфейса.
export function dnsPresetLabel(preset) {
  if (preset.type === "system") return t("settings.dns.presetSystem");
  const kind = preset.type === "plain" ? "UDP" : preset.type === "dot" ? "DoT" : "DoH";
  return `${preset.brand} · ${dnsHostLabel(preset.value)} · ${kind}`;
}

// Есть ли такой адрес среди пресетов набора (точное совпадение строки).
export function findDnsPreset(kind, value) {
  const list = DNS_PRESETS[kind] || [];
  return list.find(p => p.value !== DNS_SEPARATOR && p.value === value) || null;
}

// "local"/"system" — резолв через системные серверы. Для remote это значит, что
// запросы уйдут мимо тоннеля, поэтому UI показывает предупреждение.
export function isSystemDns(value) {
  const s = String(value || "").trim();
  return s === "local" || s === "system";
}

// Проверка ручного ввода. Возвращает { ok } либо { ok:false, messageKey }.
// Пустая строка валидна: normalizeOptions вернёт дефолт.
export function validateDnsAddress(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: true };
  const m = s.match(/^([a-z]+):\/\/(.+)$/i);
  if (m) {
    const scheme = m[1].toLowerCase();
    // Частая ошибка: путь /dns-query скопирован из DoH-ссылки в plain-адрес.
    // Сообщение адресное, иначе парсер отвечает невнятным "invalid DNS host".
    if (["udp", "tcp", "tls", "quic"].includes(scheme) && m[2].includes("/")) {
      return { ok: false, messageKey: "settings.dns.errPath" };
    }
    if (!["udp", "tcp", "tls", "quic", "https"].includes(scheme)) {
      return { ok: false, messageKey: "settings.dns.errScheme" };
    }
  }
  try {
    parseDnsAddress(s);
    return { ok: true };
  } catch {
    return { ok: false, messageKey: "settings.dns.errGeneric" };
  }
}
