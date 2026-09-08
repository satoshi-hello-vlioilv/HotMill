// ピット炉・スラブヤード周りの «見た目» を撮る。
//   node yardshot.mjs
import fs from 'node:fs'; import path from 'node:path';
import { openApp, installHelpers, __dirname } from './harness.mjs';
const dir = path.join(__dirname, 'shots');
fs.mkdirSync(dir, { recursive: true });
const { browser, page, errors } = await openApp({ viewport: { width: 1400, height: 800 }, quiet: true });
await installHelpers(page);
// UI を伏せて 3D だけを撮る（設備の見え方を確かめるため）
await page.evaluate(() => {
  for (const id of ['sidebar', 'metrics', 'hud-top', 'status-banner']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
  window.__app.world.setCutaway('solid');
});
const shots = [
  ['yard-pit',   [-60000, 30000, 56000], [-96000,  2000, 18000]],
  ['yard-close', [-78000,  7000, 26000], [-90000,  1200, 15000]],
  ['yard-top',   [-90000, 34000, 18500], [-90000,     0, 18000]],
  ['tilter-hole',[ -4000, 11000, 30000], [-16000,   200, 20000]],
  ['crane',      [-74000, 14000, 36000], [-86000,  7000, 21500]],
  ['stacker',    [-70000, 12000, 44000], [-88000,  5000, 21500]],
  ['cab',        [-85200, 11800, 25200], [-88400, 11000, 21500]],
];
for (const [name, pos, tgt] of shots) {
  await page.evaluate(([p, t]) => {
    const w = window.__app.world, F = window.__CFG.FLIP;
    w.applyView({ pos: [p[0] * F, p[1], p[2]], tgt: [t[0] * F, t[1], t[2]] }, true);
    w.render(window.__app.physics, 1 / 60);
  }, [pos, tgt]);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__app.world.render(window.__app.physics, 1 / 60));
  await page.screenshot({ path: path.join(dir, name + '.png') });
  console.log('shot', name);
}
if (errors.length) console.log('errors:', errors);
await browser.close();
