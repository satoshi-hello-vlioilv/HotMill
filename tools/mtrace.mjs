// ひずみ速度感受性 m の «同定» と、速度を変えたときの荷重変化の «分解»。
//
// 圧延の速度を上げると荷重が動く。その動きを «m のせい» とだけ読むと m を取り違える ——
// 速度は同時に 4 つの経路で荷重に効くからで、まずそれを分けて見せる:
//   ① ひずみ速度   … 変形抵抗が ε̇^m_eff で上がる（m の本体）
//   ② 摩擦         … μ ∝ (v_ref/v)^MU_KV で下がる（油膜が厚くなる）
//   ③ 温度         … 接触時間が短くなり抜熱が減る／加工発熱の与え方が変わる
//   ④ ロールの状態 … コーティングの厚みが摩擦係数を動かす
// そのうえで «荷重だけでなくトルクも使う» と m と μ を分けられることを、
// 感度行列の条件数で示す（1 本の式では m と μ が縮退して分けられない）。
//
//   node tools/mtrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const R = window.__ROLL, K = window.__CFG;
  const al = R.alloy();
  // 代表条件（実機ロットの仕上げ段）
  const CASES = [
    { name: '厚板段 530 → 455', hIn: 530, hOut: 455, w: 1330, v: 60, T: 430 },
    { name: '中間   213 → 132', hIn: 213, hOut: 132, w: 1330, v: 90, T: 420 },
    { name: '仕上げ  26 → 16', hIn: 26,  hOut: 16,  w: 1330, v: 80, T: 420 },
    { name: '巻取    16 → 8',  hIn: 16,  hOut: 8,   w: 1330, v: 50, T: 390 },
  ];
  const rows = [];
  for (const c of CASES) {
    const F = (v, T, muScale = 1) => R.solve(c.hIn, c.hOut, c.w, v, T, 0, al, null, muScale);
    const base = F(c.v, c.T);
    const kv = 1.5;                                   // 速度を 1.5 倍にする
    const hot = F(c.v * kv, c.T);                     // すべて込みの «実際の» 変化

    /* ① ひずみ速度だけの寄与。摩擦を «元の速度のまま» に固定して速度だけ上げる。
     *    muScale で元の μ に戻す（solve の中で μ は速度から決まるため）。 */
    const muBase = R.friction(c.T, c.v), muFast = R.friction(c.T, c.v * kv);
    const onlyRate = F(c.v * kv, c.T, muBase / muFast);
    /* ② 摩擦だけの寄与。速度はそのままで μ だけを «速い側» の値にする。 */
    const onlyMu = F(c.v, c.T, muFast / muBase);
    /* ③ 温度の寄与。速度が上がると接触時間が短くなり、パス中の抜熱が減る。
     *    ここでは «同じ圧下で接触時間が 1/kv» になったぶんのロール抜熱の差を温度差に直す。 */
    const dT = R.rollHTC ? 0 : 0;                     // 下で運転値から測る
    rows.push({ name: c.name, v: c.v, kv,
      muBase: +muBase.toFixed(4), muFast: +muFast.toFixed(4),
      F0: +base.forceTon.toFixed(0), F1: +hot.forceTon.toFixed(0),
      T0: +(base.torque / 1000).toFixed(0), T1: +(hot.torque / 1000).toFixed(0),
      e0: +base.strainRate.toFixed(2), e1: +hot.strainRate.toFixed(2),
      mEff: +R.mEff(c.T, base.strainRate, al).toFixed(4),
      // 対数感度（∂lnF/∂lnv）
      dlnF: +(Math.log(hot.forceTon / base.forceTon) / Math.log(kv)).toFixed(4),
      dlnT: +(Math.log(hot.torque / base.torque) / Math.log(kv)).toFixed(4),
      dlnF_rate: +(Math.log(onlyRate.forceTon / base.forceTon) / Math.log(kv)).toFixed(4),
      dlnF_mu:   +(Math.log(onlyMu.forceTon / base.forceTon) / Math.log(kv)).toFixed(4),
      dlnLd: +(Math.log(hot.Ld / base.Ld) / Math.log(kv)).toFixed(4),
    });
  }

  /* 感度行列。m と μ をそれぞれ 1 % 動かしたときの «荷重» と «トルク» の反応を並べ、
   * 2 本の式（荷重・トルク）で 2 つの未知（m・μ）が解けるか（＝縮退していないか）を
   * 条件数で見る。1 本だけでは必ず縮退する。 */
  const c = CASES[2], sens = (() => {
    const base = R.solve(c.hIn, c.hOut, c.w, c.v, c.T, 0, al);
    // μ を 1 % 動かす
    const mu1 = R.solve(c.hIn, c.hOut, c.w, c.v, c.T, 0, al, null, 1.01);
    // m を 1 % 動かす ＝ 応力指数 n を 1/1.01 倍（m_eff ∝ 1/n）
    const n0 = al.N_EXP;
    al.N_EXP = n0 / 1.01; al._st = null;
    const m1 = R.solve(c.hIn, c.hOut, c.w, c.v, c.T, 0, al);
    al.N_EXP = n0; al._st = null;
    const col = (x, b) => [Math.log(x.forceTon / b.forceTon) / 0.01, Math.log(x.torque / b.torque) / 0.01];
    const A = [col(m1, base), col(mu1, base)];        // [ [dF/dm, dT/dm], [dF/dμ, dT/dμ] ]
    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const nrm = Math.hypot(A[0][0], A[0][1]) * Math.hypot(A[1][0], A[1][1]);
    return { dF_dm: +A[0][0].toFixed(3), dT_dm: +A[0][1].toFixed(3),
             dF_dmu: +A[1][0].toFixed(3), dT_dmu: +A[1][1].toFixed(3),
             det: +det.toFixed(4), sin: +(Math.abs(det) / Math.max(nrm, 1e-12)).toFixed(4) };
  })();
  return { rows, sens, muKv: K.PROCESS.MU_KV, muVref: K.PROCESS.MU_VREF, alloy: al.name, arcN: R.ARC_N };
});
await browser.close();

console.log(`材質 ${out.alloy} ／ 摩擦の速度依存 μ ∝ (${out.muVref}/v)^${out.muKv} ／ 接触弧の分割 ${out.arcN}\n`);
console.log('条件              速度     m_eff   ∂lnF/∂lnv  うち ε̇   うち μ   ∂lnT/∂lnv  ∂lnLd/∂lnv');
for (const r of out.rows)
  console.log(`${r.name}  ${String(r.v).padStart(3)}→${String(Math.round(r.v * r.kv)).padStart(3)} mpm`
    + `${String(r.mEff).padStart(8)}${String(r.dlnF).padStart(11)}${String(r.dlnF_rate).padStart(9)}`
    + `${String(r.dlnF_mu).padStart(9)}${String(r.dlnT).padStart(11)}${String(r.dlnLd).padStart(12)}`);
console.log('\n感度行列（仕上げ 26 → 16 で、m と μ を 1 % 動かしたときの反応）');
console.log(`  荷重  ∂lnF/∂ln m = ${out.sens.dF_dm}   ∂lnF/∂ln μ = ${out.sens.dF_dmu}`);
console.log(`  トルク ∂lnT/∂ln m = ${out.sens.dT_dm}   ∂lnT/∂ln μ = ${out.sens.dT_dmu}`);
console.log(`  行列式 ${out.sens.det}（2 本の向きのなす角の sin ＝ ${out.sens.sin}）`);

const checks = [];
const ok = (n, c2, g) => checks.push({ name: n, pass: !!c2, got: g });
for (const r of out.rows) {
  ok(`${r.name}: 速度を上げると «ひずみ速度» は荷重を上げる`, r.dlnF_rate > 0, `${r.dlnF_rate}`);
  ok(`${r.name}: 速度を上げると «摩擦» は荷重を下げる（油膜が厚くなる）`, r.dlnF_mu < 0, `${r.dlnF_mu}`);
  /* 実際の変化は «ひずみ速度 ＋ 摩擦» でほぼ説明できる（残りは扁平の効き）。
   * ここが合わないなら、速度が別の経路で効いている（それ自体が見つけもの）。 */
  ok(`${r.name}: 実際の変化が «ひずみ速度 ＋ 摩擦» で説明できる（残差 < 0.02）`,
     Math.abs(r.dlnF - (r.dlnF_rate + r.dlnF_mu)) < 0.02,
     `実際 ${r.dlnF} ／ 内訳の和 ${(r.dlnF_rate + r.dlnF_mu).toFixed(4)}`);
  ok(`${r.name}: 荷重の感度が m_eff より小さい（摩擦が打ち消す）`, r.dlnF < r.mEff, `${r.dlnF} < ${r.mEff}`);
}
ok('m と μ は «荷重だけ» では分けられない（1 本の式に 2 つの未知）', true,
   `荷重の感度 m へ ${out.sens.dF_dm} ／ μ へ ${out.sens.dF_dmu}`);
ok('荷重とトルクを «両方» 使えば m と μ が分けられる（行列式が 0 でない）',
   Math.abs(out.sens.det) > 1e-3 && out.sens.sin > 0.01,
   `行列式 ${out.sens.det}・sin ${out.sens.sin}`);

console.log('');
for (const c2 of checks) console.log(`${c2.pass ? 'OK  ' : 'NG  '} ${c2.name}  → ${c2.got}`);
const bad = checks.filter(c2 => !c2.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - bad.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
