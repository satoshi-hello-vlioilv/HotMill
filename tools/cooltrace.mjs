// 冷却モデル（上面のプール／下面の直撃スプレー／沸騰曲線）を検査する評価器。
//
// «冷えているかどうか» は温度を見れば分かるが、«正しい理屈で冷えているか» は分からない。
// ここで見るのは 3 つ。
//   ① 上面と下面が «別の仕組み» になっていること —— 上面は溜まった液（プール）の温度で
//      沸騰が決まり、下面は常に新液。同じ板面温度でも熱伝達率が違うはず。
//   ② プールの入れ替わり（流束）が効くこと —— 流束を増やすとプールが冷え、抜熱が増える。
//      «流量を増やすと効く» という実機の感覚が式の中にあるか。
//   ③ 沸騰曲線が液の状態で動くこと —— 濃度を上げる／劣化させると抜熱が落ち、
//      ライデンフロスト点が下がる。そしてそれが板の温度に効くこと。
// あわせて下面スプレーの現物（ヘッダ・ノズル）が納まっているかも測る。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, S = K.SCALE, T = window.__T;
  const R = { checks: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: String(d) });
  const CO = K.MATERIAL.COOLANT, PE = P.constructor;

  /* ---------- ① 上面（プール）と下面（新液）は別の仕組み ---------------------- */
  const Ts = 430;
  const ct = PE.surfaceCool(Ts, true), cb = PE.surfaceCool(Ts, false);
  R.face = { pool: +ct.pool.toFixed(1), hTop: +ct.h.toFixed(0), Ttop: +ct.T.toFixed(1),
             hBot: +cb.h.toFixed(0), Tbot: +cb.T.toFixed(1) };
  ok('上面のプールが液温より温まっている（板から熱をもらう）', ct.pool > CO.T_BULK + 1,
     `プール ${ct.pool.toFixed(1)} ℃ / 液温 ${CO.T_BULK} ℃`);
  ok('プールは飽和温度を超えない（それ以上は蒸発に使われる）', ct.pool <= CO.T_SAT + 1e-6,
     `${ct.pool.toFixed(1)} ℃ ≦ ${CO.T_SAT} ℃`);
  ok('下面に当たるのは常に新液（プールを作らない）', cb.pool === CO.T_BULK,
     `${cb.pool.toFixed(1)} ℃`);
  ok('同じ板面温度でも上面と下面で熱伝達率が違う', Math.abs(ct.h - cb.h) > 20,
     `上面 ${ct.h.toFixed(0)} / 下面 ${cb.h.toFixed(0)} W/m²K`);
  /* «噴流» は下面スプレーだけのもの。ロールから流れ落ちるぶん（流下）に掛けてはいけない。 */
  const cbDrain = PE.surfaceCool(Ts, false, false);
  ok('噴流の効き（JET）は流下には掛からない', Math.abs(cbDrain.h * CO.SPRAY.BOT.JET - cb.h) < 1,
     `噴流 ${cb.h.toFixed(0)} / 流下 ${cbDrain.h.toFixed(0)} W/m²K`);

  /* ---------- ② 新液の入れ替わり（流束）が効く -------------------------------- */
  const keepF = CO.SPRAY.TOP.FLUX;
  const at = (f) => { CO.SPRAY.TOP.FLUX = f; const c = PE.surfaceCool(Ts, true);
                      return { f, pool: +c.pool.toFixed(1), q: +(c.h * (Ts - c.T)).toFixed(0) }; };
  const flux = [0.4, 1.2, 4, 20].map(at);
  CO.SPRAY.TOP.FLUX = keepF;
  R.flux = flux;
  ok('流束を増やすとプールが冷える', flux.every((v, i) => i === 0 || v.pool <= flux[i - 1].pool + 1e-6),
     flux.map(v => `${v.f}→${v.pool}℃`).join(' '));
  ok('プールが冷えると抜熱が増える（＝上面の水量を増やすと効く）',
     flux[flux.length - 1].q > flux[0].q * 1.15,
     flux.map(v => `${v.f}→${(v.q / 1000).toFixed(0)}kW/m²`).join(' '));

  /* ---------- ③ 沸騰曲線が液の状態で動く -------------------------------------- */
  const keep = { c: CO.CONC, a: CO.AGE };
  const curve = (conc, age) => { CO.CONC = conc; CO.AGE = age; const cv = PE.coolantCurve();
    return { conc, age, hNB: +cv.hNB.toFixed(0), hFilm: +cv.hFilm.toFixed(0), leid: +cv.tLeid.toFixed(0) }; };
  const cv0 = curve(CO.CURVE.CONC_REF, CO.CURVE.AGE_REF);
  const cvHi = curve(8, CO.CURVE.AGE_REF), cvOld = curve(CO.CURVE.CONC_REF, 1);
  CO.CONC = keep.c; CO.AGE = keep.a;
  R.curve = { ref: cv0, conc8: cvHi, aged: cvOld };
  ok('基準の濃度・劣化度では曲線が設定値そのもの',
     Math.abs(cv0.hNB - CO.H_NB) < 1 && Math.abs(cv0.hFilm - CO.H_FILM) < 1 && Math.abs(cv0.leid - CO.T_LEID) < 1,
     `hNB ${cv0.hNB} / hFilm ${cv0.hFilm} / ライデン ${cv0.leid} ℃`);
  ok('濃度を上げると抜熱が落ち、ライデンフロスト点も下がる',
     cvHi.hNB < cv0.hNB && cvHi.hFilm < cv0.hFilm && cvHi.leid < cv0.leid,
     `4.8 → 8 %: hNB ${cv0.hNB}→${cvHi.hNB} / ライデン ${cv0.leid}→${cvHi.leid} ℃`);
  ok('劣化が進むと抜熱が落ち、ライデンフロスト点も下がる',
     cvOld.hNB < cv0.hNB && cvOld.hFilm < cv0.hFilm && cvOld.leid < cv0.leid,
     `劣化 ${CO.CURVE.AGE_REF} → 1: hNB ${cv0.hNB}→${cvOld.hNB} / ライデン ${cv0.leid}→${cvOld.leid} ℃`);
  ok('劣化は膜沸騰域にも効く（堆積物が熱抵抗になる）', cvOld.hFilm < cv0.hFilm * 0.97,
     `hFilm ${cv0.hFilm} → ${cvOld.hFilm}`);
  ok('ライデンフロスト点は核沸騰の上限より下へは行かない（曲線が反転しない）',
     curve(10, 1).leid > CO.T_NB, `最悪でも ${curve(10, 1).leid} ℃ > ${CO.T_NB} ℃`);
  CO.CONC = keep.c; CO.AGE = keep.a;

  /* ---------- ④ 下面スプレーの現物 -------------------------------------------- */
  W.scene.updateMatrixWorld(true);
  const box = (o) => { const b = new T.Box3().setFromObject(o);
    return { x: [b.min.x / S, b.max.x / S], y: [b.min.y / S, b.max.y / S], z: [b.min.z / S, b.max.z / S] }; };
  const gv = W.guideView, B = K.TABLE.GUIDE.HEADER.BOT, PL = K.MILL.PASS_LINE;
  ok('下面スプレーのヘッダが置かれている', !!gv.botHeaders && gv.botHeaders.mesh.count > 0,
     `${gv.botHeaders?.mesh.count ?? 0} 本`);
  const bh = box(gv.botHeaders.mesh), bn = box(gv.botNozzles.mesh);
  ok('ヘッダが板の下（パスラインより下）にある', bh.y[1] < PL, `天端 ${bh.y[1].toFixed(0)} / パスライン ${PL}`);
  ok('ノズルの先がテーブルローラの最下点より下（ローラに当たらない）',
     bn.y[1] < PL - K.TABLE.ROLL_D_END / 2,
     `ノズル天端 ${bn.y[1].toFixed(0)} / ローラ最下点 ${(PL - K.TABLE.ROLL_D_END / 2).toFixed(0)}`);
  ok('ヘッダが軸受台の帯（|z| 1,325〜1,765）の内側にある', Math.abs(bh.z[1]) < 1325,
     `|z| 最大 ${Math.max(Math.abs(bh.z[0]), Math.abs(bh.z[1])).toFixed(0)}`);
  // 狙いは板幅のクォーター部（上面と同じ約束）
  const w = P.slab.width, ba = window.__LAYOUT.botAim(w);
  ok('下面スプレーが板幅のクォーター部を狙う', Math.abs(ba.aim - w * B.AIM_FRAC) < 1,
     `狙い ±${ba.aim.toFixed(0)} mm（板幅 ${w} の ${(B.AIM_FRAC * 100).toFixed(0)} %）`);
  ok('狙いが板の中（エッジより内側）にある', ba.aim < w / 2, `±${ba.aim.toFixed(0)} / エッジ ±${(w / 2).toFixed(0)}`);

  /* ---------- ⑤ 面のスイッチが板の «上下差» に効く -----------------------------
   * 冷却は 4 系統（入側上面 ET / 出側上面 XT / 入側下面 EB / 出側下面 XB）で、
   * ON/OFF はその 1 か所にしかない。TOP / BOT / ENTRY / EXIT は «4 系統から導いた
   * 読み取り専用» なので、そこへ代入しても何も起きない（以前ここで代入していて、
   * 切ったつもりのまま両面の値を比べ、いつも同じ数字を見ていた）。 */
  const Z = K.MATERIAL.STRIP_COOL.ZONES, keepS = { eb: Z.EB.on, xb: Z.XB.on };
  const hOf = (top) => PE.stripFilm(430, top).h;
  Z.EB.on = false; Z.XB.on = false;
  const only = { top: hOf(true), bot: hOf(false) };
  Z.EB.on = true; Z.XB.on = true;
  const both = { top: hOf(true), bot: hOf(false) };
  Z.EB.on = keepS.eb; Z.XB.on = keepS.xb;
  R.faceSw = { only, both };
  ok('下面を切ると下面の板面冷却が止まる', only.bot === 0 && both.bot > 0,
     `上面のみ ${only.bot} / 両面 ${both.bot.toFixed(0)} W/m²K`);
  ok('上面の効きは下面のスイッチに影響されない', Math.abs(only.top - both.top) < 1,
     `${only.top.toFixed(0)} / ${both.top.toFixed(0)} W/m²K`);

  /* ---------- ⑥ ピット炉の上下温度差が待ち時間で均される ---------------------- */
  const keepH = K.SUPPLY.HOLD_MIN;
  const dTat = (hold) => { K.SUPPLY.HOLD_MIN = hold;
    const t = window.__app.physics.slab.constructor.pitProfile(433, 530, K.ALLOYS.A5052);
    return +(t[t.length - 1] - t[0]).toFixed(1); };
  const hold = [0, 5, 10, 20, 30].map(h => ({ h, dT: dTat(h) }));
  K.SUPPLY.HOLD_MIN = keepH;
  R.soak = { extract: K.FURNACE.SOAK_DT, hold };
  ok(`抽出直後の上下差が炉の値（${K.FURNACE.SOAK_DT} K）`, Math.abs(hold[0].dT - K.FURNACE.SOAK_DT) < 0.5, hold[0].dT);
  ok('待ち時間が長いほど上下差が均される（単調に減る）',
     hold.every((v, i) => i === 0 || v.dT < hold[i - 1].dT), hold.map(v => `${v.h}分→${v.dT}K`).join(' '));
  ok('平均温度は «持ちかかりの測定値» に合わせ直される（待ちで下がるぶんは測定値に入っている）',
     (() => { const t = P.slab.T; let s = 0;
       for (let j = 0; j < t.length; j++) s += (j === 0 || j === t.length - 1) ? t[j] / 2 : t[j];
       return Math.abs(s / (t.length - 1) - P.slab.initialTemp) < 0.5; })(),
     `平均 ${P.slab.temperature.toFixed(1)} / 入力 ${P.slab.initialTemp} ℃`);
  ok('炉出しは下が熱い（ピット炉は下から加熱する）', P.slab.T[P.slab.T.length - 1] > P.slab.T[0],
     `上 ${P.slab.T[0].toFixed(1)} / 下 ${P.slab.T[P.slab.T.length - 1].toFixed(1)} ℃`);
  return R;
});

console.log(JSON.stringify({ face: out.face, flux: out.flux, curve: out.curve, soak: out.soak }, null, 1));
for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name} — ${c.detail}`);
const bad = out.checks.filter(c => !c.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${out.checks.length - bad.length}/${out.checks.length})`);
await browser.close();
process.exit(bad.length ? 1 : 0);
