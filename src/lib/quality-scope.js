// Ninety · осциллограмма канала — раскрытый вид индикатора «КАНАЛ».  [ИСПРАВЛЕННАЯ ВЕРСИЯ]
//
// ▼ ЧТО ИСПРАВЛЕНО:
//   1) Поповер больше НЕ уезжает за нижний край окна. Раньше он жёстко ставился ПОД
//      якорем (top = anchor.bottom + 8), а ячейка «КАНАЛ» стоит у самого низа окна →
//      окно вылезало за экран. Теперь по умолчанию открывается НАД якорем, а если
//      сверху не хватает места — флипается вниз. Плюс клампится по обеим осям.
//   2) Заголовок «Осциллограмма канала» → «Качество канала» (юзер-френдли).
import { bus } from "/lib/bus.js";
import { escapeHtml } from "/lib/esc.js";
import { t } from "/lib/i18n/index.js";

const qLabel = (q) => t("qScope.label." + String(q).toLowerCase());
const Q_VAR = { UNKNOWN: "--text-mid", GOOD: "--ok", SLOW: "--warn", STALLED: "--err", DEAD: "--err" };
const MAX_POINTS = 60;
const W = 320, H = 96, PAD = 6;
const GAP = 10; // отступ поповера от якоря

let open = null; // активный поповер (один за раз)

export function openQualityScope({ anchor, getSamples, goodBps = 1_500_000 } = {}) {
  closeScope();
  let samples = (getSamples?.() || []).slice(-MAX_POINTS);

  const root = document.createElement("div");
  root.className = "qscope";
  root.innerHTML =
    '<div class="qscope__head">' +
      `<span class="qscope__title">${t("qScope.title")}</span>` +
      '<span class="qscope__now"><span class="qscope__pill" data-q="UNKNOWN"></span><span class="qscope__bps">—</span></span>' +
    '</div>' +
    `<svg class="qscope__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
      `<line class="qscope__base" x1="0" x2="${W}"></line>` +
      '<polyline class="qscope__line"></polyline>' +
      '<g class="qscope__rungs"></g>' +
    '</svg>' +
    '<div class="qscope__foot">' +
      `<span class="qscope__legend"><i></i>${t("qScope.legend", { mbps: (goodBps / 1e6).toFixed(1) })}</span>` +
      `<span class="qscope__hint">${t("qScope.hint")}</span>` +
    '</div>';
  document.body.appendChild(root);

  // ── Позиционирование: по умолчанию НАД якорем, флип вниз если сверху мало места. ──
  positionScope(root, anchor);

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
    pill.textContent = qLabel(q);
    pill.style.color = `var(${Q_VAR[q] || "--text-mid"})`;
    bpsEl.textContent = last ? t("qScope.mbps", { v: (last.bps / 1e6).toFixed(1) }) : "—";
  }
  draw();

  const off = bus.on("quality:sample", (s) => {
    samples.push(s);
    if (samples.length > MAX_POINTS * 2) samples = samples.slice(-MAX_POINTS);
    draw();
  });

  function onDoc(e) { if (!root.contains(e.target) && e.target !== anchor && !anchor?.contains(e.target)) closeScope(); }
  function onKey(e) { if (e.key === "Escape") closeScope(); }
  const onReflow = () => positionScope(root, anchor);
  setTimeout(() => document.addEventListener("click", onDoc), 10);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onReflow);

  open = { root, off, onDoc, onKey, onReflow };
  return open;
}

// НАД якорем по умолчанию; вниз — только если сверху не помещается. Клампинг по краям.
function positionScope(root, anchor) {
  const r = anchor?.getBoundingClientRect?.();
  if (!r) return;
  const h = root.offsetHeight || H + 70;
  const left = Math.max(8, Math.min(window.innerWidth - root.offsetWidth - 8, r.left));
  const spaceAbove = r.top;
  let top;
  if (spaceAbove >= h + GAP) {
    top = r.top - h - GAP;            // НАД ячейкой (предпочтительно)
  } else {
    top = Math.min(window.innerHeight - h - 8, r.bottom + GAP); // флип вниз + кламп
  }
  root.style.left = left + "px";
  root.style.top = Math.max(8, top) + "px";
}

export function closeScope() {
  if (!open) return;
  open.off?.();
  document.removeEventListener("click", open.onDoc);
  document.removeEventListener("keydown", open.onKey);
  window.removeEventListener("resize", open.onReflow);
  open.root.remove();
  open = null;
}
