// 板厚方向の熱モデルの単体検証: 表面放熱の速度と、ロール抜熱のエネルギー収支
import { openApp, installHelpers } from './harness.mjs';
const { browser, page } = await openApp({ viewport: { width: 600, height: 400 }, quiet: false });
await installHelpers(page);
const out = await page.evaluate(() => {
  const P = window.__app.physics, K = window.__CFG, s = P.slab, M = K.MATERIAL, al = s.alloy;
  const rc = al.RHO * al.CP;
  const res = {};
  // (1) 放熱のみ 60 s（動かない板、30 mm、400 ℃）
  s.thickness = 30; s.length = 50000; s.T.fill(400); s.inBite = false; s.onLine = true; P.mill.currentSpeed = 0;
  const T0 = s.temperature;
  for (let i = 0; i < 120 * 60; i++) P._thermal(1 / 120);
  const q = M.EMISSIVITY * 5.67e-8 * ((673.15 ** 4) - (303.15 ** 4)) + M.H_AIR * 370;
  res.surface = { drop: +(T0 - s.temperature).toFixed(2), expectApprox: +(2 * q * 60 / (rc * 0.03)).toFixed(2), top: +s.tTop.toFixed(1), core: +s.tCore.toFixed(1) };
  // (2) 抜熱のエネルギー収支（passedFrac = 1、接触時間 0.1 s、gap 30）
  s.T.fill(400); const T1 = s.temperature;
  P._biteThermal(0, 0.1, 30, 1);
  const x = 2 * M.H_ROLL * 0.1 / (rc * 0.03);
  res.chill = { drop: +(T1 - s.temperature).toFixed(2), expect: +((400 - M.T_ROLL) * (1 - Math.exp(-x))).toFixed(2), top: +s.tTop.toFixed(1), core: +s.tCore.toFixed(1), layers: Array.from(s.T).map(v => +v.toFixed(0)) };
  // (3) 冷却域のクーラント込み 60 s（噛み込み中・50 m の板・50 mpm）
  s.T.fill(400); s.inBite = true; P.mill.currentSpeed = 50; s.length = 50000; s.thickness = 30;
  const T2 = s.temperature;
  for (let i = 0; i < 120 * 60; i++) P._thermal(1 / 120);
  res.coolant = { drop: +(T2 - s.temperature).toFixed(2), top: +s.tTop.toFixed(1), core: +s.tCore.toFixed(1), bot: +s.tBot.toFixed(1),
    expectApprox: +(((M.H_COOL_TOP + M.H_COOL_BOT) * (2400 / 50000) * 360 + 2 * q) * 60 / (rc * 0.03)).toFixed(2) };
  // (4) 8 mm 薄板・150 m・70 mpm で 170 s
  s.T.fill(300); s.inBite = true; P.mill.currentSpeed = 70; s.length = 150000; s.thickness = 8;
  const T3 = s.temperature;
  for (let i = 0; i < 120 * 170; i++) P._thermal(1 / 120);
  res.thin = { drop: +(T3 - s.temperature).toFixed(2), top: +s.tTop.toFixed(1) };
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
