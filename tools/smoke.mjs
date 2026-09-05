// 起動 → 自動運転を固定ステップで完走 → 主要な結果を出す（最短の健全性確認）
import { openApp, installHelpers } from './harness.mjs';
const target = process.argv[2] ? +process.argv[2] : null, alloy = process.argv[3] || null;
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: false });
await installHelpers(page);
const out = await page.evaluate(({ target, alloy }) => {
  const A = window.__app, P = A.physics, K = window.__CFG;
  if (alloy) { const s = document.getElementById('sel-alloy'); s.value = alloy; s.dispatchEvent(new Event('change')); }
  if (target) { const r = document.getElementById('rng-target'); r.value = target; r.dispatchEvent(new Event('input')); }
  return new Promise(res => setTimeout(() => {
    window.__startAuto(false);
    const log = []; let last = -2, maxF = 0, maxP = 0;
    const r = window.__ff((p, n) => {
      maxF = Math.max(maxF, p.slab.rollForce); maxP = Math.max(maxP, p.slab.rollPower);
      if (p.mill.passIndex !== last) { last = p.mill.passIndex; log.push({ t: +(n / 120).toFixed(1), pass: last, th: +p.slab.thickness.toFixed(1), len: +(p.slab.length / 1000).toFixed(2), T: +p.slab.temperature.toFixed(0) }); }
      if (n % 240 === 0) A.world.render(P, 2);
      return p.finish.done || !!p.tripped;
    }, 120 * 2500, 0);
    const f = P.finish, s = P.slab;
    const feas = window.__ROLL.scheduleFeasibility(K.SCHEDULE, s.alloy, f.mode === 'COIL');
    res({ steps: r.n, t: r.t, done: f.done, tripped: P.tripped, feasible: feas.ok, feasReasons: feas.reasons, mode: f.mode, target: K.SLAB.TARGET_TH, passes: K.SCHEDULE.length, log,
          maxForceT: +maxF.toFixed(0), maxPowerKW: +maxP.toFixed(0), sched: K.SCHEDULE.map(q => `${q.gap}@${q.speed}`).join(' '),
          th: +s.thickness.toFixed(2), len: +(s.length / 1000).toFixed(2), turns: +f.turns.toFixed(1), layers: f.layers,
          od: +f.od.toFixed(0), odLayers: +(2 * (K.COILER.MANDREL_D / 2 + f.turns * s.thickness)).toFixed(0),
          coiledLen: +(f.coiledLen / 1000).toFixed(1), plateStage: f.plateStage, plateZ: +f.plateZ.toFixed(0), crop: { done: f.cropDone, len: f.cropLen } });
  }, 400));
}, { target, alloy });
out.log = out.log.map(l => `${l.t}s p${l.pass} ${l.th}mm ${l.len}m ${l.T}C`);
console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
