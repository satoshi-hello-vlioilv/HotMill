// 材質・板厚方向温度・反りの «数値の妥当性» をパスごとに読む。
//  ・上下面温度差（上面が冷えやすい）と平均温度の推移
//  ・反り曲率 → 半径・浮き上がり長・先端高さ（自重との釣り合い）
//  ・描画メッシュの最大持ち上がりが解析値と一致するか
import { openApp, installHelpers } from './harness.mjs';
const alloy = process.argv[2] || null, target = process.argv[3] ? +process.argv[3] : null;
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: false });
await installHelpers(page);
const out = await page.evaluate(({ alloy, target }) => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, sc = K.SCALE, R = window.__ROLL;
  if (alloy) { const s = document.getElementById('sel-alloy'); s.value = alloy; s.dispatchEvent(new Event('change')); }
  if (target) { const r = document.getElementById('rng-target'); r.value = target; r.dispatchEvent(new Event('input')); }
  return new Promise(res => setTimeout(() => {
    window.__startAuto(false);
    const rows = [], checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
    let last = -2, maxAsym = 0, drawnMax = 0, analyticMax = 0, wasRolling = false;
    window.__ff((p, n) => {
      const s = p.slab;
      if (n % 24 === 0 && s.onLine) {
        maxAsym = Math.max(maxAsym, s.tBot - s.tTop);
        if (s.rollingActive && n % 240 === 0) {
          W.render(P, 2);
          const pos = W.slabView.mesh.geometry.attributes.position; let my = -1e9;
          for (let i = 0; i < pos.count; i++) my = Math.max(my, pos.getY(i));
          const lift = my / sc - (K.MILL.PASS_LINE + p.mill.gap);
          drawnMax = Math.max(drawnMax, lift);
        }
      }
      const endOfPass = wasRolling && !s.rollingActive; wasRolling = s.rollingActive;
      if (endOfPass) {
        const sp = R.curlSpan(s.kNew, s.thickness, s.width, s.alloy);
        analyticMax = Math.max(analyticMax, sp.tip);
        rows.push({ pass: p.mill.passIndex, th: +s.thickness.toFixed(1), Tm: +s.temperature.toFixed(0), top: +s.tTop.toFixed(0), core: +s.tCore.toFixed(0), bot: +s.tBot.toFixed(0),
          k: +s.kNew.toExponential(2), R_m: +(1 / Math.abs(s.kNew) / 1000).toFixed(1), liftOff_m: +(sp.liftOff / 1000).toFixed(2), tip_mm: +sp.tip.toFixed(0), touch_m: +(sp.touch / 1000).toFixed(2) });
      }
      return p.finish.done;
    }, 120 * 2500, 0);
    const s = P.slab;
    ok('上面が下面より冷える（クーラントの流れ落ち）', maxAsym > 0.5, `最大上下差 ${maxAsym.toFixed(1)} ℃`);
    ok('反りは上反り（冷えた上面が硬く、上へ曲がる）', rows.every(r => r.k > 0), rows.map(r => r.k).join(', '));
    ok('先端の浮き上がりが現実的（厚板で 50〜1500 mm）', rows.some(r => r.th > 20 && r.tip_mm >= 50 && r.tip_mm <= 1500), `最大 ${Math.max(...rows.map(r => r.tip_mm))} mm`);
    ok('描画の持ち上がりが現実的（1.5 m 以内、片持ちの立ち上がりを含む）', drawnMax <= 1500, `描画最大 ${drawnMax.toFixed(0)} mm ／ 着地後のスキー最大 ${analyticMax.toFixed(0)} mm`);
    ok('圧延が完走した', P.finish.done, `done=${P.finish.done}`);
    ok('温度は NaN でない', Number.isFinite(s.temperature) && s.T.every(Number.isFinite), `${s.temperature.toFixed(1)} ℃`);
    res({ alloy: s.alloyKey, rows, checks, final: { th: +s.thickness.toFixed(1), T: +s.temperature.toFixed(0), passes: K.SCHEDULE.length, done: P.finish.done, mode: P.finish.mode } });
  }, 400));
}, { alloy, target });
console.log('alloy', out.alloy, 'final', JSON.stringify(out.final));
console.log('pass  th     Tm  top core  bot   kappa      R[m]  liftOff[m] tip[mm] touch[m]');
for (const r of out.rows) console.log(String(r.pass).padStart(4), String(r.th).padStart(6), String(r.Tm).padStart(5), String(r.top).padStart(4), String(r.core).padStart(5), String(r.bot).padStart(5), String(r.k).padStart(10), String(r.R_m).padStart(8), String(r.liftOff_m).padStart(10), String(r.tip_mm).padStart(8), String(r.touch_m).padStart(8));
for (const c of out.checks) console.log(c.pass ? '  PASS' : '  FAIL', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'}`);
await browser.close();
