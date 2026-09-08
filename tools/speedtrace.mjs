// 板の «見た目の速度» が計器のライン速度と合っているかを実測する評価器。
//   node speedtrace.mjs
// 3D の板メッシュが 1 秒（シミュレーション時間）で実際に何 mm 進んだかを測り、
// 同じ瞬間の mill.currentSpeed [mpm] と突き合わせる。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, W = A.world;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  A.bus.emit('CMD_RESET');
  await new Promise(r => setTimeout(r, 300));
  window.__startAuto(false);
  // 圧延が定常に乗るまで進める
  window.__ff((p) => p.mill.passIndex >= 3 && p.slab.rollingActive && p.slab.biteFill > 0.99, 120 * 3000, 0);
  const rows = [];
  const dt = 1 / 120;
  for (let k = 0; k < 4; k++) {
    // «同じ時間» を物理と描画の両方へ通し、メッシュが動いた距離を測る
    W.render(P, dt);
    const s = P.slab, x0 = W.slabView?.mesh?.position.x ?? null;
    const c0 = s.xMax, t0 = P.elapsed, v0 = P.mill.currentSpeed;
    let n = 0;
    while (P.elapsed - t0 < 1.0 && n < 400) { P.step(dt); W.render(P, dt); n++; }
    const dtReal = P.elapsed - t0;
    const dxLogic = Math.abs(s.xMax - c0) / dtReal;                 // mm/s（材料座標の先端）
    const dxMesh = x0 === null ? null : Math.abs((W.slabView.mesh.position.x - x0)) / K.SCALE / dtReal;
    rows.push({ pass: P.mill.passIndex + 1, mpm: +v0.toFixed(1),
                logic: +(dxLogic * 60 / 1000).toFixed(1), mesh: dxMesh === null ? null : +(dxMesh * 60 / 1000).toFixed(1) });
  }
  const good = rows.filter(r => r.mpm > 5);
  ok('計器のライン速度と «板が実際に進む速さ» が一致（±12 %）',
     good.length > 0 && good.every(r => Math.abs(r.logic / r.mpm - 1) < 0.12),
     good.map(r => `p${r.pass} 計器 ${r.mpm} / 実測 ${r.logic} mpm`).join(' ／ '));
  // 画面上での見かけの速さ（シーン単位／秒）も出す
  const scale = K.SCALE;
  return { checks, rows, scale, timeScale: A.ui?.timeScale ?? 1 };
});
for (const r of out.rows) console.log(`pass ${r.pass}  計器 ${r.mpm} mpm  ／  実測（材料先端）${r.logic} mpm`);
console.log(`SCALE ${out.scale} scene/mm ／ 既定の時間倍率 ${out.timeScale}×`);
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
