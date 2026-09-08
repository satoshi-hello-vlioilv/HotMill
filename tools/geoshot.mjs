// サイドガイドと板面冷却ヘッダの見え方を撮る（形状変更の確認用）
//   node tools/geoshot.mjs <label>
import path from 'node:path';
import { openApp, installHelpers, __dirname } from './harness.mjs';
const LABEL = process.argv[2] || 'geo';
const { browser, page, errors } = await openApp({ viewport: { width: 1600, height: 900 }, quiet: true });
await installHelpers(page);
const shot = async (name) => { await page.waitForTimeout(120);
  await page.evaluate(() => window.__app.world.render(window.__app.physics, 1 / 60));
  await page.screenshot({ path: path.join(__dirname, 'shots', `${name}-${LABEL}.png`) }); console.log('shot', name); };
const F = await page.evaluate(() => window.__CFG.FLIP);
const fx = (x) => x * F;
await page.evaluate(() => { window.__app.ui.setLabels(false); window.__app.ui.setCutaway('solid'); });
// サイドガイド（出側ステーション）を操作側斜め上から
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(6200), 1800, 3400], [fx(3400), 900, 800]]);
await shot('guide-close');
// ヘッダを含む冷却ステーション全体
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(7800), 3800, 5600], [fx(3400), 1500, 0]]);
await shot('cool-station');
// 噴射中（第 3 パス、板がヘッダの下）
await page.evaluate(() => { window.__startAuto(false); window.__ff(P => P.mill.passIndex === 5 && P.slab.rollingActive && Math.abs(P.slab.dir > 0 ? P.slab.xMax : P.slab.xMin) > 4200); });
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(6800), 2800, 4400], [fx(3400), 1200, 0]]);
for (let i = 0; i < 40; i++) await page.evaluate(() => { window.__app.physics.step(1 / 120); window.__app.world.render(window.__app.physics, 1 / 60); });
await shot('cool-spray');
// ライン方向から（ノズルの角度とクォーター狙いが読める）
await page.evaluate(([p, t]) => window.__cam(p, t), [[fx(8200), 1700, 0], [fx(3400), 1300, 0]]);
for (let i = 0; i < 20; i++) await page.evaluate(() => { window.__app.physics.step(1 / 120); window.__app.world.render(window.__app.physics, 1 / 60); });
await shot('cool-axis');
console.log('errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
