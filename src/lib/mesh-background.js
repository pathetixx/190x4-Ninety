/**
 * Mesh-фон. Радиальные bloom'ы поверх watermark-карты мира.
 *
 * Версия 2: усиленные amplitude (×1.5), прозрачный canvas (не fillRect-bg),
 * чтобы карта мира была видна под bloom'ами. Период ~14-20s.
 */

const NEON_RED     = [255, 42, 64];
const NEON_RED_DIM = [153, 32, 48];
const HOLO_B       = [199, 125, 255];
const HOLO_A       = [110, 231, 255];

const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

export function startMesh(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true });
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
    const p1 = (t / 14) * Math.PI * 2;
    const p2 = (t / 20) * Math.PI * 2;

    // Прозрачный canvas — watermark карты видна сквозь
    ctx.clearRect(0, 0, w, h);

    // 1. Багровый bloom — основной (приглушён, чтобы hero читался)
    const c1x = w * (0.32 + 0.20 * Math.cos(p1));
    const c1y = h * (0.30 + 0.14 * Math.sin(p1));
    drawBloom(c1x, c1y, w * 0.95, [
      [0,    rgba(NEON_RED, 0.18)],
      [0.50, rgba(NEON_RED_DIM, 0.08)],
      [1,    "rgba(0,0,0,0)"],
    ]);

    // 2. Фиолетовый намёк
    const c2x = w * (0.78 - 0.18 * Math.sin(p2));
    const c2y = h * (0.68 + 0.16 * Math.cos(p2));
    drawBloom(c2x, c2y, w * 0.8, [
      [0, rgba(HOLO_B, 0.09)],
      [1, "rgba(0,0,0,0)"],
    ]);

    // 3. Cyan-намёк
    const c3x = w * (0.50 + 0.12 * Math.sin(p1 + 1.7));
    const c3y = h * 0.92;
    drawBloom(c3x, c3y, w * 0.7, [
      [0, rgba(HOLO_A, 0.05)],
      [1, "rgba(0,0,0,0)"],
    ]);

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
