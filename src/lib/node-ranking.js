// Ninety · движок рекомендаций — оценка сервера по его собственным замерам.
// Вынесен из proxies-view.js: здесь чистая математика без DOM, clash-API и
// хранилища, поэтому её можно проверить тестами напрямую.
//
// Считает ТОЛЬКО по замерам, которые приложение уже сделало: история задержек
// и тип транспорта ноды. Никакой внешней телеметрии.

export const liveDelays = (hs) => hs.filter(d => d > 0 && d < 65000);

export function medianOf(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function stdevOf(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const TRANSPORT_W = { REALITY: 1, XHTTP: 0.95, TRUSTTUNNEL: 0.9, NAIVE: 0.85, WIREGUARD: 0.82, GRPC: 0.8, WS: 0.75 };

export function transportWeight(node) {
  const proto = String(node?.proto || "").toLowerCase();
  if (proto === "trusttunnel") return TRANSPORT_W.TRUSTTUNNEL;
  if (proto === "naive") return TRANSPORT_W.NAIVE;
  if (proto === "wireguard") return TRANSPORT_W.WIREGUARD;
  const sec = String(node?.security || "").toLowerCase();
  if (sec === "reality") return TRANSPORT_W.REALITY;
  const type = String(node?.type || "").toLowerCase();
  if (type === "xhttp") return TRANSPORT_W.XHTTP;
  if (type === "grpc") return TRANSPORT_W.GRPC;
  if (type === "ws") return TRANSPORT_W.WS;
  return 0.8;
}

// Шкала задержки — логарифмическая, по отношению, а не по разнице в мс.
// Линейная шкала «25…300 мс» оценивала разницу одинаково на любой скорости: 2 мс
// стоили столько же на паре 26/28, сколько на паре 260/262. На подписке, где все
// живые серверы укладываются в 26–40 мс, весь разброс задержки занимал 5% шкалы,
// и рекомендации фактически решал разброс: сервер с 33 мс и ровным каналом
// обгонял самый быстрый с 26 мс. Пользователь при этом видит колонку «Задержка»,
// отсортированную по числам, — и блок рекомендаций выглядел случайным.
// По логарифму на 30 мс миллисекунда задержки весит примерно столько же, сколько
// миллисекунда разброса, а на 300 мс — заметно меньше, что и требуется.
const LATENCY_FLOOR_MS = 20;
const LATENCY_CEIL_MS = 400;
const LATENCY_SPAN = Math.log(LATENCY_CEIL_MS / LATENCY_FLOOR_MS);
export function latencyScore(med) {
  if (!(med > 0)) return 0;
  return clamp01(1 - Math.log(Math.max(med, LATENCY_FLOOR_MS) / LATENCY_FLOOR_MS) / LATENCY_SPAN);
}

// Разброс остаётся в абсолютной шкале: 5 мс дрожания одинаково мешают и на
// быстром, и на медленном канале.
const JITTER_SCALE_MS = 55;

export function scoreNode(node, history) {
  const hs = Array.isArray(history) ? history : [];
  const L = liveDelays(hs);
  // Хватает одного успешного замера: один прогон «Измерить все» даёт ровно один
  // замер на сервер, и порог выше этого делал рекомендации недостижимыми.
  if (!L.length) return null;
  const med = medianOf(L);
  const jit = L.length >= 2 ? stdevOf(L) : null;
  const latency = latencyScore(med);

  // По двум замерам разброс и доступность — крайне шумные оценки: один неудачный
  // сэмпл обнулял стабильность, и самый быстрый сервер вылетал из рекомендаций.
  // Поэтому производные компоненты набирают вес по мере накопления замеров, а
  // пока доказательств мало, индекс опирается на то, что измерено напрямую —
  // на задержку.
  const evidence = clamp01((hs.length - 1) / 4);
  const shrink = (v) => 0.5 + (v - 0.5) * evidence;
  const stability = jit == null ? 0.5 : shrink(clamp01(1 - jit / JITTER_SCALE_MS));
  const liveness = shrink(L.length / hs.length);
  const transport = transportWeight(node);
  return {
    total: 0.45 * latency + 0.30 * stability + 0.15 * liveness + 0.10 * transport,
    latency, stability, liveness, transport, med, jit, okN: L.length, allN: hs.length,
  };
}

export const REASON_KEYS = ["latency", "stability", "liveness", "transport"];

// Причина выбирается по тому, чем нода сильнее всего ОТРЫВАЕТСЯ от поля,
// а не по максимальному компоненту: иначе все получают «12 из 12 замеров»
// — правду, которая ничего не объясняет. Две строки не повторяются.
//
// superlative говорит, можно ли назвать задержку самой низкой. Раньше строка
// «самая низкая задержка» вешалась на любую ноду, у которой задержка оказалась
// сильнейшей стороной, — и в списке под ней спокойно стоял сервер с меньшим
// числом. Превосходную степень заслуживает только минимум по полю.
export function reasonKeys(top, field) {
  const med = {};
  REASON_KEYS.forEach(k => { med[k] = medianOf(field.map(x => Math.round(x.s[k] * 100))) / 100; });
  const bestMed = field.reduce((m, x) => Math.min(m, x.s.med), Infinity);
  const used = new Set();
  return top.map(({ s }) => {
    // Разброс без второго замера не измерен, доступность при единственном замере
    // тривиально равна единице — такие причины ничего не объясняют.
    const usable = REASON_KEYS.filter(k =>
      !(k === "stability" && s.jit == null) && !(k === "liveness" && s.allN < 2));
    const pool = usable.length ? usable : REASON_KEYS.filter(k => k !== "stability" || s.jit != null);
    const order = [...pool].sort((a, b) => (s[b] - med[b]) - (s[a] - med[a]));
    const key = order.find(k => !used.has(k)) || order[0];
    used.add(key);
    return { key, superlative: key === "latency" && Math.round(s.med) <= Math.round(bestMed) };
  });
}
