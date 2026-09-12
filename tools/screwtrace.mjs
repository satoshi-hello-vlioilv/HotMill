// 圧下装置（電動圧下・油圧圧下）が実機の仕様どおりに動くかを測る。
//
// 実機仕様（2026-09 提供）:
//   電動圧下装置（2 速切換式）
//     モータ   高速 1 台 110/220 kW D.C. ／ 低速 2 台 52 kW D.C.
//     回転数   高速 0/500/1000/1250 rpm ／ 低速 0/550 rpm
//     減速比   高速 27.5 : 1 ／ 低速 440 : 1
//     圧下速度 高速 0/8.5/17/21.2 mm/s ／ 低速 0/583 µm/s
//     手動レバー 同時圧下 1 ノッチ 0.1 mm/s ／ 2 ノッチ 1 mm/s
//     レベリング 0.1 mm/s・side（O.S. 閉で D.S. 開のシーソーなので差では 0.2 mm/s）
//   油圧圧下
//     シリンダ径 1,060 mm ／ 圧力 210 kgf/cm²（吐出 250・背圧 40）
//     ストローク max 60 mm（有効 52 mm）
//     速度 約 3 mm/s（荷重 1,500 t 時）
//     周波数応答 5 Hz（±50 µm）（1,500 t・CPC モード・90° 位相遅れ）
//     圧延機 max 荷重 3,920 t（圧下スクリューナット収納部）
//     1st リミット 3,900 t → 荷重一定制御
//     2nd リミット 4,200 t → 油圧シリンダ急速開・ミル急停止（テンション、MUV は維持）
//
//   node tools/screwtrace.mjs
import { openApp, installHelpers } from './harness.mjs';

let failed = 0;
const ok = (n, p, d = '', ref = false) => {
  console.log(`  ${ref ? '??  ' : p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`);
  if (!p && !ref) failed++;
};

const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
await installHelpers(page);

/* ---------- 1. 仕様そのものと検算 ---------------------------------------- */
const spec = await page.evaluate(() => {
  const C = window.__CFG.MILL, H = C.HYD, S = C.SCREW;
  return { capT: H.CAP_T, rated: C.RATED_FORCE_T, lim1: C.LIMIT1_FORCE_T, lim2: C.LIMIT_FORCE_T,
           cyl: H.CYL_D, pw: H.P_WORK, n: H.N_CYL, stroke: H.STROKE, strokeEff: H.STROKE_EFF,
           speed: H.SPEED, hz: H.BAND_HZ, amp: H.BAND_AMP, zeta: H.ZETA,
           fast: S.FAST_MMS, slow: S.SLOW_MMS, lever: S.LEVER_MMS, level: S.LEVEL_MMS,
           fastRpm: S.FAST_RPM, fastGear: S.FAST_GEAR, slowRpm: S.SLOW_RPM, slowGear: S.SLOW_GEAR,
           gapRateOld: C.GAP_RATE };
});
console.log('--- 仕様 ---');
ok('油圧シリンダの推力が圧延機の max 荷重と同じ桁（受圧面積 × 圧力 × 2 本）',
   spec.capT > spec.rated * 0.85 && spec.capT < spec.rated * 1.15,
   `Φ${spec.cyl} × ${spec.pw} kgf/cm² × ${spec.n} 本 ＝ ${spec.capT.toFixed(0)} t ／ max 荷重 ${spec.rated.toLocaleString()} t`);
ok('荷重の限度が 3 段（常用最大 ＜ 2nd リミット、1st ＜ 2nd）',
   spec.lim1 < spec.lim2 && spec.rated <= spec.lim2 && spec.lim1 === 3900 && spec.lim2 === 4200,
   `常用最大 ${spec.rated.toLocaleString()} ／ 1st ${spec.lim1.toLocaleString()} ／ 2nd ${spec.lim2.toLocaleString()} t`);
ok('有効ストロークが max ストロークの内側', spec.strokeEff < spec.stroke,
   `有効 ${spec.strokeEff} / max ${spec.stroke} mm`);
/* ±50 µm を 5 Hz で振るのに要る最大速度は 2π·f·A。シリンダ速度の枠に収まっていなければ
 * «5 Hz で ±50 µm» という仕様そのものが出せないことになる。 */
const vNeed = 2 * Math.PI * spec.hz * spec.amp;
ok('±50 µm を 5 Hz で振るのに要る速度がシリンダ速度の枠に収まる', vNeed < spec.speed,
   `要 ${vNeed.toFixed(2)} mm/s ／ 枠 ${spec.speed} mm/s`);
ok('電動圧下の速度段が仕様どおり（高速 0/8.5/17/21.2・低速 0/583 µm）',
   JSON.stringify(spec.fast) === JSON.stringify([0, 8.5, 17, 21.2]) &&
   JSON.stringify(spec.slow) === JSON.stringify([0, 0.583]),
   `高速 ${spec.fast.join('/')} mm/s ／ 低速 ${spec.slow.map(v => v * 1000).join('/')} µm/s`);
ok('手動レバーとレベリングの速度が仕様どおり',
   JSON.stringify(spec.lever) === JSON.stringify([0.1, 1.0]) && spec.level === 0.1,
   `レバー ${spec.lever.join(' / ')} mm/s ／ レベリング ${spec.level} mm/s・side（差では ${spec.level * 2} mm/s）`);

/* ---------- 2. 油圧の周波数応答 ------------------------------------------ */
/* 5 Hz の正弦を指令して、出てくる位置の «振幅» と «位相» を測る。仕様の読み方は
 * «5 Hz のとき位相が 90° 遅れ、そのとき ±50 µm 出る»。2 次系なら位相が
 * ちょうど −90° になるのが ω ＝ ωn なので、そこが一致するはず。 */
console.log('\n--- 油圧圧下の周波数応答（噛んでいるあいだ） ---');
const fr = await page.evaluate(({ hz, amp }) => {
  const m = window.__app.physics.mill, dt = 1 / 2000;      // 応答そのものを見るので細かく刻む
  const run = (f) => {
    m.screw = 10; m.screwV = 0;
    const w = 2 * Math.PI * f, T = 1 / f, n = Math.round(6 * T / dt);
    let t = 0, sMax = -1e9, sMin = 1e9, tPeak = 0;
    for (let i = 0; i < n; i++) {
      m.stepScrew(10 + amp * Math.sin(w * t), dt, true, 0, 600);
      t += dt;
      if (t > 4 * T) {                                      // 過渡が消えた最後の 2 周期で測る
        if (m.screw > sMax) { sMax = m.screw; tPeak = t; }
        if (m.screw < sMin) sMin = m.screw;
      }
    }
    /* 指令の山は sin(wt) ＝ 1 ＝ t が T/4 ＋ kT のとき。出力の山との時間差が位相遅れ。 */
    const tCmdPeak = Math.ceil((tPeak - T / 4) / T) * T + T / 4;
    const lagT = ((tCmdPeak - tPeak) % T + T) % T;
    return { amp: (sMax - sMin) / 2, lagDeg: (T - lagT) % T / T * 360 };
  };
  return { at: run(hz), half: run(hz / 2), twice: run(hz * 2) };
}, { hz: spec.hz, amp: spec.amp });
ok(`${spec.hz} Hz で位相がちょうど 90° 遅れる（仕様の読み方どおり）`,
   Math.abs(fr.at.lagDeg - 90) < 8, `${fr.at.lagDeg.toFixed(1)}°`);
/* 仕様は «5 Hz で ±50 µm・90° 位相遅れ»。2 次系では ωn での振幅が 1/(2ζ) 倍なので、
 * 振幅が落ちていないこと（≒ 1 倍）と位相 90° の両方が成り立つのは ζ ＝ 0.5 のときだけ。
 * どちらか片方だけを見ていると減衰比を取り違える（臨界減衰では ±25 µm しか出ない）。 */
ok(`${spec.hz} Hz で ±${(spec.amp * 1000).toFixed(0)} µm の指令どおりの振幅が出る`,
   fr.at.amp > spec.amp * 0.9 && fr.at.amp < spec.amp * 1.1,
   `振幅 ±${(fr.at.amp * 1000).toFixed(1)} µm ／ 指令 ±${(spec.amp * 1000).toFixed(0)} µm（減衰比 ${spec.zeta}）`);
ok('周波数を上げるほど遅れが増え、振幅が落ちる（低域通過）',
   fr.half.lagDeg < fr.at.lagDeg && fr.at.lagDeg < fr.twice.lagDeg && fr.half.amp > fr.at.amp && fr.at.amp > fr.twice.amp,
   `${(spec.hz / 2).toFixed(1)} Hz ${fr.half.lagDeg.toFixed(0)}°/${(fr.half.amp * 1000).toFixed(1)} µm ／ `
 + `${spec.hz} Hz ${fr.at.lagDeg.toFixed(0)}°/${(fr.at.amp * 1000).toFixed(1)} µm ／ `
 + `${spec.hz * 2} Hz ${fr.twice.lagDeg.toFixed(0)}°/${(fr.twice.amp * 1000).toFixed(1)} µm`);

/* ---------- 3. 速度の枠（油圧 3 mm/s ／ 電動 21.2 mm/s） ------------------ */
console.log('\n--- 圧下の速度 ---');
const sp = await page.evaluate(() => {
  const m = window.__app.physics.mill, dt = 1 / 120;
  const run = (inBite, step) => {
    m.screw = 50; m.screwV = 0;
    let vMax = 0;
    for (let i = 0; i < 240; i++) {
      const s0 = m.screw;
      m.stepScrew(50 - step, dt, inBite, 0, 600);
      vMax = Math.max(vMax, Math.abs(m.screw - s0) / dt);
    }
    return { vMax, moved: 50 - m.screw };
  };
  return { hyd: run(true, 20), scr: run(false, 20) };
});
ok('噛んでいるあいだの圧下速度が油圧の枠（3 mm/s）を超えない',
   sp.hyd.vMax <= spec.speed * 1.02, `最大 ${sp.hyd.vMax.toFixed(2)} mm/s ／ 枠 ${spec.speed} mm/s`);
ok('噛んでいないあいだは電動の高速段（21.2 mm/s）まで出る',
   sp.scr.vMax > spec.speed * 2 && sp.scr.vMax <= spec.fast[spec.fast.length - 1] * 1.02,
   `最大 ${sp.scr.vMax.toFixed(1)} mm/s ／ 高速段 ${spec.fast[spec.fast.length - 1]} mm/s`);
ok('位置決めは電動のほうが速い（同じ 2 秒で進む量）',
   sp.scr.moved > sp.hyd.moved * 3, `電動 ${sp.scr.moved.toFixed(1)} mm ／ 油圧 ${sp.hyd.moved.toFixed(1)} mm`);

/* ---------- 4. 1st / 2nd リミット ----------------------------------------
 * 実機の 3,900 / 4,200 t は既定のロットでは届かない（最大 3,600 t 前後）。届かないまま
 * «合格» にすると機構が動かないので、この評価器の中だけリミットを下げて必ず働かせる
 * （動きを見るのが目的で、実機の値そのものは «仕様» の節で別に見ている）。 */
console.log('\n--- 荷重の 2 段リミット（評価器の中だけリミットを下げて働かせる） ---');
const limRun = (lim1, lim2) => page.evaluate(({ lim1, lim2 }) => new Promise(res => setTimeout(() => {
  const P = window.__app.physics, K = window.__CFG, C = K.MILL;
  C.LIMIT1_FORCE_T = lim1; C.LIMIT_FORCE_T = lim2;
  P.slab.reset({ cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052' });
  window.__startAuto(false);
  let sawHold = false, fAtHold = 0, fMax = 0, gapAtTrip = 0;
  let holdN = 0, screwAtHold = 0, screwOpen = 0, fSum = 0, fN = 0;
  window.__ff((p) => {
    const m = p.mill;
    fMax = Math.max(fMax, m.forceMeas);
    if (m.forceHold) {
      if (!sawHold) { sawHold = true; fAtHold = m.forceMeas; screwAtHold = m.screw; }
      holdN++;
      screwOpen = Math.max(screwOpen, m.screw - screwAtHold);
    }
    if (m.forceMeas > 1) { fSum += m.forceMeas; fN++; }        // 噛んでいるあいだの平均荷重
    if (p.tripped && !gapAtTrip) gapAtTrip = m.gap;
    return !!p.tripped || p.finish.done;
  }, 120 * 900, 0);
  res({ sawHold, fAtHold, fMax, holdSec: holdN / 120, screwOpen, fAvg: fN ? fSum / fN : 0,
        tripped: !!P.tripped, gapAtTrip, gapMax: C.GAP_MAX });
}, 400)), { lim1, lim2 });

/* «制御が効いているか» は、同じロットを «リミット無し» で流したものと比べて見る。
 * 人工的に下げたリミットに荷重が張り付くことを求めると、噛み込みの衝撃（ミルばねの
 * 行き過ぎ）まで採点することになり、制御の良し悪しが読めない。 */
const hold = await limRun(1200, 9999);          // 1st だけ働かせる
const free = await limRun(9999, 9999);          // 比較用（リミット無し）
ok('1st リミットを超えると荷重一定制御に入る', hold.sawHold,
   hold.sawHold ? `入った（そのときの荷重 ${hold.fAtHold.toFixed(0)} t ／ 1st 1,200 t・通算 ${hold.holdSec.toFixed(1)} s）`
                : `入らなかった（最大 ${hold.fMax.toFixed(0)} t）`);
ok('荷重一定制御に入ると圧下が開く', hold.sawHold && hold.screwOpen > 0.5,
   `開いた量 ${hold.screwOpen.toFixed(2)} mm`);
ok('平均荷重もリミット無しより下がる（一部のパスだけの話ではない）',
   hold.fAvg < free.fAvg * 0.97,
   `荷重一定制御あり ${hold.fAvg.toFixed(0)} t ／ なし ${free.fAvg.toFixed(0)} t`
 + `（${((hold.fAvg / free.fAvg - 1) * 100).toFixed(0)} %）`);
ok('リミット無しで流すより最大荷重が下がる', hold.fMax < free.fMax * 0.95,
   `荷重一定制御あり ${hold.fMax.toFixed(0)} t ／ なし ${free.fMax.toFixed(0)} t`
 + `（${((hold.fMax / free.fMax - 1) * 100).toFixed(0)} %）`);
ok('1st リミットだけでは止まらない（板厚は外れても圧延は続く）', !hold.tripped,
   hold.tripped ? '止まった' : `完走（最大 ${hold.fMax.toFixed(0)} t）`);

const trip = await limRun(9999, 1200);          // 2nd だけ働かせる（1st は無効）
ok('2nd リミットまで行ったら止まる', trip.tripped,
   trip.tripped ? `停止（そのときの荷重 ${trip.fMax.toFixed(0)} t ／ 2nd 1,200 t）` : `止まらなかった（最大 ${trip.fMax.toFixed(0)} t）`);
ok('2nd リミットでは油圧シリンダが急速開になる（挟んだまま止めない）',
   trip.tripped && trip.gapAtTrip >= trip.gapMax - 1,
   `停止時のギャップ ${trip.gapAtTrip.toFixed(0)} mm ／ 全開 ${trip.gapMax} mm`);

await browser.close();
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
