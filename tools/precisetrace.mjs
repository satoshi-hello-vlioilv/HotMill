// 構成式・制御・熱の «精度» を実測する評価器。
//   1) 変形抵抗の室温上限が、常用域（熱間域）へはみ出していないか
//   2) AGC とクラウンが同じ塑性係数 Q（＝荷重モデルの −dF/dh）を見ているか
//   3) 加工発熱が «その材料点» に付いているか（長手の分布として残るか）
//   node precisetrace.mjs
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });

  /* --- 1) 変形抵抗の室温上限 -------------------------------------------------
   * 上限そのものは外せない（熱間域に当てた単一の (Q, α) では室温まで外挿できない）。
   * 外すべきなのは «常用域へのはみ出し» のほう。両方を数字で押さえる。 */
  const capRows = [];
  for (const key of Object.keys(K.ALLOYS)) {
    const al = K.ALLOYS[key], st = R.stParams(al);
    const raw = (T, e) => {
      /* «上限（KF_MAX）を掛ける前» の生の構成式。materials の定数をそのまま使う
       * （以前は経験式の C を通していたが、構成式を物理パラメータ化して C は無くなった）。 */
      return R.sigmaOf(T, e, st.n, st.alpha, st.Q, st.lnA);
    };
    let worst = 0, at = '';
    for (let T = al.T_ROLL[0] - 60; T <= al.T_ROLL[1]; T += 5)
      for (const e of [1, 5, 20, 60, 120, 300, 600]) {
        const r0 = raw(T, e), d = (r0 - R.flowStress(T, e, al)) / r0;
        if (d > worst) { worst = d; at = `${T}℃ ${e}/s ${r0.toFixed(0)}→${R.flowStress(T, e, al).toFixed(0)} MPa`; }
      }
    capRows.push({ key, cap: al.KF_MAX, 生の室温: +raw(R.T_COLD, 1).toFixed(0),
                   倍率: +(raw(R.T_COLD, 1) / al.KF_MAX).toFixed(2),
                   室温: +R.flowStress(R.T_COLD, 1, al).toFixed(0),
                   熱間の削り: +(worst * 100).toFixed(2), at });
  }
  const capWorst = Math.max(...capRows.map(r => r.熱間の削り));
  ok('室温の上限が熱間域へはみ出していない（1 % 未満）', capWorst < 1.0,
     `最大 ${capWorst} %（${capRows.find(r => r.熱間の削り === capWorst).key} ${capRows.find(r => r.熱間の削り === capWorst).at}）`);
  ok('室温では上限がちゃんと効いている（KF_MAX に載る）',
     capRows.every(r => Math.abs(r.室温 / r.cap - 1) < 0.03),
     capRows.map(r => `${r.key} ${r.室温}/${r.cap}`).join(' '));
  /* 上限（KF_MAX）が «外せない» ことの根拠は «熱間域に当てた式を室温まで外挿すると
   * 実力を上回る» こと。ずれの大きさは材質ごとに違ってよい —— 温度依存が緩い材質
   * （活性化エネルギーが小さい A6061 など）は外挿の暴れ方も小さい。判定するのは
   *   ・どの材質でも «上回る»（外挿 > 室温の実力）—— 下回るなら上限は要らない
   *   ・少なくとも半分の材質で 1.5 倍以上ずれる —— 誤差が «丸め» では済まない大きさ
   * であること。«全材質が 1.5 倍以上» は、たまたま当時の係数がそうだっただけの数字で、
   * 材質表の温度依存を公表の活性化エネルギーへ合わせ直したときに崩れた（A6061 1.3 倍）。 */
  const capBig = capRows.filter(r => r.倍率 > 1.5).length;
  ok('上限は «外せない»（室温外挿がどの材質でも実力を上回り、過半で 1.5 倍以上ずれる）',
     capRows.every(r => r.倍率 > 1.05) && capBig > capRows.length / 2,
     capRows.map(r => `${r.key} ${r.倍率}×`).join(' ') + `（1.5 倍超 ${capBig}/${capRows.length}）`);

  /* --- 2) 塑性係数 Q ---------------------------------------------------------
   * 「入側が δ 厚いと出側は δ·Q/(M+Q) 動く」の Q。AGC のフィードフォワード利得は
   * Q² で効くので、当て推量だとそのまま利得の誤差になる。真値は荷重モデルの −dF/dh。 */
  const qRows = [];
  K.SCHEDULE.forEach((p, i) => {
    const hIn = i > 0 ? K.SCHEDULE[i - 1].gap : P.slab.initialThickness;
    const hOut = p.gap, w = P.slab.width || 1500, T = p.tEnd ?? 450;
    if (!(hIn > hOut)) return;
    // 独立に数値微分して «真値» を作る（実装が使う plasticCoef とは別に解く）
    const eps = Math.max(Math.min(hOut * 0.005, (hIn - hOut) * 0.02), 5e-4);   // 軽圧下では圧下量に対しても小さく取る
    const f1 = R.solve(hIn, hOut, w, 60, T, 0, P.slab.alloy);
    const f2 = R.solve(hIn, hOut + eps, w, 60, T, 0, P.slab.alloy);
    const Qtrue = (f1.forceTon - f2.forceTon) / eps;
    const Qmodel = R.plasticCoef(hIn, hOut, w, 60, T, P.slab.alloy).Q;
    const Qold = Math.max(f1.forceTon / (2 * (hIn - hOut)) * 1.5, 1);   // 直す前の当て推量
    qRows.push({ pass: qRows.length + 1, h: +hOut.toFixed(1), F: +f1.forceTon.toFixed(0),
                 Q: +Qmodel.toFixed(1), 真値: +Qtrue.toFixed(1), 旧: +Qold.toFixed(1),
                 誤差: +(Qmodel / Qtrue - 1).toFixed(4), 旧誤差: +(Qold / Qtrue - 1).toFixed(3) });
  });
  const qErr = Math.max(...qRows.map(r => Math.abs(r.誤差)));
  ok('モデルの Q が荷重モデルの −dF/dh と一致（±3 %）', qErr < 0.03,
     `最大のずれ ${(qErr * 100).toFixed(1)} %（刻み幅の違いだけ）`);
  const oldErr = Math.max(...qRows.map(r => Math.abs(r.旧誤差)));
  ok('直す前の当て推量は無視できないずれだった（記録）', oldErr > 0.15,
     `旧: 最大 ${(oldErr * 100).toFixed(0)} %`);
  const M0 = R.millModulus(1500), gain = (q) => q * q / (M0 * (M0 + q));   // その荷重での増分ばね定数
  const gRows = qRows.map(r => +(gain(r.旧) / gain(r.真値)).toFixed(2));
  ok('フィードフォワード利得が真値どおりになった',
     qRows.every(r => Math.abs(gain(r.Q) / gain(r.真値) - 1) < 0.06),
     `旧の利得比 ${gRows.join(' / ')} → いまは 1.00`);
  /* «薄いほど大きい» は同じ圧下率で比べて初めて言える性質。実機の配分（初パス軽圧下・
   * 定圧下 30 mm → 圧下率 19 %）を並べると圧下量の変わり目で Q が下がる箇所があるので、
   * 圧下率 20 % を固定した系列で問う。 */
  const qSeries = [400, 200, 100, 50, 25, 12].map(h => R.plasticCoef(h / 0.8, h, P.slab.width || 1500, 60, 420, P.slab.alloy).Q);
  ok('Q は板が薄いほど大きい（同じ圧下率で比べて。同じ δ でも出側が動きにくくなる）',
     qSeries.every((q, i) => i === 0 || q > qSeries[i - 1]),
     `圧下率 20 %: ${qSeries.map(q => q.toFixed(1)).join(' → ')} t/mm`);

  /* --- 3) 加工発熱の長手分布 -------------------------------------------------
   * 加工発熱は «その材料点» に付く。頭は AGC が収束しておらず厚い＝圧下が大きく、
   * 端部は冷えていて変形抵抗が高い —— どちらも発熱を増やす。板全体へ平均で配ると消える。 */
  const proto = Object.getPrototypeOf(P.slab), keep = proto.writeHeat;
  const run = (on) => new Promise(r => {
    proto.writeHeat = on ? keep : function () {};
    A.bus.emit('CMD_RESET');
    setTimeout(() => {
      window.__startAuto(false);
      const rows = []; let last = -1, hMin = 1e9, hMax = -1e9;
      window.__ff((p) => {
        const s = p.slab, m = p.mill;
        if (m.passIndex !== last) {
          if (last >= 0) {
            let lo = 1e9, hi = -1e9, sum = 0;
            for (let i = 0; i < s.dTProf.length; i++) {
              lo = Math.min(lo, s.dTProf[i]); hi = Math.max(hi, s.dTProf[i]); sum += s.dTProf[i];
            }
            rows.push({ pass: last + 1, 偏差: +(hi - lo).toFixed(1), 頭: +s.dTProf[0].toFixed(1),
                        中: +s.dTProf[(s.dTProf.length - 1) >> 1].toFixed(1),
                        平均: +(sum / s.dTProf.length).toFixed(6) });
          }
          last = m.passIndex;
        }
        if (s.rollingActive && s.biteFill > 0.99) {
          const u = s.uBite(m.gap), hLoc = s.hAt(u);
          if (hLoc > m.gap && s.flowStress > 0) {
            const q = K.PROCESS.HEAT_EFF * 1.155 * s.flowStress * 1e6 * Math.log(hLoc / m.gap)
                    / (s.alloy.RHO * s.alloy.CP);
            hMin = Math.min(hMin, q); hMax = Math.max(hMax, q);
          }
        }
        return p.finish.done || !!p.tripped;
      }, 120 * 3000, 0);
      r({ rows, heat: [+hMin.toFixed(1), +hMax.toFixed(1)] });
    }, 400);
  });
  const off = await run(false), on = await run(true);
  proto.writeHeat = keep;
  const spread = on.heat[1] - on.heat[0];
  ok('加工発熱は材料点ごとに違う（分布として意味がある大きさ）', spread > 1,
     `1 パスあたり ${on.heat[0]}〜${on.heat[1]} K（幅 ${spread.toFixed(1)} K）`);
  const dOn = Math.max(...on.rows.map(r => r.偏差)), dOff = Math.max(...off.rows.map(r => r.偏差));
  ok('長手の温度偏差が実機の桁に収まる（100 K 未満）', dOn < 100,
     `最大 ${dOn} K（配らない場合 ${dOff} K）`);
  ok('加工発熱が端部の冷えを暖め返す（偏差が小さくなる）', dOn < dOff,
     `配らない ${dOff} K → 配る ${dOn} K`);
  ok('長手プロファイルは «分布» だけを持つ（平均はゼロ）',
     on.rows.every(r => Math.abs(r.平均) < 1e-3), `最大 ${Math.max(...on.rows.map(r => Math.abs(r.平均))).toExponential(1)} K`);
  return { checks, capRows, qRows, gRows, on: on.rows, off: off.rows, heat: on.heat };
});
console.log('■ 変形抵抗の室温上限');
for (const r of out.capRows)
  console.log(`   ${r.key}  上限 ${r.cap} MPa  室温 ${r.室温}（式の生値 ${r.生の室温} = ${r.倍率}×）  熱間域の削り ${r.熱間の削り} %  ${r.at}`);
console.log('■ 塑性係数 Q [t/mm]');
for (const r of out.qRows)
  console.log(`   pass ${r.pass}  h ${r.h}  F ${r.F} t   Q ${r.Q}（真値 ${r.真値}, 誤差 ${(r.誤差 * 100).toFixed(1)} %）  旧 ${r.旧}（${(r.旧誤差 * 100).toFixed(0)} %）`);
console.log('   旧のフィードフォワード利得比:', out.gRows.join(' / '));
console.log('■ 加工発熱の長手分布', `1 パスの局所発熱 ${out.heat[0]}〜${out.heat[1]} K`);
for (let i = 0; i < out.on.length; i++)
  console.log(`   pass ${out.on[i].pass}  偏差 ${out.on[i].偏差} K（頭 ${out.on[i].頭} / 中 ${out.on[i].中}）  配らない場合 ${out.off[i]?.偏差 ?? '-'} K`);
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
process.exit(out.checks.every(c => c.pass) ? 0 : 1);
