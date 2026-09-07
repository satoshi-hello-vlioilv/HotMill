// 画面確認用の撮影（実績ビュワーと計器）
import fs from 'node:fs'; import path from 'node:path';
import { openApp, installHelpers } from './harness.mjs';
const dir = '/tmp/claude-0/-home-user-HotMill/56790db5-93fb-5407-8bb4-eeb2a08ba824/scratchpad/shots';
fs.mkdirSync(dir, { recursive: true });
const { browser, page, errors } = await openApp({ viewport: { width: 1600, height: 900 }, quiet: true });
await installHelpers(page);
await page.evaluate(() => { window.__startAuto(false);
  window.__ff(P => P.mill.passIndex >= 7 && P.slab.rollingActive && P.slab.biteFill > 0.99, 120 * 2000, 0); });
await page.evaluate(() => { const w = window.__app.world, K = window.__CFG;
  w.applyView(K.VIEWS.find(v => v.id === 'bite'), true); w.render(window.__app.physics, 1/60); });
await page.waitForTimeout(400);
await page.evaluate(() => window.__app.world.render(window.__app.physics, 1/60));
await page.screenshot({ path: path.join(dir, 'shape-log.png') });
const st = await page.evaluate(() => {
  const s = window.__app.physics.slab, m = window.__app.physics.mill, sh = s.wShape;
  return { pass: m.passIndex + 1, h: +s.thickness.toFixed(2), gap: +m.gap.toFixed(2), w: +s.width.toFixed(1),
           crown: sh && +sh.crownAbs.toFixed(1), ratio: sh && +(sh.crownRatio*100).toFixed(3),
           I: sh && +sh.iUnit.toFixed(1), mode: sh && sh.modeName, bend: +m.bendForceT.toFixed(0),
           chips: document.querySelectorAll('#log-series .chip').length };
});
console.log(JSON.stringify(st));
if (errors.length) console.log('errors:', errors);
await browser.close();
