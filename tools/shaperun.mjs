// 既定ロットを通しで走らせ、パスごとの «幅方向の形状» を実測する。
//   node shaperun.mjs [目標板厚]
import { openApp, installHelpers } from './harness.mjs';
const target = process.argv[2] ? +process.argv[2] : 8;
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate((target) => {
  const A = window.__app, P = A.physics, K = window.__CFG;
  const r = document.getElementById('rng-target'); r.value = target; r.dispatchEvent(new Event('input'));
  return new Promise(res => setTimeout(() => {
    window.__startAuto(false);
    const rows = []; const cur = {};
    window.__ff((p, n) => {
      const s = p.slab, m = p.mill;
      // パスの «終わり際» の値を採る（噛み込み直後は制御が立ち上がっていない）
      if (s.rollingActive && s.wShape && s.biteFill > 0.99) {
        const sh = s.wShape;
        cur[m.passIndex] = { pass: m.passIndex + 1, hIn: +s.thickness.toFixed(2), hOut: +m.gap.toFixed(2),
                    F: Math.round(s.rollForce), w: +s.width.toFixed(1),
                    crown: +sh.crownAbs.toFixed(1), ratio: +(sh.crownRatio * 100).toFixed(3),
                    inRatio: +(sh.crownInRatio * 100).toFixed(3),
                    edge: +sh.edgeDrop.toFixed(1), I: +sh.iUnit.toFixed(1), mode: sh.modeName,
                    buckle: sh.buckle, bend: +m.bendForceT.toFixed(0), gain: +sh.bendGain.toFixed(3),
                    Tedge: +sh.chill.drop.toFixed(1) };
      }
      return p.finish.done || !!p.tripped;
    }, 120 * 3000, 0);
    const s = P.slab;
    for (const k of Object.keys(cur).sort((a, b) => a - b)) rows.push(cur[k]);
    res({ rows, width0: s.initialWidth, width1: +s.width.toFixed(1), spread: +(s.spreadTotal || 0).toFixed(2),
          tripped: P.tripped, done: P.finish.done });
  }, 400));
}, target);
console.log('パス  入厚   出厚   荷重t   幅      クラウン  率%     入率%   エッジ  I-unit 判定    ベンダt 利得µm/t 端冷え');
for (const r of out.rows)
  console.log(`${String(r.pass).padStart(3)} ${String(r.hIn).padStart(7)} ${String(r.hOut).padStart(7)} ${String(r.F).padStart(6)} ${String(r.w).padStart(7)}`
    + ` ${String(r.crown).padStart(8)} ${String(r.ratio).padStart(7)} ${String(r.inRatio).padStart(7)} ${String(r.edge).padStart(7)}`
    + ` ${String(r.I).padStart(7)} ${(r.mode + (r.buckle ? '(座屈)' : '')).padEnd(9)} ${String(r.bend).padStart(5)} ${String(r.gain).padStart(7)} ${String(r.Tedge).padStart(6)}`);
console.log(`幅 ${out.width0} → ${out.width1} mm（広がり ${out.spread} mm）／ done ${out.done} / tripped ${out.tripped}`);
if (errors.length) console.log('errors:', errors);
await browser.close();
