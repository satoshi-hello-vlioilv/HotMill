// 圧延荷重に «何が・どれだけ» 効くかを実測して並べる。
//
// 教育資料（docs/圧延荷重に効く要因.md）の数字はすべてここから出す。推論で書かない
// ためで、モデルを直したら数字も一緒に動く。
//
// 測り方は 2 段構え。
//   ① 感度（弾性値）  … ∂lnF/∂lnX。「X を 1 % 増やすと荷重は何 % 動くか」。
//                       量の «単位» に依らないので、板厚と温度と摩擦を同じ物差しで比べられる。
//   ② 影響度          … 感度 × «実機でその量が振れる幅»。感度が大きくても動かない量は
//                       現場では効かない（ロール径がその例）。並べるのはこちらの順。
//
// 温度だけは «0 K からの比» に意味が無い（絶対温度で測ると弾性値が桁で変わる）ので、
// 感度は ∂lnF/∂T [%/10 K] で出し、影響度だけを同じ土俵に載せる。
//
//   node tools/sensload.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const R = window.__ROLL, K = window.__CFG;
  const AL = window.__app ? null : null;
  const al = R.alloy();

  /* 代表 4 条件。実機ロット（530 × 1,330 × 3,450 の A5052）のスケジュールから
   * 厚板・中間・仕上げ・巻取を 1 本ずつ取った。 */
  const CASES = [
    { name: '厚板段 530→455', hIn: 530, hOut: 455, w: 1330, v: 60, T: 430, tens: 0 },
    { name: '中間  213→132', hIn: 213, hOut: 132, w: 1330, v: 90, T: 420, tens: 0 },
    { name: '仕上げ 26→16',  hIn: 26,  hOut: 16,  w: 1330, v: 80, T: 420, tens: 0 },
    { name: '巻取   16→8',   hIn: 16,  hOut: 8,   w: 1330, v: 50, T: 390, tens: 10 },
  ];

  const F = (c, o = {}) => {
    const hIn  = o.hIn  ?? c.hIn,  hOut = o.hOut ?? c.hOut;
    const w    = o.w    ?? c.w,    v    = o.v    ?? c.v;
    const T    = o.T    ?? c.T,    tens = o.tens ?? c.tens;
    const wr0 = K.MILL.WR_D;
    if (o.wrD) K.MILL.WR_D = o.wrD;
    const r = R.solve(hIn, hOut, w, v, T, tens, al, null, o.muScale ?? 1);
    K.MILL.WR_D = wr0;
    return r;
  };

  /* 対数の中心差分。X を ±d 倍して ln の傾きを取る（片側差分より 2 次で正確）。 */
  const dln = (c, mk, d = 0.05) => {
    const up = F(c, mk(1 + d)), dn = F(c, mk(1 - d));
    return Math.log(up.forceTon / dn.forceTon) / Math.log((1 + d) / (1 - d));
  };

  /* 実機でその量が振れる «幅»（ln の幅）。何を根拠に置いたかは FROM に書く。 */
  const wrSwing = Math.log(K.MILL.WR_D / K.MILL.WR_D_MIN);           // 新品 → 研磨限

  const rows = [];
  for (const c of CASES) {
    const base = F(c);
    const kfBase = base.kf;

    /* --- ① 圧下量 Δh（出側板厚を動かす） --- */
    const eDh = dln(c, (k) => ({ hOut: c.hIn - (c.hIn - c.hOut) * k }));
    /* --- ② 変形抵抗 kf（LN_A を動かして σ をずらし、ΔlnF / Δlnkf を取る） --- */
    const eKf = (() => {
      const a0 = al.LN_A, d = 0.05 * al.N_EXP;      // lnA を動かすと ln σ ≒ −ΔlnA/n だけ動く
      al.LN_A = a0 - d; al._st = null; const up = F(c);
      al.LN_A = a0 + d; al._st = null; const dn = F(c);
      al.LN_A = a0;     al._st = null;
      return Math.log(up.forceTon / dn.forceTon) / Math.log(up.kf / dn.kf);
    })();
    /* --- ③ 温度 T（絶対温度の比には意味が無いので %/10 K で出す） --- */
    const eT = (() => {
      const up = F(c, { T: c.T + 15 }), dn = F(c, { T: c.T - 15 });
      return Math.log(up.forceTon / dn.forceTon) / 30 * 10 * 100;     // [%/10 K]
    })();
    /* --- ④ 板幅 w --- */
    const eW  = dln(c, (k) => ({ w: c.w * k }));
    /* --- ⑤ ロール径（扁平を解き直すので Ld と p の両方が動く） --- */
    const eR  = dln(c, (k) => ({ wrD: K.MILL.WR_D * k }));
    /* --- ⑥ 速度 v（＝ひずみ速度 ＋ 摩擦の速度依存の «差し引き»） --- */
    const eV  = dln(c, (k) => ({ v: c.v * k }));
    /* --- ⑦ 摩擦 μ（速度は動かさず μ だけ） --- */
    const eMu = dln(c, (k) => ({ muScale: k }));
    /* --- ⑧ 張力（0 からの比は取れないので %/10 MPa） --- */
    const eTens = (() => {
      const up = F(c, { tens: c.tens + 5 }), dn = F(c, { tens: Math.max(c.tens - 5, 0) });
      const d = (c.tens + 5) - Math.max(c.tens - 5, 0);
      return d > 0 ? Math.log(up.forceTon / dn.forceTon) / d * 10 * 100 : 0;  // [%/10 MPa]
    })();
    /* --- ⑨ ロール扁平そのもの（剛体ロールと比べて何 % 増えたか） --- */
    const flat = (base.forceTon / base.forceRigidTon - 1) * 100;
    /* --- ⑩ 接触弧の局所ひずみ速度（1 点評価との差） --- */
    const arcGain = (() => {
      const n0 = R.ARC_N; R.ARC_N = 1; const one = F(c); R.ARC_N = n0;
      return (one.forceTon / base.forceTon - 1) * 100;                 // 1 点評価だと何 % 高いか
    })();

    const hBar = (c.hIn + c.hOut) / 2;
    rows.push({ name: c.name, tens: c.tens, F: +base.forceTon.toFixed(0), kf: +kfBase.toFixed(1),
      Ld: +base.Ld.toFixed(1), Ldh: +(base.Ld / hBar).toFixed(2), delta: +(hBar / base.Ld).toFixed(2),
      pm: +base.pm.toFixed(0), mu: +base.mu.toFixed(4),
      rate: +base.strainRate.toFixed(2), mEff: +R.mEff(c.T, base.strainRate, al).toFixed(4),
      eDh: +eDh.toFixed(3), eKf: +eKf.toFixed(3), eT: +eT.toFixed(2), eW: +eW.toFixed(3),
      eR: +eR.toFixed(3), eV: +eV.toFixed(3), eMu: +eMu.toFixed(3), eTens: +eTens.toFixed(2),
      flat: +flat.toFixed(1), arc: +arcGain.toFixed(1) });
  }

  /* 材質の振れ幅は «同じパスを 8 材質で通したときの荷重の比» で測る（弾性値では出せない）。 */
  const alloys = [];
  {
    const c = CASES[2], keep = R.alloy();
    const src = K.ALLOYS || null;
    if (src) for (const key of Object.keys(src)) {
      const a = src[key]; a._st = null;
      const r = R.solve(c.hIn, c.hOut, c.w, c.v, c.T, 0, a);
      alloys.push({ key, name: a.name, F: +r.forceTon.toFixed(0), kf: +r.kf.toFixed(1) });
    }
    keep._st = null;
  }

  /* ---- 影響度 ＝ 感度 × «実機でその量が振れる幅» ----------------------------
   * 感度（弾性値）は «1 % 動かしたら» の話なので、現場で 1 % しか動かない量と
   * 2 倍動く量が同じ顔で並ぶ。実際にどれだけ効くかを見るには «振れ幅» を掛ける。
   * 振れ幅の根拠はここに 1 か所だけ書く（数値の出どころを 1 か所にするため）。
   * 実機の実績から決めた値ではないものは from に «目安» と書いてある —— 教育資料でも
   * そのまま «目安» と断って使う。 */
  const SWING = [
    { key: 'kf',  label: '変形抵抗（材質）', ln: null,
      from: '同じパスを 8 材質で通したときの荷重の比（実測）' },
    { key: 'eDh', label: '圧下量 Δh',        ln: Math.log(2),
      from: 'パス設計。1 本のスケジュールの中で圧下量は 2 倍ほど振れる（本アプリの自動生成の実測）' },
    { key: 'eW',  label: '板幅',             ln: Math.log(1600 / 1000),
      from: '実機の板幅 1,000〜1,600 mm' },
    { key: 'eT',  label: '温度',             ln: null, dK: 40,
      from: '抽出 430 ℃ に対しロット差・パス間冷却で ±20 K（目安）' },
    { key: 'eMu', label: '摩擦係数 μ',       ln: Math.log(1.3 / 0.77),
      from: 'クーラントの濃度・劣化・ロールの状態で ±30 %（目安。実機の実測なし）' },
    { key: 'eV',  label: '速度',             ln: Math.log(160 / 40),
      from: '実機の圧延速度 40〜160 mpm' },
    { key: 'eR',  label: 'ロール径',         ln: wrSwing,
      from: `新品 Φ${K.MILL.WR_D} → 研磨限 Φ${K.MILL.WR_D_MIN}（CONFIG.MILL）` },
    { key: 'eTens', label: '張力',           ln: null, dMPa: 20,
      from: '巻取パスのみ。0〜20 MPa（目安）' },
  ];
  const impact = rows.map(r => {
    const o = { name: r.name, items: [] };
    for (const sw of SWING) {
      let pct = null;
      if (sw.key === 'kf') pct = null;                      // 下の材質表で別に出す
      else if (sw.key === 'eT') pct = r.eT / 10 * sw.dK;    // %/10 K × K
      /* 張力は «巻取パスにしか無い»。粗・仕上げパスで数字を並べると、実機に無い量が
       * 効いているように見えてしまう（この評価器を作って最初に気づいたのがこれ）。 */
      else if (sw.key === 'eTens') pct = r.tens > 0 ? r.eTens / 10 * sw.dMPa : null;
      else pct = (Math.exp(r[sw.key] * sw.ln) - 1) * 100;
      if (pct !== null) o.items.push({ label: sw.label, pct: +pct.toFixed(1), from: sw.from });
    }
    o.items.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    return o;
  });

  return { rows, alloys, impact, swing: SWING.map(x => ({ label: x.label, from: x.from })), wrSwing: +wrSwing.toFixed(4), alloy: al.name,
           wrD: K.MILL.WR_D, wrMin: K.MILL.WR_D_MIN, arcN: R.ARC_N };
});
await browser.close();

const P = (x, n) => String(x).padStart(n);
console.log(`材質 ${out.alloy} ／ WR Φ${out.wrD}（研磨限 Φ${out.wrMin}）／ 接触弧の分割 ${out.arcN}\n`);
console.log('条件            荷重 t   kf MPa  Ld mm  Ld/h̄    Δ  pm MPa     μ    ε̇ /s  m_eff');
for (const r of out.rows)
  console.log(`${r.name}  ${P(r.F,6)}${P(r.kf,9)}${P(r.Ld,7)}${P(r.Ldh,7)}${P(r.delta,5)}${P(r.pm,8)}${P(r.mu,7)}${P(r.rate,8)}${P(r.mEff,8)}`);

console.log('\n感度（∂lnF/∂lnX ＝ X を 1 % 増やすと荷重が何 % 動くか）');
console.log('条件             Δh     kf      幅     ロール径   速度     μ    │ 温度 %/10K  張力 %/10MPa');
for (const r of out.rows)
  console.log(`${r.name}${P(r.eDh,7)}${P(r.eKf,7)}${P(r.eW,8)}${P(r.eR,10)}${P(r.eV,8)}${P(r.eMu,7)}    │${P(r.eT,9)}${P(r.eTens,13)}`);

console.log('\nモデルの中で «効いている» 補正（基準との差）');
console.log('条件            ロール扁平  接触弧を 1 点で評価すると');
for (const r of out.rows)
  console.log(`${r.name}${P('+' + r.flat + ' %',11)}${P('+' + r.arc + ' %',20)}`);

console.log('\n影響度（実機でその量が振れる幅ぶん動かしたら、荷重は何 % 動くか）');
for (const im of out.impact) {
  console.log(`  ${im.name}`);
  for (const it of im.items) console.log(`     ${it.label.padEnd(18)} ${(it.pct > 0 ? '+' : '') + it.pct} %`);
}
console.log('  振れ幅の根拠:');
for (const sw of out.swing) console.log(`     ${sw.label.padEnd(18)} ${sw.from}`);

if (out.alloys.length) {
  console.log('\n材質による違い（仕上げ 26 → 16・420 ℃・80 mpm を 8 材質で通す）');
  const s = [...out.alloys].sort((a, b) => a.F - b.F);
  for (const a of s) console.log(`  ${a.name.padEnd(22)} kf ${P(a.kf,6)} MPa   荷重 ${P(a.F,5)} t   （最小比 ${(a.F / s[0].F).toFixed(2)} 倍）`);
}

/* ---------- 判定 ----------
 * しきい値は «スラブ法の骨格から符号と桁が決まっているもの» だけに置く。
 * μ と Δh の感度は «帯» では縛れない —— 摩擦丘の高さは Ld/h̄（＝ 1/Δ）で決まり、
 * 厚板段（Ld/h̄ 0.37）と巻取パス（Ld/h̄ 5.2）で桁が変わるのが正しい姿だから。
 * 代わりに «Ld/h̄ に対して単調に増える» ことを判定にする（これは式から必ず言える）。
 */
const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
for (const r of out.rows) {
  ok(`${r.name}: 幅に比例する（弾性値 ≒ 1）`, Math.abs(r.eW - 1) < 0.02, `${r.eW}`);
  ok(`${r.name}: 変形抵抗にほぼ比例する（0.9〜1.1）`, r.eKf > 0.9 && r.eKf < 1.1, `${r.eKf}`);
  ok(`${r.name}: 圧下量を増やすと荷重が増える`, r.eDh > 0.3, `${r.eDh}`);
  ok(`${r.name}: ロールを太くすると荷重が増える（接触弧が伸びる）`, r.eR > 0, `${r.eR}`);
  ok(`${r.name}: μ を上げると荷重が増える`, r.eMu > 0, `${r.eMu}`);
  ok(`${r.name}: 温度を上げると荷重が下がる`, r.eT < 0, `${r.eT} %/10 K`);
  ok(`${r.name}: 扁平は荷重を増やす向きにしか効かない`, r.flat >= 0, `+${r.flat} %`);
  ok(`${r.name}: 接触弧を 1 点で評価すると荷重が高く出る`, r.arc > 0, `+${r.arc} %`);
  ok(`${r.name}: 速度の感度は m_eff より小さい（摩擦が打ち消す）`, r.eV < r.mEff, `${r.eV} < ${r.mEff}`);
}
/* 摩擦丘は Ld/h̄ で決まる。並べ替えて «単調» を確かめる（帯ではなく順序で縛る）。 */
{
  const byLdh = [...out.rows].sort((a, b) => a.Ldh - b.Ldh);
  const mono = (k) => byLdh.every((r, i) => i === 0 || r[k] >= byLdh[i - 1][k]);
  ok('μ の感度は Ld/h̄ が大きいほど大きい（摩擦丘が高くなる）', mono('eMu'),
     byLdh.map(r => `${r.Ldh}→${r.eMu}`).join('  '));
  /* 圧下量の感度は «単調» にはならない。3 つの寄与の足し算だから ——
   *   ① 幾何    Ld ∝ √(R·Δh) で必ず 0.5
   *   ② 摩擦丘  Ld/h̄ が大きいほど増える
   *   ③ ひずみ速度  圧下率の小さいパスほど «Δh を増やすとひずみも増える» 度合いが強い
   * ③ は Ld/h̄ の小さい厚板段でこそ効くので、②と逆を向く。だから判定は «幾何の 0.5 を
   * 割らない» と «Ld/h̄ が最大のパスで最大になる» の 2 つに留め、値は参考として出す。 */
  ok('圧下量の感度が幾何の下限 0.5 を大きく割らない（0.45 以上）',
     out.rows.every(r => r.eDh > 0.45), out.rows.map(r => r.eDh).join(' / '));
  ok('圧下量の感度は Ld/h̄ が最大のパスで最大になる',
     byLdh[byLdh.length - 1].eDh === Math.max(...out.rows.map(r => r.eDh)),
     byLdh.map(r => `${r.Ldh}→${r.eDh}`).join('  '));
  ok('ロール扁平の効きも Ld/h̄ が大きいほど大きい（薄いほど平たく潰れる）', mono('flat'),
     byLdh.map(r => `${r.Ldh}→+${r.flat}%`).join('  '));
}
ok('張力は荷重を下げる向きに効く（巻取パス）',
   out.rows[3].eTens < 0, `${out.rows[3].eTens} %/10 MPa`);
ok('材質で荷重が 2 倍以上変わる（同じパス・同じ温度でも）',
   out.alloys.length >= 2 && Math.max(...out.alloys.map(a => a.F)) / Math.min(...out.alloys.map(a => a.F)) > 2,
   out.alloys.length ? `${(Math.max(...out.alloys.map(a => a.F)) / Math.min(...out.alloys.map(a => a.F))).toFixed(2)} 倍` : '材質表が取れず');

console.log('');
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - bad.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
