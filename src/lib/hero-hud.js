// Ninety · кибер-HUD главного экрана (редизайн home).  [ИСПРАВЛЕННАЯ ВЕРСИЯ]
// Вокруг маски-самурая: вращающиеся SVG-кольца, гейдж INTEGRITY, часы, изогнутый
// текст SYSTEM STATUS / TARGET LOCKED, бегущая ERR-строка, хром. аберрация + глитч.
//
// ▼ ЧТО ИСПРАВЛЕНО относительно прежней версии:
//   1) Тексты-ридауты разнесены, чтобы не наезжали друг на друга и на дуги:
//      clock y=60→106, INTEGRITY y=330→298, ERR y=350→372.  (раньше всё было свалено
//      в один 20px-пятак внизу + часы лезли на дугу SYSTEM STATUS).
//   2) Анимация HUD больше НЕ глушится prefers-reduced-motion: вращение колец, глитч,
//      INTEGRITY/ERR/blink работают всегда. HUD — смысловой центр экрана, а не декор;
//      при выключенных в Windows анимациях он раньше полностью замерзал (играла только
//      видео-маска). Если нужна строгая a11y — верните флаг `reduced` в startRot()/таймеры.

const CX = 200, CY = 200;
const P = (deg, r) => [CX + Math.cos((deg * Math.PI) / 180) * r, CY + Math.sin((deg * Math.PI) / 180) * r];

function buildStatic() {
  const arc = (r, a1, a2, w, col, ex) => {
    const [x1, y1] = P(a1, r), [x2, y2] = P(a2, r);
    const lg = Math.abs(a2 - a1) > 180 ? 1 : 0;
    return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${lg} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"${ex ? " " + ex : ""}/>`;
  };
  let s = '<circle cx="200" cy="200" r="98" fill="none" stroke="var(--accent-deep)" stroke-width="1"/>';
  s += '<circle cx="200" cy="200" r="102" fill="none" stroke="var(--line-2)" stroke-width="0.6"/>';
  [45, 135, 225, 315].forEach((a) => { s += arc(190, a - 13, a + 13, 2.6, "var(--accent-bright)", 'style="filter:drop-shadow(0 0 3px var(--accent-glow));"'); });
  [0, 90, 180, 270].forEach((a) => {
    const [x1, y1] = P(a, 198), [x2, y2] = P(a, 209);
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round"/>`;
  });
  return s;
}

function buildOuter() {
  let s = '<circle cx="200" cy="200" r="194" fill="none" stroke="var(--text-faint)" stroke-width="0.8"/>';
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * 2 * Math.PI, m = i % 6 === 0;
    const r1 = m ? 182 : 187, r2 = 194;
    s += `<line x1="${(200 + Math.cos(a) * r1).toFixed(1)}" y1="${(200 + Math.sin(a) * r1).toFixed(1)}" x2="${(200 + Math.cos(a) * r2).toFixed(1)}" y2="${(200 + Math.sin(a) * r2).toFixed(1)}" stroke="${m ? "var(--accent)" : "var(--text-faint)"}" stroke-width="${m ? 1.3 : 0.7}"/>`;
  }
  return s;
}

function buildSeg() {
  const r = 160, c = 2 * Math.PI * r, seg = c / 5, on = seg * 0.58, off = seg * 0.42;
  let s = `<circle cx="200" cy="200" r="${r}" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-dasharray="${on.toFixed(1)} ${off.toFixed(1)}" opacity="0.92"/>`;
  s += '<circle cx="200" cy="200" r="172" fill="none" stroke="var(--line-3)" stroke-width="0.6" stroke-dasharray="1.5 5"/>';
  return s;
}

function buildTickRing() {
  let s = "";
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * 2 * Math.PI, m = i % 5 === 0;
    const r1 = m ? 114 : 118, r2 = 125;
    s += `<line x1="${(200 + Math.cos(a) * r1).toFixed(1)}" y1="${(200 + Math.sin(a) * r1).toFixed(1)}" x2="${(200 + Math.cos(a) * r2).toFixed(1)}" y2="${(200 + Math.sin(a) * r2).toFixed(1)}" stroke="${m ? "var(--text-lo)" : "var(--text-faint)"}" stroke-width="${m ? 1 : 0.6}"/>`;
  }
  return s;
}

function buildHud() {
  return `
    <defs>
      <path id="hud-top" d="M 52 200 A 148 148 0 0 1 348 200"></path>
      <path id="hud-bot" d="M 56 200 A 144 144 0 0 0 344 200"></path>
      <filter id="hud-ca" x="-12%" y="-12%" width="124%" height="124%">
        <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="R"></feColorMatrix>
        <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="GB"></feColorMatrix>
        <feOffset in="R" dx="-1.1" result="Ro"></feOffset>
        <feOffset in="GB" dx="1.1" result="GBo"></feOffset>
        <feMerge><feMergeNode in="Ro"></feMergeNode><feMergeNode in="GBo"></feMergeNode></feMerge>
      </filter>
    </defs>
    <g class="hud__static">${buildStatic()}</g>
    <g class="hud__outer" data-hud="outer">${buildOuter()}</g>
    <g class="hud__seg" data-hud="seg">${buildSeg()}</g>
    <g class="hud__ticks" data-hud="ticks">${buildTickRing()}</g>
    <g transform="rotate(-90 200 200)">
      <circle cx="200" cy="200" r="140" fill="none" stroke="var(--line-2)" stroke-width="2"></circle>
      <circle data-hud="arc" cx="200" cy="200" r="140" fill="none" stroke="var(--accent-bright)" stroke-width="2" stroke-linecap="round" stroke-dasharray="0 880" style="filter:drop-shadow(0 0 3px var(--accent-glow));"></circle>
    </g>
    <g data-hud="ca" filter="url(#hud-ca)" style="transition:transform .05s linear;">
      <text data-hud="sys" class="hud__sys"><textPath href="#hud-top" startOffset="50%" text-anchor="middle">SYSTEM STATUS: STAND-BY</textPath></text>
      <text class="hud__target" data-hud="target"><textPath href="#hud-bot" startOffset="50%" text-anchor="middle">TARGET LOCKED: UNKNOWN</textPath></text>
      <text data-hud="clock" x="200" y="106" text-anchor="middle" class="hud__clock">——.——.——  ——:——:——</text>
      <text data-hud="intg" x="200" y="298" text-anchor="middle" class="hud__intg">INTEGRITY 0%</text>
      <text data-hud="err" x="200" y="372" text-anchor="middle" class="hud__err">NO LINK</text>
    </g>`;
}

const ERR_SECURED = ["RTT STABLE", "TUN OK", "PKT_LOSS 0.0", "SYNC 0x4F", "LINK 190X4"];
const ERR_OFFLINE = ["NO LINK", "SEARCHING…", "ERR_ON_KNW"];
const pad = (n) => String(n).padStart(2, "0");

// getState() → 'secured' | 'linking' | 'standby'.  getTarget() → строка-тег сервера или null.
export function initHeroHud(svg, { getState, getTarget } = {}) {
  if (!svg) return { destroy() {} };
  svg.innerHTML = buildHud();
  const els = {};
  svg.querySelectorAll("[data-hud]").forEach((el) => { els[el.dataset.hud] = el; });

  const st = () => (getState?.() || "standby");
  let raf = null, timers = [], intgVal = 0, ei = 0, clockStr = "";

  function updClock() {
    const d = new Date();
    clockStr = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (els.clock) els.clock.textContent = clockStr;
  }
  function updIntegrity() {
    const s = st();
    intgVal = s === "secured" ? 85 + Math.round(Math.random() * 9)
      : s === "linking" ? 40 + Math.round(Math.random() * 30)
      : Math.round(Math.random() * 38);
    if (els.intg) els.intg.textContent = "INTEGRITY " + intgVal + "%";
    if (els.arc) { const c = 2 * Math.PI * 140, f = (c * intgVal) / 100; els.arc.setAttribute("stroke-dasharray", `${f.toFixed(1)} ${(c - f).toFixed(1)}`); }
  }
  function blink() {
    if (!els.sys) return;
    els.sys.setAttribute("opacity", "0.18");
    setTimeout(() => els.sys && els.sys.setAttribute("opacity", "1"), 105);
  }
  function cycleErr() {
    if (!els.err) return;
    const sec = st() === "secured";
    const arr = sec ? ERR_SECURED : ERR_OFFLINE;
    ei = (ei + 1) % arr.length;
    els.err.textContent = arr[ei];
    els.err.style.fill = sec ? "var(--text-lo)" : "var(--err)";
  }
  function glitch() {
    if (Math.random() > 0.6) return;
    const g = els.ca; if (!g) return;
    g.setAttribute("transform", "translate(3,-1) skewX(-3)");
    svg.style.opacity = "0.55";
    setTimeout(() => g && g.setAttribute("transform", "translate(-2,1)"), 65);
    setTimeout(() => { if (g) g.setAttribute("transform", ""); svg.style.opacity = ""; }, 150);
  }

  function sync() {
    const s = st();
    if (els.sys) els.sys.querySelector("textPath").textContent =
      "SYSTEM STATUS: " + (s === "secured" ? "OPERATIONAL" : s === "linking" ? "LINKING" : "STAND-BY");
    if (els.target) els.target.querySelector("textPath").textContent =
      "TARGET LOCKED: " + (s === "secured" ? (getTarget?.() || "190X4") : "UNKNOWN");
    updIntegrity();
    cycleErr();
  }

  function startRot() {
    if (raf) return;
    const t0 = performance.now();
    const rot = (k, deg) => els[k] && els[k].setAttribute("transform", `rotate(${(((deg % 360) + 360) % 360).toFixed(2)} 200 200)`);
    const loop = (t) => {
      const e = (t - t0) / 1000;
      rot("outer", e * 6); rot("seg", -e * 10); rot("ticks", e * 3.2);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  // Анимация запускается ВСЕГДА (HUD — центр экрана, не вестибулярно-агрессивный декор).
  updClock(); sync(); startRot();
  timers.push(setInterval(updClock, 1000));
  timers.push(setInterval(updIntegrity, 1600));
  timers.push(setInterval(blink, 1500));
  timers.push(setInterval(cycleErr, 2400));
  timers.push(setInterval(glitch, 4000));

  return {
    sync,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      timers.forEach(clearInterval);
      timers = [];
    },
  };
}
