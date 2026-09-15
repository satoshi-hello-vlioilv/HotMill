// 持ちかかり温度の «読み» の実測トレース（README 0-3 の «持ちかかりの読み»）。
//
// ご回答（2026-09-15）: 持ちかかり温度は «洗浄してから、トランスファークレーンで掴むときに測るスラブ
// センターの表面»。本アプリは入力の温度を «吊る瞬間の上面» と解釈し（SUPPLY.PICKUP_READ 'TOP'）、
// 板厚方向の分布（ピット炉の下加熱・放射・洗浄の冷え）を解いて上面がその値になるように素材の温度を置く。
//
//   ① 工程が GRAB に入る瞬間の上面が入力の温度に一致する（運転の実測。0.05 K 以内）
//   ② そのときの板厚平均は読みより高い（下加熱・放射・洗浄の冷えの向きどおり）
//   ③ 洗浄で平均が dMean だけ実際に下がる（冷えを板に入れている）
//   ④ 旧解釈（'MEAN'）に切り替えると板厚平均 ＝ 入力に戻る（静的解）
//   ⑤ 上面は吊ったあとも洗浄の冷えから戻り続ける（圧延開始時の上面と平均の差 ＜ 吊る瞬間の差）
//   参考: 読みと平均の差が «洗浄から測るまでの秒»（PICKUP_LAG_S。実機は未知）でどう動くか、
//         その差が最初のパスの荷重にどれだけ効くか
//
//   node tools/pickuptrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => new Promise(res => setTimeout(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, sup = P.supply, s = P.slab, SS = s.constructor;
  const mean = (T) => { let q = 0, n = T.length; for (let j = 0; j < n; j++) q += (j === 0 || j === n - 1) ? T[j] / 2 : T[j]; return q / (n - 1); };
  const t0 = s.initialTemp, pre = { top: s.T[0], mean: s.temperature, bot: s.T[s.T.length - 1] };
  const chill = SS.washChill(s, K.SUPPLY.WASHER.SEC);
  // 参考: 待ち秒を振ったときの «読み − 平均»（静的解。素材は同じ分布から）
  const lag0 = K.SUPPLY.PICKUP_LAG_S, lagRows = [];
  for (const lag of [0, SS.pickupLagSec(), 5, 15, 30, 60]) {
    K.SUPPLY.PICKUP_LAG_S = lag;
    const T = SS.pitProfile(t0, s.thickness, s.alloy, s.width, s.length), g = SS.pickupTop(T, s.thickness, s.alloy, s.width, s.length);
    lagRows.push({ lag, top: g.top, mean: g.mean, D: g.mean - g.top, meanPre: mean(T) });
  }
  K.SUPPLY.PICKUP_LAG_S = lag0;
  // 旧解釈の静的解
  const read0 = K.SUPPLY.PICKUP_READ; K.SUPPLY.PICKUP_READ = 'MEAN';
  const Tm = SS.pitProfile(t0, s.thickness, s.alloy, s.width, s.length); const meanOld = mean(Tm), topOld = Tm[0];
  K.SUPPLY.PICKUP_READ = read0;
  // 参考: 最初のパス（既定ロットの 2 パス目 520 → 490）の荷重 —— 層温度そのままと、平均 ＝ 読み の場合
  const sch = K.SCHEDULE, g1 = sch[1] ? sch[1].gap : 490, g0 = sch[0] ? sch[0].gap : 520, v = sch[1] ? sch[1].speed : 120;
  const fNew = R.solve(g0, g1, s.width, v, s.T, 0, s.alloy).forceTon;
  const fOld = R.solve(g0, g1, s.width, v, Tm, 0, s.alloy).forceTon;

  window.__startAuto(true);
  let atGrab = null, meanAfterWash = null, meanBeforeWash = null, last = '';
  window.__ff((p, n) => {
    const ph = sup.phase;
    if (ph === 'WASH' && meanBeforeWash === null) meanBeforeWash = s.temperature;
    if (last === 'WASH' && ph !== 'WASH') meanAfterWash = s.temperature;
    if (ph === 'GRAB' && atGrab === null) atGrab = { top: s.T[0], mean: s.temperature, bot: s.T[s.T.length - 1], pick: sup.pickup ? { ...sup.pickup } : null };
    last = ph;
    return !sup.active;
  }, 120 * 900, 0);
  const atLine = { top: s.T[0], mean: s.temperature, bot: s.T[s.T.length - 1] };
  res({ t0, pre, chill: { dMean: chill.dMean, dTop: chill.dTop, dBot: chill.dBot }, lagRows, lagUsed: SS.pickupLagSec(), read: read0,
        meanOld, topOld, fNew, fOld, atGrab, atLine, meanBeforeWash, meanAfterWash, soakDT: K.FURNACE.SOAK_DT, holdMin: K.SUPPLY.HOLD_MIN });
}, 300)));
await browser.close();

const f1 = (x, d = 1) => (+x).toFixed(d);
const checks = [];
const ok = (name, pass, got, ref = false) => { checks.push({ name, pass: !!pass, got, ref }); console.log(`${ref ? '??' : pass ? 'OK' : 'NG'}   ${name}  → ${got}`); };
console.log(`読み ${out.t0} ℃（${out.read}）／ 洗浄前の分布: 上面 ${f1(out.pre.top)}・平均 ${f1(out.pre.mean)}・下面 ${f1(out.pre.bot)} ℃`
  + `（ピット炉の上下差 ${out.soakDT} K を ${out.holdMin} 分均した形。洗浄で 平均 −${f1(out.chill.dMean)}・上面 −${f1(out.chill.dTop)} K）`);
const g = out.atGrab;
ok('吊る瞬間（GRAB に入る）の上面が入力の読みに一致する', g && Math.abs(g.top - out.t0) < 0.05, g ? `${f1(g.top, 2)} ℃ vs 読み ${out.t0}（差 ${f1(g.top - out.t0, 3)} K、待ち ${out.lagUsed} s）` : 'GRAB に届かず');
ok('吊る瞬間の板厚平均は読みより高い（下加熱 ＋ 放射 ＋ 洗浄の冷えの向き）', g && g.mean > out.t0 + 1, g ? `平均 ${f1(g.mean)}・下面 ${f1(g.bot)} ℃（読み ＋ ${f1(g.mean - out.t0)} K）` : '—');
ok('洗浄で板厚平均が解いた冷え（dMean）だけ実際に下がる', out.meanBeforeWash !== null && out.meanAfterWash !== null && Math.abs((out.meanBeforeWash - out.meanAfterWash) - out.chill.dMean) < 0.05,
   `${f1(out.meanBeforeWash, 2)} → ${f1(out.meanAfterWash, 2)} ℃（−${f1(out.meanBeforeWash - out.meanAfterWash, 2)} K、解 ${f1(out.chill.dMean, 2)} K）`);
ok("旧解釈 'MEAN' では板厚平均 ＝ 入力（静的解）", Math.abs(out.meanOld - out.t0) < 0.05, `平均 ${f1(out.meanOld, 2)} ℃・上面 ${f1(out.topOld)} ℃`);
ok('吊ったあとも上面は戻り続ける（圧延開始時の 平均 − 上面 ＜ 吊る瞬間の差）', g && (out.atLine.mean - out.atLine.top) < (g.mean - g.top), g ? `吊る瞬間 ${f1(g.mean - g.top)} K → 圧延開始 ${f1(out.atLine.mean - out.atLine.top)} K` : '—');
ok('（参考）洗浄から測るまでの秒 → 読みと平均の差', true, out.lagRows.map(r => `${r.lag} s: ${f1(r.D)} K`).join(' ／ '), true);
ok('（参考）最初の圧下パス（520 → 490）の荷重: 読みを上面とした分布 vs 平均 ＝ 読み', true, `${f1(out.fNew, 0)} t vs ${f1(out.fOld, 0)} t（${f1((out.fNew / out.fOld - 1) * 100)} %）`, true);
const fails = checks.filter(c => !c.ref && !c.pass).length, n = checks.filter(c => !c.ref).length;
console.log(`RESULT: ${fails ? 'FAIL' : 'PASS'} (${n - fails}/${n}、参考 ${checks.filter(c => c.ref).length} 件)`);
process.exit(fails ? 1 : 0);
