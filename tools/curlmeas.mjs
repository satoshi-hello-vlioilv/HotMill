// 反りの曲率が «弾性で戻る量» に対してどのくらいかの実測（スプリングバックの前提確認）。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics;
  return new Promise(res => setTimeout(() => {
    window.__startAuto(false);
    const cur = {};
    window.__ff((p, n) => {
      const s = p.slab, m = p.mill;
      if (s.rollingActive && s.biteFill > 0.99 && Math.abs(s.kNew) > 0) {
        const al = s.alloy, E = al.E * 1000, h = m.gap, sy = s.flowStress || 1;
        const kE = 2 * sy / (E * h);                       // 降伏が始まる曲率
        cur[m.passIndex] = { pass: m.passIndex + 1, h: +h.toFixed(1), kf: +sy.toFixed(1),
          k: s.kNew, R: +(1 / Math.abs(s.kNew) / 1000).toFixed(1), kE, RE: +(1 / kE / 1000).toFixed(2),
          ratio: +(Math.abs(s.kBite || s.kNew) / kE).toFixed(3),
          Rb: s.kBite ? +(1 / Math.abs(s.kBite) / 1000).toFixed(1) : null,
          dT: +(s.tBot - s.tTop).toFixed(2) };
      }
      return p.finish.done || !!p.tripped;
    }, 120 * 3000, 0);
    res(Object.keys(cur).sort((a, b) => a - b).map(k => cur[k]));
  }, 400));
});
console.log('パス  出厚  kf MPa  上下ΔT  バイト内半径 m  残る反り半径 m  弾性限界 m   κ/κe');
for (const r of out)
  console.log(`${String(r.pass).padStart(3)} ${String(r.h).padStart(6)} ${String(r.kf).padStart(7)} ${String(r.dT).padStart(7)}`
    + ` ${String(r.Rb).padStart(14)} ${String(r.R).padStart(15)} ${String(r.RE).padStart(11)} ${String(r.ratio).padStart(7)}`);
if (errors.length) console.log('errors:', errors);
await browser.close();
