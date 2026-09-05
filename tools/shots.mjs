// 問題箇所を «同じ視点・同じ工程» で撮影する。修正前後の比較に使う。
//   node shots.mjs <label>
import fs from 'node:fs';
import path from 'node:path';
import { openApp, installHelpers, __dirname } from './harness.mjs';

const LABEL = process.argv[2] || 'shot';
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const dir = path.join(__dirname, 'shots'); fs.mkdirSync(dir, { recursive: true });
const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
await installHelpers(page);

const shot = async (name) => {
  if (only && !only.has(name)) return;
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__app.world.render(window.__app.physics, 1 / 60));
  await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) });
  console.log('shot', name);
};
const F = await page.evaluate(() => window.__CFG.FLIP);
const fx = (x) => x * F;      // 正準向き（第1パス +X）で書いた X を実配置へ

// 1) ミル周り: 地面の無いピット上に立つ架台・支柱を斜め下から
await page.evaluate(() => { const c = document.getElementById('chk-labels'); c.checked = false; c.dispatchEvent(new Event('change')); });
await page.evaluate(() => window.__app.ui.setCutaway('solid'));
const cut = async (m) => page.evaluate((m) => window.__app.ui.setCutaway(m), m);
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(9000), 1200, 9000], [fx(1500), 300, 0]]);
await shot('pit-side');
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(-9000), 2500, 8500], [fx(-1500), 500, 0]]);
await shot('pit-entry');
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(4500), 3500, 6500], [fx(2500), 600, 0]]);
await shot('guide');

// 2) 駆動側の基礎
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(9000), 3000, -8000], [fx(0), 800, -13000]]);
await shot('drive');

// 3) 転倒機: スラブを立てた瞬間（SET 完了）と倒し切った瞬間
await page.evaluate(() => { window.__startAuto(true); window.__ff(P => P.supply.phase === 'TILT'); });
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(-20000), 3500, 9000], [fx(-13200), 1500, 3800]]);
await shot('tilter-set');
await page.evaluate(() => window.__ff(P => P.supply.phase === 'RUNIN'));
await shot('tilter-down');

// 3b) 反り: 厚板パスでロールから出た先端が反り上がり、自重で垂れて着地する様子（第3パス）
await cut('half');
await page.evaluate(() => { window.__startAuto(false); window.__ff(P => P.mill.passIndex === 2 && P.slab.rollingActive && Math.abs(P.slab.dir > 0 ? P.slab.xMax : P.slab.xMin) > 2500); });
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(4000), 2800, 9000], [fx(3500), 1000, 0]]);
await shot('curl-head-early');
await page.evaluate(() => window.__ff(P => Math.abs(P.slab.dir > 0 ? P.slab.xMax : P.slab.xMin) > 9000));
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(7000), 3500, 12000], [fx(5500), 1000, 0]]);
await shot('curl-head-late');
await page.evaluate(() => window.__ff(P => !P.slab.rollingActive));
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(-4000), 3200, 9000], [fx(-2000), 1000, 0]]);
await shot('curl-tail-ski');

// 4) 巻取: 巻き始め（数巻）と巻き終わり近く。手前の架構は半断面で透かす
await cut('half');
await page.evaluate(() => { window.__startAuto(false); window.__ff(P => P.finish.gripped && P.finish.coiledLen > 8000); });
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(12000), 3200, 6500], [fx(7800), 2000, 0]]);
await shot('coil-start');
await page.evaluate(() => window.__ff(P => P.finish.coiledLen > 60000));
await shot('coil-mid');
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(11000), 2800, 60], [fx(8000), 2000, 0]]);
await shot('coil-side');
// 操作側から軸方向に見る側面図: 段・渡り板の接線・押えコロの当たりが読める
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(7600), 2100, 7000], [fx(7600), 2100, 0]]);
await shot('coil-axis');
await page.evaluate(() => window.__ff(P => P.finish.done));
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(12000), 3200, 6500], [fx(7800), 2000, 0]]);
await shot('coil-done');

// 5) 75 mm シャー: 切断の瞬間（下台が上がって板が上刃に当たる）と、2 カット目・払い出し後
await cut('half');
await page.evaluate(() => { window.__startAuto(false); window.__ff(P => P.finish.cropStage === 'CUT'); });
await page.evaluate(() => window.__ff(P => P.finish.cropBlade > 0.6 || P.finish.cropStage !== 'CUT'));
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(34500), 2600, 6000], [fx(30600), 900, 0]]);
await shot('shear-cut');
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(30600), 1500, 5200], [fx(30600), 900, 0]]);
await shot('shear-cut-side');
await page.evaluate(() => window.__ff(P => P.finish.cropIndex >= 1 && P.finish.cropStage === 'CUT' && P.finish.cropBlade > 0.6));
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(34500), 2600, 6000], [fx(30600), 900, 0]]);
await shot('shear-cut2');
await page.evaluate(() => window.__ff(P => P.finish.cropDone));
await page.evaluate(() => window.__ff((P, n) => n > 240));
await shot('shear-after');

await browser.close();
