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

const KEY_PREFIX = "ninety.traffic.";
const CLASH_PORT = 9090; // external_controller (harden_config форсит 127.0.0.1:9090)
const invoke = window.__TAURI__?.core?.invoke;

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
  return null;
}

let timer = null;
let curKey = null;
let lastUp = 0, lastDown = 0;   // последний снимок кумулятивных тоталов ядра
let haveBaseline = false;       // получили ли первый снимок (точку отсчёта дельт)
let onUpdate = null;

async function poll() {
  if (!invoke || !curKey) return;
  let t;
  try { t = await invoke("clash_traffic_total", { port: CLASH_PORT }); }
  catch { return; } // ядро ещё не подняло clash-API / уже умерло — пропускаем тик
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
    const acc = load(curKey);
    acc.up += dU; acc.down += dD;
    save(curKey, acc);
    try { onUpdate?.(); } catch {}
  }
}

// Запустить опрос для активного источника. Зовётся при переходе в connected.
export function startMeter({ sourceKey, intervalMs = 3000, onUpdate: cb } = {}) {
  stopMeter();
  curKey = sourceKey || null;
  onUpdate = cb || null;
  haveBaseline = false; lastUp = 0; lastDown = 0;
  if (!curKey) return;
  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopMeter() {
  if (timer) { clearInterval(timer); timer = null; }
  curKey = null; haveBaseline = false; onUpdate = null;
}
