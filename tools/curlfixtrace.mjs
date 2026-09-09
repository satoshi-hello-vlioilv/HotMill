// 板反り対策（パスライン調整・板面冷却の入側／出側 ON-OFF）の «効果» の実測。
//   node curlfixtrace.mjs
// 実機で使う 2 つの手が、どちらへ・どれだけ効くかを数字で出す。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, L = window.__LAYOUT;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });

  /* ---------- パスライン調整 ---------- */
  ok('基準位置では曲げが入らない', R.passLineCurl(0) === 0, '0 1/mm');
  const kUp = R.passLineCurl(30), kDn = R.passLineCurl(-30);
  ok('ロール組を上げると板は下へ曲げられる（上反りを打ち消す向き）', kUp < 0,
     `+30 mm → ${kUp.toExponential(3)} 1/mm（半径 ${(1 / Math.abs(kUp) / 1000).toFixed(1)} m）`);
  ok('下げると逆向きになる', kDn > 0 && Math.abs(kDn + kUp) < 1e-18, `−30 mm → ${kDn.toExponential(3)} 1/mm`);
  ok('調整量に比例する', Math.abs(R.passLineCurl(60) / kUp - 2) < 1e-9, '60 mm は 30 mm の 2 倍');
  ok('式が 3δ/L² どおり', Math.abs(Math.abs(kUp) - 3 * 30 / (K.MILL.PL_SPAN ** 2)) < 1e-18,
     `L = ${K.MILL.PL_SPAN} mm`);
  // 可動範囲
  A.bus.emit('CMD_SET_PASSLINE', 999);
  ok('可動範囲に収まる（ウェッジの範囲内）', P.mill.plOffset === K.MILL.PL_RANGE,
     `指令 999 mm → ${P.mill.plOffset} mm（範囲 ±${K.MILL.PL_RANGE}）`);
  A.bus.emit('CMD_SET_PASSLINE', 40);
  ok('パスラインを動かすとロールの組が動く', Math.abs(P.mill.passLine - (K.MILL.PASS_LINE + 40)) < 1e-9,
     `パスライン ${P.mill.passLine} mm（基準 ${K.MILL.PASS_LINE}）`);
  ok('ロールの上下位置も一緒に動く', Math.abs(P.mill.wrBotY - (K.MILL.PASS_LINE + 40 - P.mill.wrDia / 2)) < 1e-9,
     `下 WR 軸心 ${P.mill.wrBotY.toFixed(1)} mm`);
  A.bus.emit('CMD_SET_PASSLINE', 0);

  /* ---------- 板面冷却の入側 / 出側 ---------- */
  const SC = K.MATERIAL.STRIP_COOL;
  // ヘッダは 1 ステーションに OS / DS の 2 本。ON/OFF はステーション単位（Layout.coolStations(true)）
  const nAll = L.coolStations().length, LEN = K.TABLE.GUIDE.HEADER.LEN;
  SC.ENTRY = true; SC.EXIT = true;
  ok('両方 ON なら全ヘッダが効く', L.coolHeaderCount() === nAll * 2, `${L.coolHeaderCount()} / ${nAll * 2} 本`);
  SC.ENTRY = false;
  ok('入側を切ると入側のヘッダだけ止まる',
     L.coolStations(true).length === nAll / 2 && L.coolStations(true).every(x => x < 0),
     `${L.coolHeaderCount()} 本（すべて出側）`);
  SC.ENTRY = true; SC.EXIT = false;
  ok('出側を切ると出側のヘッダだけ止まる',
     L.coolStations(true).length === nAll / 2 && L.coolStations(true).every(x => x > 0),
     `${L.coolHeaderCount()} 本（すべて入側）`);
  SC.ENTRY = false; SC.EXIT = false;
  ok('両方切るとヘッダは効かない', L.coolHeaderCount() === 0, '0 本');
  ok('設備そのものは消えない（ON/OFF は運転の話）', L.coolHeaderCount(false) === nAll * 2, `${nAll * 2} 本のまま`);
  ok('スケジュール予測も同じ冷却域を見る', R.activeCoolLength(1e9) === 0, `有効 ${R.activeCoolLength(1e9)} mm`);
  SC.ENTRY = true; SC.EXIT = true;
  ok('戻すと元どおり', R.activeCoolLength(1e9) === nAll * LEN, `${R.activeCoolLength(1e9)} mm`);

  /* ---------- 通し運転で «効果» を測る ---------- */
  const run = (pl, entry, exit) => new Promise(r => {
    SC.ENTRY = entry; SC.EXIT = exit;
    A.bus.emit('CMD_RESET');
    setTimeout(() => {
      A.bus.emit('CMD_SET_PASSLINE', pl);
      window.__startAuto(false);
      let kMax = 0, kMin = 0, tipMax = 0, dTmax = 0, absMax = 0;
      window.__ff((p) => {
        const s = p.slab;
        if (s.rollingActive && s.biteFill > 0.99) {
          kMax = Math.max(kMax, s.kNew); kMin = Math.min(kMin, s.kNew);
          absMax = Math.max(absMax, Math.abs(s.kNew));
          dTmax = Math.max(dTmax, Math.abs(s.tBot - s.tTop));
          // 端の浮きは «上反り» のときだけ。下反りはテーブルに押さえられて浮かない
          const sp = R.curlSpan(s.kNew, p.mill.gap, s.width, s.alloy);
          if (s.kNew > 0) tipMax = Math.max(tipMax, sp.tip);
        }
        return p.finish.done || !!p.tripped;
      }, 120 * 3000, 0);
      r({ kMax, kMin, absMax, tipMax, dTmax, done: P.finish.done });
    }, 400);
  });
  return (async () => {
    const base = await run(0, true, true);
    const up = await run(60, true, true);
    /* パスラインを振って «いちばん反りが小さくなる点» を探す。
     * 上げ過ぎると今度は下反りになるので、絶対値の最小が最適点になる。 */
    const sweep = [];
    for (const v of [-20, -10, 0, 5, 10, 15, 20, 30]) {
      const r0 = await run(v, true, true);
      sweep.push({ pl: v, k: r0.absMax, up: r0.kMax, dn: r0.kMin, tip: r0.tipMax });
    }
    const best = sweep.reduce((a, b) => (b.k < a.k ? b : a));
    const noEntry = await run(0, false, true);
    const noneCool = await run(0, false, false);
    ok('パスラインを上げると上反りが減る（実機の対策どおり）', up.kMax < base.kMax,
       `基準 κ ${base.kMax.toExponential(2)}（端の浮き ${base.tipMax.toFixed(0)} mm）→ +60 mm で ${up.kMax.toExponential(2)}（${up.tipMax.toFixed(0)} mm）`);
    ok('パスライン調整で端の浮きが目に見えて減る', up.tipMax < base.tipMax * 0.9,
       `${base.tipMax.toFixed(0)} → ${up.tipMax.toFixed(0)} mm（${(100 * (1 - up.tipMax / Math.max(base.tipMax, 1e-9))).toFixed(0)} % 減）`);
    ok('板面冷却を切ると上下の温度差が変わる', Math.abs(noneCool.dTmax - base.dTmax) > 0.1,
       `両方 ON ${base.dTmax.toFixed(1)} K → 両方 OFF ${noneCool.dTmax.toFixed(1)} K`);
    ok('入側だけ切っても効く（片側でも上下差が動く）', Math.abs(noEntry.dTmax - base.dTmax) > 0.01,
       `両方 ON ${base.dTmax.toFixed(1)} K → 入側 OFF ${noEntry.dTmax.toFixed(1)} K`);
    ok('上げ過ぎると今度は下反りになる（打ち消し過ぎ）', up.kMin < 0,
       `+60 mm で κmin ${up.kMin.toExponential(2)}（下反り）`);
    ok('反りを最小にするパスラインが範囲の内側にある（最適点がある）',
       best.pl > Math.min(...sweep.map(q => q.pl)) && best.pl < Math.max(...sweep.map(q => q.pl)),
       `最適 ${best.pl > 0 ? '+' : ''}${best.pl} mm ／ |κ| ${best.k.toExponential(2)}`);
    // 既定（入側冷却 OFF）は既に反りが最小の点にあることがある。掃引が基準より悪い点を «最適» と
    // 呼ばないことを問う（基準が最適なら等しくてよい）
    ok('最適点の反りは基準以下（基準が最適なら等しい。同じ設定の再走で 1 % 未満の差は同値）', best.k <= base.absMax * 1.01,
       `基準 ${base.absMax.toExponential(2)} → 最適 ${best.k.toExponential(2)} 1/mm`);
    ok('どの設定でもロットを通し切る', base.done && up.done && noEntry.done && noneCool.done, 'すべて完走');
    return { checks, base, up, noEntry, noneCool, sweep, best };
  })();
});
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
const f = (r) => `κmax ${r.kMax.toExponential(2)} ／ 端の浮き ${r.tipMax.toFixed(0)} mm ／ 上下ΔT ${r.dTmax.toFixed(1)} K`;
console.log(`基準            : ${f(out.base)}`);
console.log(`パスライン +60mm: ${f(out.up)}`);
console.log(`入側冷却 OFF    : ${f(out.noEntry)}`);
console.log(`冷却 両方 OFF   : ${f(out.noneCool)}`);
console.log('--- パスライン掃引（|κ| が小さいほど平ら）---');
console.log('パスライン mm   |κ| 1/mm     上反り κ     下反り κ     端の浮き mm');
for (const q of out.sweep)
  console.log(`${String(q.pl > 0 ? '+' + q.pl : q.pl).padStart(11)} ${q.k.toExponential(2).padStart(12)}`
    + ` ${q.up.toExponential(2).padStart(12)} ${q.dn.toExponential(2).padStart(12)} ${q.tip.toFixed(0).padStart(12)}`
    + (q.pl === out.best.pl ? '   ← 最適' : ''));
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
