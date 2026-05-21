/**
 * Mesh-фон. Перенос из hub190x4-app/Panels.kt:MeshBackground.
 *
 * Три радиальных «дышащих» bloom'а поверх Bg0:
 *   1) багровый (NeonRed) — основной акцент, период ~16s
 *   2) фиолетовый (HoloB) — едва заметный, период ~23s
 *   3) cyan (HoloA) — самый слабый, привязан к фазе 1
 * Сверху — мягкая виньетка к краям для фокуса в центр.
 *
 * Никаких scanlines / hex-grid / glitch — намеренно. Премиум, не AI-stock.
 */

const BG0 = "#07060A";
const NEON_RED = [255, 42, 64];
const NEON_RED_DIM = [153, 32, 48];
const HOLO_B = [199, 125, 255];   // violet
const HOLO_A = [110, 231, 255];   // cyan

function rgba(rgb, a) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

export function startMesh(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false });
  let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let w = 0, h = 0;
  let t0 = performance.now();
  let raf = 0;

  function resize() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawBloom(cx, cy, r, stops) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [pos, color] of stops) g.addColorStop(pos, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    // фазы — медленные, как в Compose-версии (16s и 23s)
    const p1 = (t / 16) * Math.PI * 2;
    const p2 = (t / 23) * Math.PI * 2;

    // База
    ctx.fillStyle = BG0;
    ctx.fillRect(0, 0, w, h);

    // 1. Багровый bloom — основной
    const c1x = w * (0.30 + 0.18 * Math.cos(p1));
    const c1y = h * (0.26 + 0.12 * Math.sin(p1));
    drawBloom(c1x, c1y, w * 0.95, [
      [0,    rgba(NEON_RED, 0.20)],
      [0.55, rgba(NEON_RED_DIM, 0.10)],
      [1,    "rgba(0,0,0,0)"],
    ]);

    // 2. Фиолетовый намёк
    const c2x = w * (0.78 - 0.16 * Math.sin(p2));
    const c2y = h * (0.72 + 0.14 * Math.cos(p2));
    drawBloom(c2x, c2y, w * 0.8, [
      [0, rgba(HOLO_B, 0.10)],
      [1, "rgba(0,0,0,0)"],
    ]);

    // 3. Cyan-намёк
    const c3x = w * (0.50 + 0.10 * Math.sin(p1 + 1.7));
    const c3y = h * 0.92;
    drawBloom(c3x, c3y, w * 0.7, [
      [0, rgba(HOLO_A, 0.06)],
      [1, "rgba(0,0,0,0)"],
    ]);

    // 4. Виньетка — фокус в центр
    const vg = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, h * 0.85);
    vg.addColorStop(0.62, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(7, 6, 10, 0.85)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}
