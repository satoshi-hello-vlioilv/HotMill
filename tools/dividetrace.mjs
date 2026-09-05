// 板材の切り分け（30 mm / 75 mm シャー）とパイラー積みの «実測» トレース。
//   node dividetrace.mjs [目標板厚 mm]
//  ・シートの長さが定尺（SHEET_L）以下か、最後の板が定尺以下か
//  ・切り分け前後で総長が保存されるか、すべてのシートが山に積まれるか
//  ・シート同士が重ならないか（走行中の間隔 ≥ 0）
import { openApp, installHelpers } from './harness.mjs';
const target = process.argv[2] ? +process.argv[2] : 24;
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: false });
await installHelpers(page);
const out = await page.evaluate((target) => {
  const A = window.__app, P = A.physics, K = window.__CFG, PL = K.PILER, F = K.FLIP;
  const r = document.getElementById('rng-target'); r.value = target; r.dispatchEvent(new Event('input'));
  return new Promise(res => setTimeout(() => {
    window.__startAuto(false);
    const log = [], checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
    let L0 = 0, last = '', minGap = 1e9, overlapAt = null;
    window.__ff((p, n) => {
      const f = p.finish, s = p.slab;
      if (f.plateStage === 'DIVIDE' && !L0) L0 = s.length;
      const key = `${f.plateStage}/${f.divideStage}/${f.pilerStage}/${f.sheetCount}/${f.piled}`;
      if (key !== last) { last = key; log.push({ t: +(n / 120).toFixed(1), stage: key, len: +(s.length / 1000).toFixed(2), head: Math.round(F > 0 ? s.xMax : s.xMin) }); }
      const run = f.sheets.filter(q => q.stage === 'RUN');
      for (let i = 1; i < run.length; i++) { const gap = F * (run[i - 1].x - F * run[i - 1].len / 2) - F * (run[i].x + F * run[i].len / 2); if (gap < minGap) { minGap = gap; if (gap < 0) overlapAt = n / 120; } }
      if (run.length && f.plateStage === 'DIVIDE') {              // 板の先端と先頭シートの尾端
        const headTip = s.tipX(F > 0 ? 1 : -1), tailAhead = F * (run[run.length - 1].x - F * run[run.length - 1].len / 2);
        const gap = tailAhead - F * headTip; if (gap < minGap) { minGap = gap; if (gap < 0) overlapAt = n / 120; }
      }
      if (n % 240 === 0) A.world.render(P, 2);
      return f.done || !!p.tripped;
    }, 120 * 2500, 0);
    const f = P.finish, s = P.slab;
    const sheets = f.sheets.map(q => ({ len: Math.round(q.len), stage: q.stage, k: q.k }));
    const total = f.sheets.reduce((a, q) => a + q.len, 0) + s.length;
    ok('切り分けたシートはすべて定尺以下', f.sheets.every(q => q.len <= PL.SHEET_L + 1), sheets.map(q => q.len).join(' '));
    ok('最後の板（切らずに送った残り）が定尺 + 余裕以下', s.length <= PL.SHEET_L + 200 + 1, `${s.length.toFixed(0)} mm`);
    ok('総長が保存される（シート + 残り = 切り分け前）', Math.abs(total - L0) < 5, `${(total / 1000).toFixed(2)} / ${(L0 / 1000).toFixed(2)} m`);
    ok('すべてのシートが山に積まれ、板も積まれた', f.sheets.every(q => q.stage === 'PILED') && f.plateStage === 'DONE' && f.piled === f.sheets.length + 1,
       `積載 ${f.piled} / シート ${f.sheets.length} + 板 1`);
    ok('走行中のシート同士・板とシートが重ならない', minGap >= -1, `最小間隔 ${minGap.toFixed(0)} mm${overlapAt ? `（t=${overlapAt.toFixed(1)}s）` : ''}`);
    ok('パイラーのアームが閉じて終わる', f.pilerStage === 'CLOSED' || f.pilerStage === 'CLOSING', f.pilerStage);
    res({ target, divider: f.divideShear, done: f.done, tripped: P.tripped, L0: +(L0 / 1000).toFixed(2), sheets, rest: +(s.length / 1000).toFixed(2), piled: f.piled, pileH: f.pileH, log, checks });
  }, 400));
}, target);
console.log(`target ${out.target} mm → divider ${out.divider} / done ${out.done} / tripped ${out.tripped}`);
console.log(`L0 ${out.L0} m → sheets [${out.sheets.map(s => s.len).join(', ')}] + rest ${out.rest} m / piled ${out.piled} / pileH ${out.pileH}`);
for (const l of out.log) console.log(`  ${String(l.t).padStart(6)}s  ${l.stage.padEnd(36)} len ${l.len} m  head ${l.head}`);
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'}`);
if (errors.length) console.log('errors:', errors);
await browser.close();
