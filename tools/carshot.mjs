// コイルカーの «足が付いているか» を撮る。巻取完了まで進めてから各段階で撮影。
import fs from 'node:fs'; import path from 'node:path';
import { openApp, installHelpers, __dirname } from './harness.mjs';
const dir = path.join(__dirname, 'shots'); fs.mkdirSync(dir, { recursive: true });
const { browser, page, errors } = await openApp({ viewport: { width: 1400, height: 800 }, quiet: true });
await installHelpers(page);
await page.evaluate(() => {
  for (const id of ['sidebar', 'metrics', 'hud-top', 'status-banner']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
  window.__app.world.setCutaway('solid');       // 断面表示だと台車が透けて «足» が見えない
  window.__app.ui.labelsOn = false;
});
const shoot = async (name, pos, tgt) => {
  // 座標は «世界» のまま渡す（COILER.X などは既に FLIP 済みの値）
  await page.evaluate(([p, t]) => {
    const w = window.__app.world;
    w.applyView({ pos: p, tgt: t }, true);
    w.render(window.__app.physics, 1 / 60);
  }, [pos, tgt]);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__app.world.render(window.__app.physics, 1 / 60));
  await page.screenshot({ path: path.join(dir, name + '.png') });
  console.log('shot', name);
};
await page.evaluate(() => { window.__startAuto(false); });
for (const [name, want] of [['car-approach', 'APPROACH'], ['car-lift', 'LIFT'], ['car-carry', 'CARRY'], ['car-set', 'SET']]) {
  const got = await page.evaluate((w) => {
    const P = window.__app.physics;
    window.__ff((p) => p.finish.carStage === w || p.tripped, 120 * 3000, 0);
    return P.finish.carStage;
  }, want);
  await page.evaluate(() => window.__app.world.render(window.__app.physics, 1 / 60));
  const st = await page.evaluate(() => ({ x: window.__CFG.COILER.X, z: window.__app.physics.finish.carZ }));
  await shoot(name, [st.x - 3600, 1900, st.z + 5200], [st.x, 700, st.z]);
  console.log('  stage =', got);
}
if (errors.length) console.log('errors:', errors);
await browser.close();
