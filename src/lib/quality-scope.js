// Ninety · осциллограмма канала (II.4) — раскрытый вид индикатора «КАНАЛ».
// Рисует серию goodput-проб движка качества (strip-chart), отмечает применённые
// ступени лесенки R1–R6 и порог «отличной» скорости. Живо обновляется через шину
// (событие quality:sample). Данные ТОЛЬКО локальные (движок качества) — наружу
// ничего не уходит. Первый потребитель шины bus.js.
import { bus } from "/lib/bus.js";
import { escapeHtml } from "/lib/esc.js";

const Q_LABEL = { UNKNOWN: "ПРОВЕРКА", GOOD: "ОТЛИЧНО", SLOW: "МЕДЛЕННО", STALLED: "ТОРМОЗИТ", DEAD: "НЕТ СВЯЗИ" };
const Q_VAR = { UNKNOWN: "--text-mid", GOOD: "--ok", SLOW: "--warn", STALLED: "--err", DEAD: "--err" };
const MAX_POINTS = 60;
const W = 320, H = 96, PAD = 6;

let open = null; // активный поповер (один за раз)

export function openQualityScope({ anchor, getSamples, goodBps = 1_500_000 } = {}) {
  closeScope();
  let samples = (getSamples?.() || []).slice(-MAX_POINTS);

  const root = document.createElement("div");
  root.className = "qscope";
  root.innerHTML =
    '<div class="qscope__head">' +
      '<span class="qscope__title">Осциллограмма канала</span>' +
      '<span class="qscope__now"><span class="qscope__pill" data-q="UNKNOWN"></span><span class="qscope__bps">—</span></span>' +
    '</div>' +
    `<svg class="qscope__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      `<line class="qscope__base" x1="0" x2="${W}"></line>` +
      '<polyline class="qscope__line"></polyline>' +
      '<g class="qscope__rungs"></g>' +
    '</svg>' +
    '<div class="qscope__foot">' +
      `<span class="qscope__legend"><i></i>порог «отлично» · ${(goodBps / 1e6).toFixed(1)} Мбит/с</span>` +
      '<span class="qscope__hint">обновляется по мере проверок скорости</span>' +
    '</div>';
  document.body.appendChild(root);

  // Позиционирование под якорем (чип «КАНАЛ»).
  const r = anchor?.getBoundingClientRect?.();
  if (r) {
    root.style.left = Math.max(8, Math.min(window.innerWidth - W - 20, r.left)) + "px";
    root.style.top = (r.bottom + 8) + "px";
  }

  const line = root.querySelector(".qscope__line");
  const base = root.querySelector(".qscope__base");
  const rungs = root.querySelector(".qscope__rungs");
  const pill = root.querySelector(".qscope__pill");
  const bpsEl = root.querySelector(".qscope__bps");

  function draw() {
    const pts = samples.slice(-MAX_POINTS);
    const maxBps = Math.max(goodBps * 1.4, ...pts.map((s) => s.bps), 1);
    const x = (i) => PAD + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (W - 2 * PAD));
    const y = (bps) => H - PAD - (Math.min(bps, maxBps) / maxBps) * (H - 2 * PAD);

    line.setAttribute("points", pts.map((s, i) => `${x(i).toFixed(1)},${y(s.bps).toFixed(1)}`).join(" "));
    const by = y(goodBps).toFixed(1);
    base.setAttribute("y1", by);
    base.setAttribute("y2", by);
    rungs.innerHTML = pts.map((s, i) => s.rung
      ? `<g transform="translate(${x(i).toFixed(1)},0)"><line y1="${PAD}" y2="${H - PAD}"></line><text y="${H - PAD - 2}" x="2">${escapeHtml(s.rung)}</text></g>`
      : "").join("");

    const last = pts[pts.length - 1];
    const q = last?.q || "UNKNOWN";
    pill.dataset.q = q;
    pill.textContent = Q_LABEL[q] || q;
    pill.style.color = `var(${Q_VAR[q] || "--text-mid"})`;
    bpsEl.textContent = last ? `${(last.bps / 1e6).toFixed(1)} Мбит/с` : "—";
  }
  draw();

  const off = bus.on("quality:sample", (s) => {
    samples.push(s);
    if (samples.length > MAX_POINTS * 2) samples = samples.slice(-MAX_POINTS);
    draw();
  });

  function onDoc(e) { if (!root.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) closeScope(); }
  function onKey(e) { if (e.key === "Escape") closeScope(); }
  setTimeout(() => document.addEventListener("click", onDoc), 10);
  document.addEventListener("keydown", onKey);

  open = { root, off, onDoc, onKey };
  return open;
}

export function closeScope() {
  if (!open) return;
  open.off?.();
  document.removeEventListener("click", open.onDoc);
  document.removeEventListener("keydown", open.onKey);
  open.root.remove();
  open = null;
}
