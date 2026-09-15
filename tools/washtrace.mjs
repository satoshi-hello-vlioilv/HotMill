// スラブ洗浄機（SUPPLY.WASHER）の «実測» トレース。
//
//   ① 装入の工程に WASH が FEED のあとに入り、秒が洗浄機の仕様（WASHER.SEC）と一致する
//   ② 洗っている間にスラブが洗浄機を «通過» する（先端が着いて始まり、尾端が抜けて終わる）
//   ③ 上ブラシは洗っている間だけ降りて板を挟み、それ以外は開いている。回るのも洗っている間だけ
//   ④ 下ブラシが受取テーブルのローラと場所を取り合わない（ローラの間に納まる）
//   ⑤ 冷却量: 板厚方向の層モデルで解いた «平均・上面・下面» の温度落ちと、クーラント 40 L で
//      抜ける熱の上限（液の温まり ＋ 蒸発）に対する比。ここは «参考» で毎回出す
//   ⑥ COOLS_INPUT が false（既定）なら圧延に掛かる板の温度は洗浄で変わらない。true なら
//      平均がちょうど dMean だけ下がる
//
//   node tools/washtrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => new Promise(res => setTimeout(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, S = K.SUPPLY, W = S.WASHER, F = K.FLIP;
  const SV = A.world.supplyView, sup = P.supply, s = P.slab;
  const seq = K.SEQUENCE.map(q => q[0]);
  const iF = seq.indexOf('FEED'), iW = seq.indexOf('WASH'), iF2 = seq.indexOf('FEED2');
  const secWash = P.supplyCtrl._sec('wash');
  const xw = S.TILTER_X + F * Layout_washerX();
  function Layout_washerX() { return window.__LAYOUT.washerX; }

  const T0 = Float64Array.from(s.T), mean0 = s.temperature;
  const wash = window.__ROLL ? null : null;
  const chill = P.slab.constructor.washChill(s, W.SEC);

  window.__startAuto(true);
  let washStart = null, washEnd = null, minTopYWash = Infinity, angle0 = null, angle1 = null;
  let openBefore = null, rotOutside = 0, lastAngle = SV.washer.angle, lastPhase = '';
  const B = W.BRUSH, D = S.PIVOT_DROP;
  window.__ff((p, n) => {
    /* 洗浄機の姿勢は描画（SupplyView.update）で更新される。毎コマ描くと評価器のソフトウェア
     * 描画が支配的になる（1 コマ 10〜60 ms）ので 6 コマに 1 回（20 Hz）にする。 */
    if (n % 6 === 0) A.world.render(P, 6 / 120);
    const ph = sup.phase, pose = SV._pose(sup, s, P.mill.passLine);
    if (ph === 'WASH') {
      if (washStart === null) { washStart = { x: pose.x, t: n / 120, angle: SV.washer.angle }; }
      washEnd = { x: pose.x, t: n / 120, angle: SV.washer.angle };
      minTopYWash = Math.min(minTopYWash, SV.washer.top.position.y / K.SCALE);   // 閉じ切った位置
    } else if (ph === 'FEED' && openBefore === null && (sup.p.feed || 0) > 0.5) openBefore = SV.washer.top.position.y / K.SCALE;
    if (ph !== 'WASH' && ph !== lastPhase && lastPhase === 'WASH') { /* 抜けた */ }
    if (ph !== 'WASH' && Math.abs(SV.washer.angle - lastAngle) > 1e-9 && ph !== 'FEED2') rotOutside++;
    lastAngle = SV.washer.angle; lastPhase = ph;
    return !sup.active;
  }, 120 * 600, 0);
  const meanAfter = s.temperature;
  /* ④ 下ブラシとローラ */
  const rollXs = SV.runoutRolls.xs, rr = K.TABLE.ROLL_D_END / 2, rb = B.D / 2;
  const clear = Math.min(...rollXs.map(x => Math.abs(x - SV.washer.xw))) - (rr + rb) * 0 ;   // 中心間距離の最小
  const need = Math.sqrt(Math.max((rr + rb) ** 2 - (rr - rb) ** 2, 0));   // 軸高さの差 (rr−rb) を考えた最小の中心間距離
  res({ seq, iF, iW, iF2, secWash, wSec: W.SEC, washStart, washEnd, L: s.length, xw,
        openBefore, minTopYWash, yClosed: D + s.thickness + B.D / 2, yOpen: D + s.thickness + B.D / 2 + B.OPEN,
        rotOutside, chill: { dMean: chill.dMean, dTop: chill.dTop, dBot: chill.dBot, Q: chill.Q, Qcap: chill.Qcap, capped: chill.capped, secs: chill.secs, liters: chill.liters },
        mean0, meanAfter, coolsInput: W.COOLS_INPUT, rollClear: clear, rollNeed: need, brushD: B.D });
}, 300)));
await browser.close();

const checks = [];
const ok = (n, pass, got, ref = false) => checks.push({ name: n, pass: !!pass, got, ref });

console.log(`工程: ${out.seq.join(' → ')}`);
console.log(`洗浄 ${out.secWash} s ／ 通過 ${out.washStart && out.washEnd ? ((out.washEnd.x - out.washStart.x) * (out.xw > out.washStart.x ? 1 : -1)).toFixed(0) : '—'} mm（板長 ${out.L} mm）`);
console.log(`冷却（板厚方向の層モデル・${out.chill.secs} s）: 平均 −${out.chill.dMean.toFixed(1)} K ／ 上面 −${out.chill.dTop.toFixed(1)} K ／ 下面 −${out.chill.dBot.toFixed(1)} K`
  + ` ／ 抜けた熱 ${out.chill.Q.toFixed(1)} MJ（クーラント ${out.chill.liters} L の上限 ${out.chill.Qcap.toFixed(1)} MJ${out.chill.capped ? '・液が尽きて頭打ち' : ''}）`);

ok('工程に WASH が FEED の直後・FEED2 の直前に入る', out.iW === out.iF + 1 && out.iF2 === out.iW + 1, out.seq.join('→'));
ok('洗浄の秒が洗浄機の仕様（WASHER.SEC）と一致する', Math.abs(out.secWash - out.wSec) < 1e-9, `${out.secWash} s`);
const travel = out.washStart && out.washEnd ? Math.abs(out.washEnd.x - out.washStart.x) : 0;
ok('洗っている間にスラブが板長ぶん通過する（先端が着いて始まり、尾端が抜けて終わる）',
   travel > 0.9 * out.L && travel <= 1.02 * out.L, `${travel.toFixed(0)} mm ／ 板長 ${out.L} mm`);
const mid = out.washStart && out.washEnd ? (out.washStart.x + out.washEnd.x) / 2 : NaN;
ok('通過の中心が洗浄機の位置に一致する', Math.abs(mid - out.xw) < 30, `${mid.toFixed(0)} vs ${out.xw.toFixed(0)} mm`);
ok('上ブラシは洗っている間に板の上面まで降り、それ以外は開いている',
   out.minTopYWash <= out.yClosed + 5 && out.openBefore !== null && out.openBefore >= out.yOpen - 5,
   `洗浄中の最下 ${out.minTopYWash.toFixed(0)}（閉 ${out.yClosed.toFixed(0)}）／ 送り中 ${out.openBefore?.toFixed(0)}（開 ${out.yOpen.toFixed(0)}）mm`);
ok('ブラシが回るのは洗っている間だけ', out.washEnd && out.washStart && out.washEnd.angle > out.washStart.angle && out.rotOutside === 0,
   `洗浄中に ${((out.washEnd?.angle - out.washStart?.angle) / (2 * Math.PI)).toFixed(1)} 回転 ／ 洗浄外の回転 ${out.rotOutside} コマ`);
ok('下ブラシが受取テーブルのローラと場所を取り合わない', out.rollClear > out.rollNeed,
   `ローラ軸との距離 ${out.rollClear.toFixed(0)} mm ＞ 要る距離 ${out.rollNeed.toFixed(0)} mm（ブラシ Φ${out.brushD}）`);
ok(out.coolsInput ? '持ちかかり温度から洗浄の冷えを引く（COOLS_INPUT）' : '圧延に掛かる板の温度は洗浄で変わらない（持ちかかりは洗浄後の測定とみなす）',
   out.coolsInput ? Math.abs((out.mean0 - out.meanAfter) - out.chill.dMean) < 0.5 : Math.abs(out.meanAfter - out.mean0) < 0.05,
   `装入前 ${out.mean0.toFixed(3)} ℃ → 装入後 ${out.meanAfter.toFixed(3)} ℃（差 ${(out.mean0 - out.meanAfter).toExponential(2)} K）`);
ok('（参考）洗浄でスラブが冷える量', true,
   `平均 ${out.chill.dMean.toFixed(1)} K・上面 ${out.chill.dTop.toFixed(1)} K・下面 ${out.chill.dBot.toFixed(1)} K（${out.chill.secs} s・膜沸騰）／ 熱 ${out.chill.Q.toFixed(1)} MJ ≦ ${out.chill.liters} L の上限 ${out.chill.Qcap.toFixed(1)} MJ`, true);

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}、参考 ${nRef} 件)`);
process.exit(bad.length ? 1 : 0);
