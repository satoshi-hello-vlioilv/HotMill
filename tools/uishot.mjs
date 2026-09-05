// UI の見え方（1920×1080）: 素材パネルを開いた待機画面と、運転中の計器
import path from 'node:path';
import { openApp, installHelpers, __dirname } from './harness.mjs';
const LABEL = process.argv[2] || 'ui';
const { browser, page } = await openApp({ viewport: { width: 1920, height: 1080 }, quiet: true });
await installHelpers(page);
await page.evaluate(() => {
  for (const d of document.querySelectorAll('details.sec')) d.open = false;
  document.querySelectorAll('details.sec')[0].open = true;          // 素材と目標
  window.__app.ui.selectView(1); window.__app.world.applyView(window.__CFG.VIEWS[1], true);
  window.__app.world.render(window.__app.physics, 1 / 60);
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(__dirname, 'shots', `ui-idle-${LABEL}.png`) });
await page.evaluate(() => {
  const s = document.getElementById('sel-alloy'); s.value = 'A7075'; s.dispatchEvent(new Event('change'));
  const r = document.getElementById('rng-target'); r.value = 60; r.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(__dirname, 'shots', `ui-alloy-${LABEL}.png`) });
await page.evaluate(() => {
  for (const d of document.querySelectorAll('details.sec')) d.open = false;
  document.querySelectorAll('details.sec')[1].open = true; document.querySelectorAll('details.sec')[2].open = true;
  window.__startAuto(false);
  window.__ff(P => P.mill.passIndex === 3 && P.slab.rollingActive && Math.abs(P.slab.dir > 0 ? P.slab.xMax : P.slab.xMin) > 6000);
  const F = window.__CFG.FLIP;
  window.__cam([F * 6000, 3200, 11000], [F * 4000, 1000, 0]);
  window.__app.ui.onState(window.__app.physics); window.__app.ui._acc = 0; window.__app.ui.onState(window.__app.physics);
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(__dirname, 'shots', `ui-running-${LABEL}.png`) });
console.log('done');
await browser.close();
