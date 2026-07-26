// Ninety · учёт реально измеренного трафика по источникам (подписка/профиль).
//
// Зачем: плитка на главной показывала трафик из заголовка подписки
// (subscription-userinfo) — провайдер часто шлёт 0/total=0 или редко обновляет,
// а у одиночных профилей (hysteria/naive/tt) заголовка нет вовсе. Реальный
// трафик считает sing-box (всё идёт через него) — clash-API /connections отдаёт
// кумулятивные uploadTotal/downloadTotal. Но они сбрасываются при каждом
// перезапуске ядра (любой реконнект), поэтому копим дельты сами в localStorage
// по каждому источнику — «использовано за N дней» переживает реконнекты и
// перезапуски приложения.

import { getTrafficTotal } from "/lib/clash-api.js";

const KEY_PREFIX = "ninety.traffic.";

function load(sourceKey) {
  try {
    const o = JSON.parse(localStorage.getItem(KEY_PREFIX + sourceKey) || "");
    return { up: Number(o.up) || 0, down: Number(o.down) || 0 };
  } catch { return { up: 0, down: 0 }; }
}
function save(sourceKey, v) {
  try { localStorage.setItem(KEY_PREFIX + sourceKey, JSON.stringify({ up: v.up, down: v.down })); } catch {}
}

// Накопленный измеренный трафик источника. { up, down, total } в байтах.
export function getMeasured(sourceKey) {
  if (!sourceKey) return { up: 0, down: 0, total: 0 };
  const v = load(sourceKey);
  return { up: v.up, down: v.down, total: v.up + v.down };
}

export function resetMeasured(sourceKey) {
  if (!sourceKey) return;
  try { localStorage.removeItem(KEY_PREFIX + sourceKey); } catch {}
}

// Ключ источника для getActiveSource()-объекта.
export function sourceKeyOf(src) {
  if (!src) return null;
  if (src.kind === "sub") return `sub:${src.subscription?.id}`;
  if (src.kind === "single") return `profile:${src.profile?.id}`;
  if (src.kind === "warp") return "warp";
  return null;
}

let timer = null;
let curKey = null;
let lastUp = 0, lastDown = 0;   // последний снимок кумулятивных тоталов ядра
let haveBaseline = false;       // получили ли первый снимок (точку отсчёта дельт)
let onUpdate = null;
let meterRunId = 0;
let runtimeToken = null;
let runtimeProvider = null;
let clashPort = 9090;

export function configureTrafficRuntime(provider) {
  runtimeProvider = provider || null;
}

async function poll() {
  const runId = meterRunId;
  const key = curKey;
  const token = runtimeToken;
  if (!key) return;
  if (token && runtimeProvider?.isCurrent && !runtimeProvider.isCurrent(token)) return;
  let t;
  try { t = await getTrafficTotal(clashPort, { token }); }
  catch { return; } // ядро ещё не подняло clash-API / уже умерло — пропускаем тик
  if (runId !== meterRunId || key !== curKey || token !== runtimeToken) return;
  if (token && runtimeProvider?.isCurrent && !runtimeProvider.isCurrent(token)) return;
  const up = Number(t?.up) || 0, down = Number(t?.down) || 0;
  // Первый снимок после старта ядра — только точка отсчёта, дельту не пишем.
  if (!haveBaseline) { lastUp = up; lastDown = down; haveBaseline = true; return; }
  // Дельта с прошлого тика. Если тотал упал — ядро перезапустилось, текущее
  // значение и есть «новый» трафик с момента рестарта.
  let dU = up - lastUp, dD = down - lastDown;
  if (dU < 0) dU = up;
  if (dD < 0) dD = down;
  lastUp = up; lastDown = down;
  if (dU > 0 || dD > 0) {
    const acc = load(key);
    acc.up += dU; acc.down += dD;
    save(key, acc);
    try { onUpdate?.(); } catch {}
  }
}

// Запустить опрос для активного источника. Зовётся при переходе в connected.
export function startMeter({ sourceKey, intervalMs = 3000, onUpdate: cb, token, port } = {}) {
  stopMeter();
  curKey = sourceKey || null;
  onUpdate = cb || null;
  runtimeToken = token || runtimeProvider?.capture?.() || null;
  clashPort = Number(port ?? runtimeToken?.clashPort) || 9090;
  haveBaseline = false; lastUp = 0; lastDown = 0;
  if (!curKey) return;
  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopMeter() {
  meterRunId++;
  if (timer) { clearInterval(timer); timer = null; }
  curKey = null; haveBaseline = false; onUpdate = null; runtimeToken = null;
}
