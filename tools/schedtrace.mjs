// パススケジュール生成（Rolling.buildSchedule / passTempChange / scheduleFeasibility）が
// «素材の全パラメータ空間» で物理的に成立するかを確かめる評価器。
//
// なぜ要るか: これまでの評価器は «既定ロット 1 本» を通すだけで、スケジュール生成そのものを
// パラメータ空間で問う検査がどこにも無かった。実際、既定ロットを変えた際に
// «パス時間が長いと予測温度が発散して荷重が 6 万 t になる» 欠陥が表面化した。
// 集中定数の抜熱項が passTime に «線形» で入っていたため、長いパスでは受け手温度を
// 通り越して下がり続けたのが原因。ここでは次を全格子で確かめる:
//   ・予測温度が «いちばん冷たい受け手» を下回らない（熱力学第二法則）
//   ・予測荷重が有限で、非常最大の数倍という非物理な値にならない
//   ・熱間域を下回っても «警告» であって «成立しない» にはならない（運転はできる）
//   ・冷却方式（水冷 > 空冷 > なし）で終端温度が単調に並ぶ
import { openApp, installHelpers } from './harness.mjs';

const TARGET = process.argv[2] || undefined;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const K = window.__CFG, R = window.__ROLL;
  const Res = { checks: [], worst: {}, grid: 0 };
  const ok = (n, p, d = '') => Res.checks.push({ name: n, pass: !!p, detail: d });
  const M = K.MATERIAL;
  // 熱の受け手のうち最も冷たいもの。材料はこれより冷たくはなれない
  const sinkMin = Math.min(M.T_AMBIENT, M.T_ROLL, M.TABLE_TOUCH.T, M.COOLANT.T_BULK);

  const alloys = Object.keys(K.ALLOYS);
  const casts = K.SLAB.CAST_TH;
  const widths = [K.SLAB.WID_MIN, 1500, K.SLAB.WID_MAX];
  const lens = [K.SLAB.LEN_MIN, K.SLAB.LEN_MAX];
  const targets = [4, 8, 20, 60];

  // 噛み込み角の上限から決まる 1 パスの最大圧下量。どのパスもこれを超えられない
  const dBite = K.MILL.WR_D * (1 - Math.cos(K.PROCESS.BITE_ANGLE_MAX));

  let minT = Infinity, minAt = null, maxF = 0, maxAt = null, nonFinite = 0, blocked = [];
  let overBite = [], overLimit = [], hotRise = 0, hotAt = null;
  for (const a of alloys) for (const c of casts) for (const w of widths) for (const L of lens) for (const t of targets) {
    const h0 = c - 2 * K.SLAB.SCALP_DEFAULT;
    const temp = Math.min(K.ALLOYS[a].T_ROLL[1], 500);
    const coil = t <= K.SLAB.FINISH.COIL_MAX_TH;
    const sch = R.buildSchedule(h0, t, w, temp, { coil, length: L, alloy: a });
    Res.grid++;
    let hIn = h0;
    for (const q of sch) {
      if (!Number.isFinite(q.force) || !Number.isFinite(q.tEnd)) nonFinite++;
      if (q.tEnd < minT) { minT = q.tEnd; minAt = { a, c, w, L, t, pass: q.pass }; }
      if (q.force > maxF) { maxF = q.force; maxAt = { a, c, w, L, t, pass: q.pass, tEnd: q.tEnd }; }
      if (q.tEnd - temp > hotRise) { hotRise = q.tEnd - temp; hotAt = { a, c, w, L, t, pass: q.pass, tEnd: q.tEnd }; }
      const d = hIn - q.gap;
      if (d > dBite + 0.5) overBite.push({ a, c, w, L, t, pass: q.pass, d: +d.toFixed(1) });
      hIn = q.gap;
    }
    const fe = R.scheduleFeasibility(sch, K.ALLOYS[a], coil);
    // 熱間域割れだけを理由に «成立しない» としていないか
    if (!fe.ok && fe.reasons.every(r => /温度/.test(r))) blocked.push({ a, c, w, L, t, reasons: fe.reasons });
    // «成立する» と言った以上、全パスが非常最大の内側でなければならない
    if (fe.ok) for (const q of sch) if (q.force > K.MILL.LIMIT_FORCE_T)
      overLimit.push({ a, c, w, L, t, pass: q.pass, f: q.force });
  }
  Res.worst = { minT, minAt, maxF, maxAt, nonFinite, blocked: blocked.length,
                overBite: overBite.length, overLimit: overLimit.length, hotRise, hotAt };
  ok('全パスが噛み込み角の上限を守る（残りを 1 パスへ押し込まない）', overBite.length === 0,
     `超過 ${overBite.length} 件 / 上限 ${dBite.toFixed(1)} mm` + (overBite[0] ? ` 例: ${overBite[0].a} ${overBite[0].c}t →${overBite[0].t} P${overBite[0].pass} ${overBite[0].d} mm` : ''));
  ok('加工発熱で炉出し温度を 100 K 以上超えない', hotRise < 100,
     `最大上昇 ${Math.round(hotRise)} K` + (hotAt ? ` @ ${hotAt.a} ${hotAt.c}t ${hotAt.w}w ${hotAt.L}L →${hotAt.t} P${hotAt.pass}` : ''));
  ok('«成立する» としたスケジュールは全パスが非常最大以内', overLimit.length === 0,
     `超過 ${overLimit.length} 件` + (overLimit[0] ? ` 例: ${overLimit[0].a} ${overLimit[0].c}t →${overLimit[0].t} P${overLimit[0].pass} ${overLimit[0].f.toLocaleString()} t` : ''));
  ok('予測温度がすべて有限', nonFinite === 0, `非有限 ${nonFinite} 件`);
  ok('予測温度が最も冷たい受け手を下回らない', minT >= sinkMin - 1,
     `最低 ${minT} ℃ / 受け手の下限 ${sinkMin} ℃` + (minAt ? ` @ ${minAt.a} ${minAt.c}t ${minAt.w}w ${minAt.L}L →${minAt.t} P${minAt.pass}` : ''));
  ok('予測荷重が非常最大の 3 倍を超えない', maxF <= K.MILL.LIMIT_FORCE_T * 3,
     `最大 ${maxF.toLocaleString()} t / 非常最大 ${K.MILL.LIMIT_FORCE_T.toLocaleString()} t` + (maxAt ? ` @ ${maxAt.a} ${maxAt.c}t ${maxAt.w}w ${maxAt.L}L →${maxAt.t} P${maxAt.pass} ${maxAt.tEnd}℃` : ''));
  ok('熱間域を下回るだけでは «成立しない» にしない（警告のみで運転できる）', blocked.length === 0,
     `温度だけを理由に不成立 ${blocked.length} 件` + (blocked[0] ? ` 例: ${blocked[0].a} ${blocked[0].c}t →${blocked[0].t} ${blocked[0].reasons[0]}` : ''));

  /* 冷却方式。«同じ 1 パス» を同じ条件で通したときの温度変化で比べる（スケジュールごと
   * 比べると、冷却が変わればパス構成そのものが変わってしまい、冷却の効きを見たことに
   * ならない）。抜熱量は 水冷 ＞ 空冷 ＞ なし の順でなければならない。 */
  const SC = M.STRIP_COOL;
  if (SC) {
    const al = K.ALLOYS.A5052, dT = {}, ends = {}, passes = {};
    for (const m of ['WATER', 'AIR', 'NONE']) {
      SC.MODE = m;
      dT[m] = +R.passTempChange(40, 30, 120, 420, 60, al, 1500).toFixed(2);
      const sch = R.buildSchedule(560 - 24, 8, 1500, 500, { coil: true, length: 2400, alloy: 'A5052' });
      ends[m] = sch[sch.length - 1].tEnd; passes[m] = sch.length;
    }
    SC.MODE = 'WATER';
    ok('冷却方式で抜熱が単調（水冷 ≧ 空冷 ≧ なし）', dT.WATER <= dT.AIR && dT.AIR <= dT.NONE,
       `1 パスの温度変化 — 水冷 ${dT.WATER} K / 空冷 ${dT.AIR} K / なし ${dT.NONE} K`);
    ok('冷却方式が抜熱に有意に効く', dT.NONE - dT.WATER >= 1,
       `なし − 水冷 = ${(dT.NONE - dT.WATER).toFixed(2)} K/パス`);
    ok('冷却方式がスケジュールに反映される', ends.WATER !== ends.NONE || passes.WATER !== passes.NONE,
       `既定ロット: 水冷 ${passes.WATER} パス ${ends.WATER} ℃ / 空冷 ${passes.AIR} パス ${ends.AIR} ℃ / なし ${passes.NONE} パス ${ends.NONE} ℃`);
    /* 冷却方式は «熱計算» だけでなく «何を吹いているように見えるか» も変える。
     * 水冷は液滴、空冷は送風、なしは何も吹かない —— 見た目と計算が食い違わないことを見る。 */
    const A = window.__app, W = A.world, P = A.physics;
    const sv = W.spray || Object.values(W).find(v => v && v.stripAir);
    if (sv) {
      const emit = {};
      const s0 = P.slab, m0 = P.mill, onLine = s0.onLine, sp = m0.currentSpeed;
      const hx = window.__LAYOUT.coolHeaderXs()[0];
      s0.onLine = true; m0.currentSpeed = 60; s0.xMin = hx - 2000; s0.xMax = hx + 2000;
      const alive = (f) => f.p.filter(q => q.life > 0 && q.age < q.life).length;
      for (const md of ['WATER', 'AIR', 'NONE']) {
        SC.MODE = md; sv.strip.clear(); sv.stripAir.clear();
        for (let i = 0; i < 120; i++) sv.update(1 / 60, P);
        emit[md] = { drop: alive(sv.strip), air: alive(sv.stripAir) };
      }
      SC.MODE = 'WATER'; s0.onLine = onLine; m0.currentSpeed = sp;
      ok('冷却方式で «吹いているもの» が変わる（水冷＝液滴 / 空冷＝送風 / なし＝無し）',
         emit.WATER.drop > 0 && emit.WATER.air === 0 &&
         emit.AIR.air > 0 && emit.AIR.drop === 0 &&
         emit.NONE.drop === 0 && emit.NONE.air === 0,
         Object.entries(emit).map(([k, v]) => `${k} 液滴 ${v.drop} / 送風 ${v.air}`).join(' ／ '));
      Res.emit = emit;
    } else ok('噴射の描画が冷却方式を見ている', false, 'SprayView が見つからない');
    Res.cool = { dT, ends, passes };
  } else ok('冷却方式（水冷 / 空冷 / なし）が実装されている', false, 'CONFIG.MATERIAL.STRIP_COOL が無い');

  Res.failed = Res.checks.filter(c => !c.pass).length;
  return Res;
});

for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log(`\ngrid : ${out.grid} 通り`);
console.log('worst:', JSON.stringify(out.worst));
if (out.cool) console.log('cool :', JSON.stringify(out.cool));
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
