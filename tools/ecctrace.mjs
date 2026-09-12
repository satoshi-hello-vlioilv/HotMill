// 偏芯（ロール 1 回転に 1 周の板厚変動）と、その補償を測る。
//
// 偏芯には出どころが 2 つある:
//   幾何偏芯 —— 研削で決まる «現品の振れ»。止めても動いても変わらない
//   熱偏芯   —— «圧延の停止時間の抜熱ムラ»。止めているあいだ、バイトに居る角度だけが
//               熱い板と向かい合ったままになり、そこだけ温度が上がる。回し始めると
//               熱膨張のぶんだけ径が違う角度が回ってきて、1 回転に 1 周の振れになる
//
// 補償は «荷重の中のロール回転に同期した成分» を取り出して逆位相の圧下を足すもので、
// 見るべきは 3 つ:
//   ・同期検波が偏芯の振幅と位相を正しく拾えているか
//   ・圧下の «応答遅れ» を先回りしないと打ち消せないこと
//   ・ゲージメータ AGC との干渉 —— 偏芯の成分を荷重から抜かないと、AGC が
//     «荷重が増えた ＝ 厚い» と読んで締めに行き、偏芯を増やす側に回ること
//
//   node tools/ecctrace.mjs
import { openApp, installHelpers } from './harness.mjs';

let failed = 0;
const ok = (n, p, d = '', ref = false) => {
  console.log(`  ${ref ? '??  ' : p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`);
  if (!p && !ref) failed++;
};
const LOT = { cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052' };

/* ---------- 1. 熱偏芯が «止めているあいだ» に育つ -------------------------
 * (a) 仕組みそのもの —— バイトに居る角度だけを温めたときに周方向の差が育つか、
 *     回すと均されるか。運転側（PhysicsEngine._eccThermal）をそのまま呼んで見る。
 * (b) 運転の中 —— 75 mm シャーの端部切断はラインを «噛んだまま» 止めるので、
 *     実機で «停止時間に偏芯が出る» と言われるその状況そのもの。 */
console.log('--- 熱偏芯（停止時間の抜熱ムラ） ---');
{
  const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
  await installHelpers(page);
  const r = await page.evaluate(() => {
    const P = window.__app.physics, K = window.__CFG, m = P.mill, s = P.slab;
    const T = K.MILL.GAUGE_MODEL.ECC_TH;
    const dt = 1 / 120;
    const reset = () => { for (const k of ['bot', 'top']) m.eccTh[k].fill(0); m.eccThAmp = 0; };
    // (1) 止めたまま（角度が動かない）—— 1 か所だけが温まる
    reset(); s.inBite = true; m.rollAngle = 1.234;
    const stop = [];
    for (let t = 0; t < 300; t++) { for (let i = 0; i < 120; i++) P._eccThermal(dt);
      if ((t + 1) % 60 === 0) stop.push({ sec: t + 1, amp: m.eccThAmp }); }
    const stopped = m.eccThAmp;
    // (2) そのまま回す —— 全周が順番にバイトを通るので均される
    let ang = m.rollAngle;
    const heal = [];
    for (let t = 0; t < 300; t++) {
      for (let i = 0; i < 120; i++) { ang += 2 * Math.PI * 0.68 * dt; m.rollAngle = ang; P._eccThermal(dt); }
      if ((t + 1) % 60 === 0) heal.push({ sec: t + 1, amp: m.eccThAmp });
    }
    const healed = m.eccThAmp;
    // (3) 最初から回しっぱなし —— 差は付かない
    reset(); ang = 0;
    for (let i = 0; i < 120 * 300; i++) { ang += 2 * Math.PI * 0.68 * dt; m.rollAngle = ang; P._eccThermal(dt); }
    const rolling = m.eccThAmp;
    reset(); s.inBite = false;
    return { stop, stopped, heal, healed, rolling, RISE: T.RISE, TAU_IN: T.TAU_IN, TAU_OUT: T.TAU_OUT };
  });
  const µ = (v) => (v * 1000).toFixed(1);
  console.log('      止めたまま ' + r.stop.map(q => `${q.sec}s ${µ(q.amp)}`).join(' → ') + ' µm');
  console.log('      そこから回す ' + r.heal.map(q => `${q.sec}s ${µ(q.amp)}`).join(' → ') + ' µm');
  ok('回しっぱなしなら周方向に差が付かない（熱偏芯が育たない）', r.rolling < r.RISE * 0.05,
     `${µ(r.rolling)} µm ／ 十分に止めたときの半振幅 ${µ(r.RISE)} µm`);
  ok('止めているあいだに熱偏芯が育つ', r.stopped > r.RISE * 0.5,
     `300 s 止めて ${µ(r.stopped)} µm（上限 ${µ(r.RISE)} µm）`);
  ok('止めている時間が長いほど大きい（単調）',
     r.stop.every((q, i) => i === 0 || q.amp > r.stop[i - 1].amp),
     r.stop.map(q => `${q.sec}s ${µ(q.amp)}`).join(' → ') + ' µm');
  ok('回し始めると均されて消えていく', r.healed < r.stopped * 0.3,
     `止めた直後 ${µ(r.stopped)} → 300 s 回して ${µ(r.healed)} µm`);
/* 温める側（TAU_IN）と均す側（TAU_OUT）が同時に働くので、実効の時定数は
 * 1/(1/TAU_IN ＋ 1/TAU_OUT)。到達点で正規化してあるので、比は 1−exp(−t/τ_eff)。 */
  {
    const tEff = 1 / (1 / r.TAU_IN + 1 / r.TAU_OUT);
    const want = 1 - Math.exp(-60 / tEff);
    ok('育ち方が式どおり（60 s で 1−exp(−60/τ_eff)、τ_eff ＝ 1/(1/TAU_IN＋1/TAU_OUT)）',
       Math.abs(r.stop[0].amp / r.RISE - want) < 0.06,
       `60 s で ${(r.stop[0].amp / r.RISE * 100).toFixed(0)} % ／ 式では ${(want * 100).toFixed(0)} %（τ_eff ${tEff.toFixed(0)} s）`);
  }
  await browser.close();
}
{
  /* 運転の中で。75 mm シャーの端部切断はラインを «噛んだまま» 止める。 */
  const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
  await installHelpers(page);
  const r = await page.evaluate(({ LOT }) => new Promise(res => setTimeout(() => {
    const P = window.__app.physics;
    P.slab.reset({ ...LOT });
    window.__startAuto(false);
    let before = 0, peak = 0, sawCrop = false, cropSec = 0;
    window.__ff((p) => {
      const cropping = p.finish.cropStage !== 'IDLE' && p.finish.cropStage !== 'DONE';
      if (cropping) { if (!sawCrop) { sawCrop = true; before = p.mill.eccThAmp; } cropSec += 1 / 120; }
      if (sawCrop) peak = Math.max(peak, p.mill.eccThAmp);
      return p.finish.done || !!p.tripped;
    }, 120 * 1800, 0);
    res({ before, peak, sawCrop, cropSec });
  }, 400)), { LOT });
  const µ = (v) => (v * 1000).toFixed(1);
  ok('運転の中でも、クロップでラインが止まるあいだに熱偏芯が育つ',
     r.sawCrop && r.peak > r.before,
     r.sawCrop ? `クロップ ${r.cropSec.toFixed(0)} s のあいだに ${µ(r.before)} → ${µ(r.peak)} µm`
               : 'クロップが起きなかった');
  await browser.close();
}

/* ---------- 2. 補償の効き（同期検波・応答遅れ・AGC との干渉） --------------
 * «板厚がどれだけ良くなったか» で測るのは、このミルでは読めない —— ギャップには
 * ミルばねの伸び（荷重 ÷ ミル定数）が乗っていて、1 パスのあいだに mm 単位で動く。
 * 偏芯は 20 µm 級なので、その中に埋もれる（実測: 偏芯 13 µm に対しギャップの
 * 交流成分は 1.07 mm、両者の相関は 0.10 ＝ ほぼ無関係）。
 *
 * 測るべきは «補償が偏芯を捉えて逆位相を出しているか» そのもの。
 *   ① 同期検波が荷重の回転同期成分を «仕込んだ偏芯から予測される値» に当てるか
 *   ② 補償の指令が偏芯の «逆» になっているか（相関が負・振幅が同じ桁）
 *   ③ 応答遅れの先回りを外すと位相がずれて打ち消しが浅くなるか
 *   ④ 偏芯の成分を荷重から抜かないと、ゲージメータ AGC が偏芯に反応してしまうか
 */
console.log('\n--- 偏芯補償 ---');
const run = async (set, eccK = 1) => {
  const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
  await installHelpers(page);
  const out = await page.evaluate(({ LOT, set, eccK }) => new Promise(res => setTimeout(() => {
    const P = window.__app.physics, K = window.__CFG, G = K.MILL.GAUGE_MODEL;
    Object.assign(K.AGC.ECC, set);
    G.MU_SD = 0;                                  // 偏芯だけを残す（摩擦の揺らぎは切る）
    G.ECC_BR *= eccK; G.ECC_WR *= eccK;
    P.slab.reset({ ...LOT });
    window.__startAuto(false);
    let pass = -2, best = null;
    let n = 0, sEE = 0, sCC = 0, sEC = 0, sFF = 0, warm = 0, fAmp = 0;
    let gI = 0, gQ = 0, eI = 0, eQ = 0, fitAbs = 0, sFit = 0, sEFit = 0;
    const flush = () => {
      if (n > 120 * 10) {
        const r = { pass, n,
          rEC: sEC / Math.sqrt(sEE * sCC || 1),          // 偏芯 と 補償指令 の相関（負なら逆位相）
          rEFit: sEFit / Math.sqrt(sEE * sFit || 1),      // 偏芯 と «荷重から抜く成分» の相関
          gAmp: 2 * Math.hypot(gI / n, gQ / n),           // ゲージメータの伸びの «回転同期» 振幅
          eAmp: 2 * Math.hypot(eI / n, eQ / n),           // 偏芯そのものの «回転同期» 振幅
          sdE: Math.sqrt(sEE / n), sdC: Math.sqrt(sCC / n), fitAbs: fitAbs / n,
          sdF: Math.sqrt(sFF / n), fAmp: fAmp / n };
        if (!best || r.n > best.n) best = r;
      }
      n = 0; sEE = 0; sCC = 0; sEC = 0; sFF = 0; warm = 0; fAmp = 0;
      gI = 0; gQ = 0; eI = 0; eQ = 0; fitAbs = 0; sFit = 0; sEFit = 0;
    };
    window.__ff((p) => {
      const m = p.mill, s = p.slab;
      if (m.passIndex !== pass) { flush(); pass = m.passIndex; }
      const cropping = p.finish.cropStage !== 'IDLE' && p.finish.cropStage !== 'DONE';
      if (s.inBite && Math.abs(m.currentSpeed) > 10 && !cropping && !m.agcLock && !K.SCHEDULE[m.passIndex]?.coil) {
        if (warm++ > 120 * 20) {                   // 同期検波が落ち着くまで待つ
          const e = m.ecc, c = m.eccCmd, g = m.spring, a = m.rollAngle;
          n++; sEE += e * e; sCC += c * c; sEC += e * c;
          /* ゲージメータが見込む伸び（spring ＝ 荷重 ÷ ミル定数）の «ロール回転に同期した»
           * 成分。広帯域の σ では荷重の変化そのもの（1 パスで mm 単位）に埋もれるので、
           * 回転に同期した成分だけを同期検波で取り出す。 */
          gI += g * Math.sin(a); gQ += g * Math.cos(a);
          eI += e * Math.sin(a); eQ += e * Math.cos(a);
          sFF += (m.forceMeas - m.eccFbar) ** 2; fAmp += m.eccCh[0].amp + m.eccCh[1].amp;
          fitAbs += Math.abs(m.eccFit); sFit += m.eccFit * m.eccFit; sEFit += e * m.eccFit;
        }
      }
      return p.finish.done || !!p.tripped;
    }, 120 * 1800, 0);
    flush();
    res(best || { rEC: 0, rEFit: 0, gAmp: 0, eAmp: 0, sdE: 0, sdC: 0, fitAbs: 0, sdF: 0, fAmp: 0, pass: -1, n: 0 });
  }, 400)), { LOT, set, eccK });
  await browser.close();
  return out;
};

const µm = (v) => (v * 1000).toFixed(1);
/* 既定は «切» なので、効きを見る run では明示的に入れる。 */
const full    = await run({ ON: true,  LEAD: true,  NOTCH: false });
const off     = await run({ ON: false, LEAD: true,  NOTCH: false });
const noLead  = await run({ ON: true,  LEAD: false, NOTCH: false });
const big     = await run({ ON: true,  LEAD: true,  NOTCH: false }, 4);
const offBig  = await run({ ON: false, LEAD: true,  NOTCH: false }, 4);

console.log(`      第 ${full.pass + 1} パス（${(full.n / 120).toFixed(0)} s）で比較`);
console.log(`      偏芯 σ ${µm(full.sdE)} µm ／ 補償の指令 σ ${µm(full.sdC)} µm ／ 相関 ${full.rEC.toFixed(2)}`);

/* ここから先は «整定» の話。合否に数えられるのは «仕組みが繋がっているか» までで、
 * «効くか» はまだ数えられない —— 噛んでいるあいだの荷重にはスタンドの鳴き（15 Hz）と
 * AGC 自身の動きが乗っていて、ロール回転（0.3〜1 Hz）の成分の SN 比が足りない。
 * 実測: 偏芯を 4 倍にしても推定は 20.9 → 22.8 t（＝ 大半が雑音）。
 * 数値だけを毎回出して、整定が進んだかどうかが分かるようにしておく（README 0-4）。 */
ok('補償を切れば指令は出ない', off.sdC < 1e-6, `補償なしの指令 σ ${µm(off.sdC)} µm`);
ok('補償を入れれば指令が出る（仕組みが繋がっている）', full.sdC > 1e-3,
   `指令 σ ${µm(full.sdC)} µm（偏芯 σ ${µm(full.sdE)} µm の ${(full.sdC / full.sdE * 100).toFixed(0)} %）`);
ok('（参考）同期検波の SN —— 偏芯を 4 倍にしたとき推定がどれだけ増えるか', true,
   `補償なしで 偏芯 ×1 ${off.fAmp.toFixed(1)} t ／ ×4 ${offBig.fAmp.toFixed(1)} t`
 + `（雑音床が大きいほど比が 1 に近づく）`, true);
ok('（参考）指令と偏芯の相関（−1 に近いほど深く打ち消せている）', true,
   `相関 ${full.rEC.toFixed(2)} ／ 指令が偏芯の ${(full.sdC / full.sdE * 100).toFixed(0)} %`, true);
ok('（参考）応答遅れの先回りの効き', true,
   `先回りあり ${full.rEC.toFixed(3)} ／ なし ${noLead.rEC.toFixed(3)}`, true);
ok('（参考）荷重に残る同期成分', true,
   `補償なし ${off.fAmp.toFixed(1)} → あり ${full.fAmp.toFixed(1)} t`, true);
ok('（参考）偏芯を 4 倍にしたときの指令', true, `×1 ${µm(full.sdC)} → ×4 ${µm(big.sdC)} µm`, true);

console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
