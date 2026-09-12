// 圧延モデル（力学・材料・摩擦・熱・制御）の «物理として正しいか» を問う評価器。
//
// なぜ要るか: これまでの評価器は «結果の数値» が範囲内か（荷重が上限以内か、板厚が目標か）
// を見ていた。ここでは «式そのものが持つべき性質» —— 単調性・収束性・保存則・
// 既知の理論値との一致 —— を問う。モデルを差し替えたときに «結果は似ているが
// 物理として壊れている» 変更を通さないための網。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL;
  const Res = { checks: [] }, ok = (n, p, d = '') => Res.checks.push({ name: n, pass: !!p, detail: d });
  const al = K.ALLOYS.A5052, W = 1500;

  /* ================= 1. ロールの弾性扁平（Hitchcock） ================= */
  {
    const has = typeof R.flattenedRadius === 'function';
    ok('ロールの弾性扁平が実装されている', has, has ? 'Rolling.flattenedRadius' : '未実装');
    if (has) {
      const R0 = K.MILL.WR_D / 2;
      // 圧下量が小さいほど（薄いパスほど）扁平が効く
      const thin = R.solve(12, 9, W, 90, 380, 0, al), thick = R.solve(300, 220, W, 35, 470, 0, al);
      const rt = (q) => q.Rflat / R0;
      ok('扁平半径が素の半径より大きい', rt(thin) > 1.0001 && rt(thick) > 1.0001,
         `薄 ${rt(thin).toFixed(3)} 倍 / 厚 ${rt(thick).toFixed(3)} 倍`);
      // 比較は «素の半径からの増分» で見る（比そのものはどちらも 1 に近く差が読めない）
      ok('薄いパスほど扁平が強い（圧下量に反比例）', (rt(thin) - 1) > (rt(thick) - 1) * 4,
         `増分 薄 ${((rt(thin) - 1) * 100).toFixed(1)} % / 厚 ${((rt(thick) - 1) * 100).toFixed(1)} %`);
      ok('扁平した接触弧が幾何の接触弧より長い',
         thin.Ld > R.contactLength(12, 9) * 1.02,
         `扁平 ${thin.Ld.toFixed(1)} mm / 幾何 ${R.contactLength(12, 9).toFixed(1)} mm`);
      // 陰的関係（荷重 → 扁平 → 接触弧 → 荷重）が収束していること
      ok('扁平の反復が収束している（残差 1 % 未満）', thin.flatResid < 0.01 && thick.flatResid < 0.01,
         `残差 薄 ${(thin.flatResid * 100).toFixed(3)} % / 厚 ${(thick.flatResid * 100).toFixed(3)} %`);
      ok('扁平は荷重を上げる向きに効く', thin.forceTon > thin.forceRigidTon,
         `扁平 ${Math.round(thin.forceTon)} t / 剛体 ${Math.round(thin.forceRigidTon)} t`);
    }
  }

  /* ================= 2. 構成式（Zener–Hollomon / sinh 型） ================= */
  {
    const has = typeof R.zener === 'function';
    ok('Zener–Hollomon パラメータが実装されている', has, has ? 'Rolling.zener' : '未実装');
    const kf = (T, r) => R.flowStress(T, r, al);
    ok('変形抵抗が温度に対して単調減少', kf(350, 1) > kf(450, 1) && kf(450, 1) > kf(520, 1),
       `350/450/520 ℃ = ${kf(350, 1).toFixed(0)}/${kf(450, 1).toFixed(0)}/${kf(520, 1).toFixed(0)} MPa`);
    ok('変形抵抗がひずみ速度に対して単調増加', kf(450, 0.1) < kf(450, 1) && kf(450, 1) < kf(450, 30),
       `0.1/1/30 s⁻¹ = ${kf(450, 0.1).toFixed(0)}/${kf(450, 1).toFixed(0)}/${kf(450, 30).toFixed(0)} MPa`);
    /* ---- 構成式が «材料 / 温度 / ひずみ速度» を分けて持てているかを検証する ----
     *
     * 使う式は Sellars–Tegart（Garofalo）:
     *     Z ＝ ε̇·exp(Q/RT) ＝ A·[sinh(α·σ)]^n
     * 役割が 1 つずつ分かれていることが要点 ——
     *     Q     … 温度依存だけを決める（材質ごとの公表値。荷重合わせで動かさない）
     *     n, α  … ひずみ速度依存の «形» だけを決める（材質ごとの公表値）
     *     A     … 絶対値だけを決める（荷重の較正で動かしてよい唯一のつまみ）
     * 以前は経験式 C·exp(−b·ΔT)·ε̇^m が主で、Q と α をそれに «当てはめて» いたため、
     * 荷重を合わせに m を動かすと温度依存が一緒に動いた（Q_fit ＝ b·R·T_ref²/m）。 */
    {
      const Rg = R.RGAS;
      // ① 恒等式そのもの: n·ln sinh(ασ) ＝ ln ε̇ ＋ Q/(R·T) − ln A が全点で成り立つか
      let idBad = 0, idMax = 0;
      for (const T of [360, 420, 480, 540]) for (const r of [0.1, 1, 10, 100]) {
        const st = R.stParams(al), sg = R.flowStress(T, r, al);
        if (sg >= al.KF_MAX * 0.98) continue;                 // 室温側の頭打ちが効く域は除く
        const lhs = st.n * Math.log(Math.sinh(st.alpha * sg));
        const rhs = Math.log(r) + st.Q / (Rg * (T + 273.15)) - st.lnA;
        const d = Math.abs(lhs - rhs);
        idMax = Math.max(idMax, d); if (d > 1e-6) idBad++;
      }
      ok('構成式の恒等式が全点で成り立つ（n·ln sinh(ασ) ＝ ln ε̇ ＋ Q/RT − ln A）',
         idBad === 0, `最大残差 ${idMax.toExponential(1)}`);

      // ② 温度依存を担うのは Q «だけ» —— 逆算した活性化エネルギーが公表値に一致するか
      const qOf = (a) => {
        const st = R.stParams(a), T1 = 420, T2 = 480, r = 1;
        const f = (T) => st.n * Math.log(Math.sinh(st.alpha * R.flowStress(T, r, a)));
        const x1 = 1 / (T1 + 273.15), x2 = 1 / (T2 + 273.15);
        return Rg * (f(T1) - f(T2)) / (x1 - x2) / 1000;       // [kJ/mol]
      };
      const qBad2 = Object.entries(K.ALLOYS).filter(([, a]) => Math.abs(qOf(a) / a.Q_ACT - 1) > 0.001);
      ok('温度依存を担うのは Q だけ（式から逆算した活性化エネルギーが公表値と一致）',
         qBad2.length === 0,
         Object.entries(K.ALLOYS).map(([k, a]) => `${k} ${qOf(a).toFixed(0)}/${a.Q_ACT}`).join(' '));

      // ③ ひずみ速度依存の «形» を担うのは n と α だけ —— 逆算した 1/n が一致するか
      const nOf = (a) => {
        const st = R.stParams(a), T = 450;
        const f = (r) => Math.log(Math.sinh(st.alpha * R.flowStress(T, r, a)));
        return (Math.log(10) - Math.log(1)) / (f(10) - f(1));
      };
      const nBad = Object.entries(K.ALLOYS).filter(([, a]) => Math.abs(nOf(a) / a.N_EXP - 1) > 0.001);
      ok('ひずみ速度依存の形を担うのは n（式から逆算した応力指数が表の値と一致）',
         nBad.length === 0, Object.entries(K.ALLOYS).map(([k, a]) => `${k} ${nOf(a).toFixed(2)}/${a.N_EXP}`).join(' '));

      // ④ n と α がアルミ熱間加工の公表値の帯に入っているか（辻褄合わせに使われていないこと）
      const NB = [4.0, 6.5], AB = [0.012, 0.050];
      const band = Object.entries(K.ALLOYS).filter(([, a]) =>
        !(a.N_EXP >= NB[0] && a.N_EXP <= NB[1] && a.ALPHA >= AB[0] && a.ALPHA <= AB[1]));
      ok(`n と α がアルミの公表値の帯に入る（n ${NB[0]}〜${NB[1]}・α ${AB[0]}〜${AB[1]}）`,
         band.length === 0, band.length ? band.map(([k, a]) => `${k} n=${a.N_EXP} α=${a.ALPHA}`).join(' ')
                                        : `${Object.keys(K.ALLOYS).length} 材質すべて帯の中`);

      // ⑤ m は «定数ではなく導出量» —— 数値微分した ∂lnσ/∂lnε̇ が tanh(ασ)/(n·ασ) と一致するか
      let mMax = 0;
      for (const T of [380, 450, 520]) for (const r of [0.5, 5, 50]) {
        const num = (Math.log(R.flowStress(T, r * 1.001, al)) - Math.log(R.flowStress(T, r / 1.001, al)))
                  / (Math.log(r * 1.001) - Math.log(r / 1.001));
        mMax = Math.max(mMax, Math.abs(num / R.mEff(T, r, al) - 1));
      }
      ok('m_eff が数値微分した ∂lnσ/∂lnε̇ と一致する（式 tanh(ασ)/(n·ασ)）', mMax < 2e-3,
         `最大ずれ ${(mMax * 100).toFixed(3)} %`);

      // ⑥ 同じ材質でも m は条件で変わる（固定 m では表せない）
      const mHot = R.mEff(520, 0.5, al), mCold = R.mEff(380, 50, al);
      ok('同じ材質でも m_eff が条件で変わる（高温・低速ほど大きい）', mHot > mCold * 1.15,
         `520 ℃/0.5 s⁻¹ で ${mHot.toFixed(3)} ／ 380 ℃/50 s⁻¹ で ${mCold.toFixed(3)}（比 ${(mHot / mCold).toFixed(2)}）`);
    }
    // 低温では «室温の変形抵抗» へ漸近して発散しない
    const cold = kf(30, 1);
    ok('低温で発散せず室温の変形抵抗へ漸近', cold > al.KF_MAX * 0.6 && cold < al.KF_MAX * 1.6,
       `30 ℃ で ${cold.toFixed(0)} MPa / 目安 ${al.KF_MAX} MPa`);
  }

  /* ================= 3. 前進率と中立点 ================= */
  {
    const r = R.solve(30, 20, W, 90, 400, 0, al);
    const has = typeof r.forwardSlip === 'number';
    ok('前進率（forward slip）が実装されている', has, has ? `f = ${(r.forwardSlip * 100).toFixed(2)} %` : '未実装');
    if (has) {
      ok('前進率が実測の範囲に入る（0〜15 %）', r.forwardSlip > 0 && r.forwardSlip < 0.15,
         `${(r.forwardSlip * 100).toFixed(2)} %`);
      ok('中立角が 0 と噛み込み角の間にある', r.neutral > 0 && r.neutral < r.biteAngle,
         `中立 ${(r.neutral * 180 / Math.PI).toFixed(2)}° / 噛み込み ${(r.biteAngle * 180 / Math.PI).toFixed(2)}°`);
      // 圧下率が上がると中立点は入側へ寄り、前進率は増える
      const r2 = R.solve(30, 15, W, 90, 400, 0, al);
      ok('圧下率が上がると前進率が増える', r2.forwardSlip > r.forwardSlip,
         `${(r.forwardSlip * 100).toFixed(2)} % → ${(r2.forwardSlip * 100).toFixed(2)} %`);
    }
  }

  /* ================= 4. 摩擦係数の状態依存 ================= */
  {
    const has = typeof R.friction === 'function';
    ok('摩擦係数が状態（温度・速度）で変わる', has, has ? 'Rolling.friction' : '未実装（μ 一定）');
    if (has) {
      const m1 = R.friction(350, 30), m2 = R.friction(500, 30), m3 = R.friction(450, 300);
      // 温度依存は向きが定まらない（アルミは凝着で上がるとする測定もある）ので、係数の符号どおりに動くことだけを見る
      const kt = window.__CFG.PROCESS.MU_KT;
      ok('摩擦係数の温度依存が係数 MU_KT の符号どおり（0 なら中立）', kt > 0 ? m2 < m1 : kt < 0 ? m2 > m1 : Math.abs(m2 - m1) < 1e-9,
         `350 ℃ ${m1.toFixed(3)} → 500 ℃ ${m2.toFixed(3)}（MU_KT ${kt}）`);
      ok('速度が上がると摩擦係数が下がる', m3 < R.friction(450, 30),
         `30 mpm ${R.friction(450, 30).toFixed(3)} → 300 mpm ${m3.toFixed(3)}`);
      const all = [m1, m2, m3];
      ok('摩擦係数が熱間圧延の実測範囲に収まる（0.1〜0.5）', all.every(m => m > 0.1 && m < 0.5),
         all.map(m => m.toFixed(3)).join(' / '));
    }
  }

  /* ================= 5. ロール温度の履歴 ================= */
  {
    const has = P.mill && typeof P.mill.rollTemp === 'number';
    ok('ロール表面温度が状態として存在する', has, has ? `${P.mill.rollTemp.toFixed(1)} ℃` : '未実装（一定値）');
    if (has) {
      const t0 = P.mill.rollTemp;
      window.__startAuto(false);
      window.__ff(p => p.mill.passIndex >= 9, 120 * 1500);
      const t1 = P.mill.rollTemp;
      /* 上がり幅は小さい: 界面と内部の抵抗を直列にした実効熱伝達率（Rolling.rollHTC）と軽い初パス
       * （10 mm 圧下）では、1 パスのロール抜熱が 0.1〜0.3 K・ロール 2 本の熱容量が板の 1.7 倍。
       * «上がる向き» を問う（閾値 0.5 K）ので、それが見える本数まで回す —— 界面の熱伝達率を
       * 上がり温度で合わせ直した（H_ROLL 25,000 → 12,000）ぶん 1 パスの取り込みが減り、
       * 4 パスでは 0.3 K しか上がらず «向き» が読めなくなったので 10 パスまで回す。 */
      ok('圧延を重ねるとロール温度が上がる', t1 > t0 + 0.5, `${t0.toFixed(1)} → ${t1.toFixed(1)} ℃`);
      ok('ロール温度が現実的な範囲に収まる（〜200 ℃）', t1 < 200, `${t1.toFixed(1)} ℃`);
      A.bus.emit('CMD_RESET');
    }
  }

  /* ================= 6. フィードフォワード AGC ================= */
  /* 前のパスが残した «その場所の板厚» は分かっているので、荷重に現れるのを待たずに
   * 先に圧下を動かせる。ただし «整った素材» では入側の偏差そのものが無いので効きようがない
   * （実測: 標準ロットでは頭のオフゲージが 0.139 → 0.153 mm と、むしろ悪化した）。
   * 効くのは «入側に本当に偏差があるとき» なので、入側プロファイルへ意図的に段差を入れ、
   * 出側にどれだけ通り抜けるかを FF あり／なしで比べる —— これが正しい実験。 */
  {
    const has = !!K.AGC && typeof K.AGC.FF_KP === 'number';
    ok('フィードフォワード AGC が実装されている', has, has ? `ゲイン ${K.AGC.FF_KP}` : '未実装');
    if (has) {
      const run = (kp) => {
        K.AGC.FF_KP = kp;
        A.bus.emit('CMD_RESET');
        window.__startAuto(false);
        window.__ff(p => p.mill.passIndex >= 5 && p.slab.inBite, 120 * 2000);
        const s = P.slab, m = P.mill;
        // 入側の «まだ噛んでいない» 側へ段差（+4 %）を入れる
        const N = s.hProf.length, u0 = s.uBite(m.gap);
        for (let i = 0; i < N; i++) {
          const u = i / (N - 1);
          if (s.dir > 0 ? u < u0 - 0.05 : u > u0 + 0.05) s.hProf[i] *= 1.04;
        }
        /* 出側の «段差ぶんの振れ» だけを見る。ミル定数の同定誤差による一定のずれが
         * 乗っているので、最大値そのものでは «段差にどう応えたか» が読めない。
         * 中央値を基準線にして、そこからの振れ幅で比べる。 */
        const e = [];
        let n = 0;
        while (n++ < 120 * 90 && s.inBite) {
          P.step(1 / 120);
          if (s.biteFill > 0.999) e.push(m.gap - m.targetGap);
        }
        if (e.length < 20) return Infinity;
        const sorted = [...e].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
        return Math.max(...e.map(x => Math.abs(x - med)));
      };
      const off = run(0), on = run(0.8);
      K.AGC.FF_KP = 0.8;
      /* 実測すると «ほぼ互角» になる。これは実装の不備ではなく、単スタンドで
       * ゲージメータ AGC が正しく効いている限り、入側偏差 δ に対する補正の 9 割以上を
       * 荷重 FB が受け持ち、フィードフォワードの取り分が δ·Q²/(M(M+Q)) ＝ δ の 6 % 程度
       * しか残らないため。«効く場面» はタンデム（前スタンドの出側を読む）や、
       * ミル定数の同定誤差が大きいときで、単スタンドでは «悪化させないこと» が要件になる。 */
      ok('フィードフォワードを入れても出側の振れが悪化しない（10 % 以内）', on <= off * 1.10,
         `FF あり ${on.toFixed(3)} mm / なし ${off.toFixed(3)} mm（入側に +4 % の段差）`);
      // 受け持ち量が導出どおりの桁であること（δ·Q²/(M(M+Q))。全量 δ·Q/M ではない）
      const M = R.millModulus(1500), Q = 150;   // ミル定数は非線形なので «その荷重での» 値
      /* ミルばねは実機の測定表（伸びの帯ごとの増分ばね定数）から引く。
       * 一定ではない —— ハウジング・チョック・軸受のがたが荷重で締まるほど硬くなる。 */
      {
        const tab = K.MILL.MODULUS_TABLE, st = K.MILL.MODULUS_STEP;
        // ① 表を積み上げた荷重と、帯の境目での値が一致するか
        let f = 0, bad = [];
        for (let i = 0; i < tab.length; i++) {
          f += tab[i] * st;
          if (Math.abs(R.millForce((i + 1) * st) - f) > 1e-9) bad.push(`${(i + 1) * st} mm`);
        }
        ok('ミルばねが測定表どおりに積み上がる', bad.length === 0,
           bad.join(' ') || tab.map((v, i) => `${i * st}〜${(i + 1) * st} mm ${v}`).join(' ／ ') + ' t/mm');
        // ② 荷重 ⇄ 伸びが往復して戻る（逆引きが正しい）
        let rt = 0;
        for (const ft of [100, 226, 500, 1314, 2000, 3200])
          rt = Math.max(rt, Math.abs(R.millForce(R.millStretch(ft)) - ft));
        ok('荷重 ⇄ 伸びの往復が戻る（逆引きが正しい）', rt < 1e-6, `最大ずれ ${rt.toExponential(1)} t`);
        // ③ 荷重が増えるほど硬くなる（がたが締まる）
        const inc = [200, 700, 1200, 2000].map(ft => R.millModulus(ft));
        ok('荷重が増えるほど増分ばね定数が上がる（がたが締まる）',
           inc.every((v, i) => i === 0 || v >= inc[i - 1]), inc.map(v => v.toFixed(0)).join(' → ') + ' t/mm');
        // ④ 割線ばね定数は増分より «やわらかい» 側に出る（下から積み上げるので当然）
        const sec = R.millSecant(1314);
        ok('割線ばね定数が増分より小さい（下の柔らかい帯を引きずる）',
           sec < R.millModulus(1314) && Math.abs(sec - 1314 / 5) < 0.5,
           `1,314 t で 割線 ${sec.toFixed(1)} ／ 増分 ${R.millModulus(1314).toFixed(0)} t/mm（伸び ${R.millStretch(1314).toFixed(2)} mm）`);
        // ⑤ 表の外は «最後の増分のまま» 外挿する（硬くなり続けると置かない）
        ok('測定範囲の外は最後の増分のまま外挿する',
           Math.abs(R.millModulus(1e5) - tab[tab.length - 1]) < 1e-9,
           `5 mm 超は ${tab[tab.length - 1]} t/mm のまま`);
      }
      const share = Q * Q / (M * (M + Q)) / (Q / M);
      ok('フィードフォワードの取り分が導出どおり（全量の 1 割強）', share > 0.05 && share < 0.35,
         `Q/(M+Q) = ${share.toFixed(3)}（Q ${Q} / M ${M} t/mm）`);
      A.bus.emit('CMD_RESET');
    }
  }

  /* ================= 7. 端部欠陥（舌とワニ口） ================= */
  /* 舌（幅中央が伸びる）とワニ口（表裏が開く）は発生機構が違う。
   *   舌     —— 幅方向の不均一な広がり。どのパスでも «その端を最後に平らにしてから» 育つ
   *   ワニ口 —— 表層集中変形（Δ = hMean/Ld > 1）でだけ育つ。薄板では出ない
   * クロップは «端を平らにする» 工程なので、切った瞬間 0 になり、そのあと舌だけが付き直す。
   * ここを «切ったら以後ずっと 0» にしていたため、薄い領域で一切計算されていなかった。 */
  {
    const has = typeof P.slab.overhangParts === 'function';
    ok('端部欠陥が «舌» と «ワニ口» に分かれている', has, has ? 'SlabState.overhangParts' : '未実装');
    if (has) {
      const dl = R.inhomogeneity(536, 455, 0), dt = R.inhomogeneity(14.3, 10.9, 0);
      ok('不均一変形の指標 Δ が厚板で 1 超・薄板で 1 未満', dl > 1 && dt < 1,
         `536→455 で Δ=${dl.toFixed(2)} / 14.3→10.9 で Δ=${dt.toFixed(2)}`);

      A.bus.emit('CMD_RESET');
      window.__startAuto(false);
      // 厚板（クロップ前）: 舌もワニ口も付く
      window.__ff(p => p.slab.thickness < 300 && !p.slab.cropped[1], 120 * 1200);
      const thick = P.slab.overhangParts(1);
      ok('厚板（Δ>1）では舌とワニ口が両方つく', thick.tongue > 1 && thick.gator > 1,
         `舌 ${thick.tongue.toFixed(0)} / ワニ口 ${thick.gator.toFixed(0)} mm`);

      // クロップ直後: 端は平ら
      window.__ff(p => p.slab.cropped[1] && p.slab.cropped[-1], 120 * 2500);
      const cut = P.slab.overhangParts(1);
      ok('クロップ直後の端は平ら（舌もワニ口も 0）', cut.tongue < 1 && cut.gator < 1,
         `舌 ${cut.tongue.toFixed(1)} / ワニ口 ${cut.gator.toFixed(1)} mm`);
      const hCut = P.slab.hCut[1];
      ok('クロップで «端部欠陥の起点» がその時の板厚に更新される', hCut > 0,
         `起点 ${hCut ? hCut.toFixed(1) : '—'} mm`);

      // クロップ後の薄い領域: 舌は付き直し、ワニ口は付かない
      window.__ff(p => p.finish.done || !!p.tripped, 120 * 3000);
      const thin = P.slab.overhangParts(1);
      ok('クロップ後の薄い領域でも舌が付き直す', thin.tongue > 20,
         `板厚 ${P.slab.thickness.toFixed(1)} mm で舌 ${thin.tongue.toFixed(0)} mm`);
      ok('クロップ後の薄い領域ではワニ口が付かない（Δ<1）', thin.gator < 1,
         `ワニ口 ${thin.gator.toFixed(1)} mm（hHomo ${P.slab.hHomo?.toFixed(1)} mm）`);
      // 端の最大変位は «幅中央かつ表裏» で 舌 + ワニ口
      const z = R.endZone(thin.tongue + thin.gator, P.slab.length);
      const mx = R.endOffset(0, thin.tongue, thin.gator, z, 1, 0);
      ok('端の最大変位が 舌 + ワニ口 に一致', Math.abs(mx - (thin.tongue + thin.gator)) < 0.01,
         `${mx.toFixed(1)} mm`);
      /* ワニ口の «板厚方向の広がり»。表層だけがめくれるのではなく板厚を取る形になるか。
       * 決めるのは不均一変形係数 Δ で、Δ が大きいほど圧縮の円錐が芯へ届かず、
       * 芯の引張域が板厚の中央まで広がるので割れも深く入る。 */
      {
        const pw = [1, 2, 4, 8].map(d => R.gatorPow(d));
        ok('ワニ口のべき指数が Δ とともに下がる（深く入る）',
           pw[0] > pw[1] && pw[1] > pw[2] && pw[2] >= pw[3] && pw[0] <= 2 && pw[3] >= 0.8,
           pw.map((v, i) => `Δ${[1, 2, 4, 8][i]} → p ${v.toFixed(2)}`).join(' ／ '));
        // 厚板の Δ（既定ロットで 7.7）では板厚の内側半分でも半分以上開いていること
        const p8 = R.gatorPow(8), half = Math.pow(0.5, p8), old2 = Math.pow(0.5, 2);
        ok('厚板では板厚の «内側半分» でも大きく開く（表層だけではない）', half > 0.5 && half > old2 * 2,
           `芯から半分の位置で ${(half * 100).toFixed(0)} %（べき 2 なら ${(old2 * 100).toFixed(0)} %）`);
        /* 芯は «口が開かない» が、X には付いて行く（中は詰まっている）。開かないことは
         * 下の «あごは芯で動かない» が見ているので、ここでは «表面より奥で止まる» を見る。 */
        ok('芯は表面より奥で止まる（その差が口になる）',
           R.endOffset(0, 0, 100, 1000, 0, 0, p8) < R.endOffset(0, 0, 100, 1000, 1, 0, p8),
           `芯 ${R.endOffset(0, 0, 100, 1000, 0, 0, p8).toFixed(0)} mm / 表面 ${R.endOffset(0, 0, 100, 1000, 1, 0, p8).toFixed(0)} mm`);
        /* あごの上下の開き。割れは板厚中央の面で起き、上あごは上・下あごは下へ動く。
         * 割れの先端（zone）を支点に回るので、端へ向かって e² で増える。 */
        /* あごは «内側へ» 折れ込む。割れは板厚中央の面で起きるが、割れたあごは外へ開いた
         * ままにはならず、次にロールへ当たったところで押し戻されて中心側へ折れる。
         * だから端面の合計の厚みは板厚を «超えない»。 */
        const J = K.SLAB.OVERHANG.JAW_K, g = 300, z = 900, hh = 400;
        const top = R.endJaw(0, g, z, 1, hh), bot = R.endJaw(0, g, z, -1, hh), mid = R.endJaw(0, g, z, 0, hh);
        ok('あごが内側へ折れ込む（上は下へ・下は上へ・芯は動かない）',
           top < 0 && Math.abs(top + bot) < 1e-9 && mid === 0,
           `端面で 上 ${top.toFixed(0)} / 下 ${(-bot).toFixed(0)} / 芯 ${mid} mm（板厚 ${hh} mm）`);
        /* あごが開くのは «口» の中だけ。口の長さは gator·(1−CORE) で、その外（芯が
         * 付いて行っている側）は板厚ぶん詰まっているので開かない。 */
        const mouth = R.gatorMouth(g);
        ok('折れ込みは口の奥で 0、端面で最大（e² で増える）',
           R.endJaw(mouth, g, z, 1, hh) === 0 && Math.abs(R.endJaw(mouth / 2, g, z, 1, hh) - top / 4) < 1e-9,
           `口の奥 0 ／ 中間 ${R.endJaw(mouth / 2, g, z, 1, hh).toFixed(1)} ／ 端面 ${top.toFixed(1)} mm（口の長さ ${mouth.toFixed(0)} mm）`);
        ok('口の外（芯が付いて行っている側）では開かない', R.endJaw(mouth * 1.01, g, z, 1, hh) === 0,
           `口の長さ ${mouth.toFixed(0)} mm の外で 0`);
        /* 実機の端材は «中が詰まっていて、表裏の 2 枚が芯より少し先まで出て先端を作る»。
         * 芯が CORE の割合だけ付いて行くこと、口の長さがその差ぶんであることを縛る。 */
        {
          const gg = 300, zz = 900;
          const tip = R.endOffset(0, 0, gg, zz, 1, 0, 1);     // 表面の先端
          const core = R.endOffset(0, 0, gg, zz, 0, 0, 1);    // 芯の先端
          ok('ワニ口の中は詰まっている（芯も付いて行く）', core > gg * 0.5,
             `芯 ${core.toFixed(0)} mm / 表面 ${tip.toFixed(0)} mm（芯の追従 ${(core / tip * 100).toFixed(0)} %）`);
          ok('口の長さが «表面の先端 − 芯の先端» に一致する',
             Math.abs((tip - core) - R.gatorMouth(gg)) < 1e-9,
             `${(tip - core).toFixed(1)} mm`);
        }
        ok('ワニ口が出ないパスではあごも折れない', R.endJaw(0, 0, z, 1, hh) === 0, '0 mm');
        {
          /* いちばん大事な判定 —— 端面の «合計の厚み» が板厚を超えないこと。
           * 以前は折れ込みを外向きに «足して» いたため、端面が板厚の 1.5 倍に膨らんでいた
           * （h/2 ＋ 0.25h を上下）。実機の見え方と逆で、明確な誤りだった。 */
          const bad = [];
          for (const h of [530, 340, 190, 85, 40, 8]) for (const gg of [50, 300, 1e6]) {
            const yTop = h / 2 + R.endJaw(0, gg, z, 1, h);      // 上面の端面での位置
            const yBot = -h / 2 + R.endJaw(0, gg, z, -1, h);
            const tot = yTop - yBot;
            if (tot > h + 1e-9) bad.push(`板厚 ${h}・張り出し ${gg} で端面 ${tot.toFixed(1)} mm`);
            if (tot < 0) bad.push(`板厚 ${h}・張り出し ${gg} で端面が裏返る`);
          }
          ok('端面の合計の厚みが板厚を超えない（あごは内へ折れる）', bad.length === 0,
             bad.slice(0, 3).join(' ／ ') || `板厚 530 で端面 ${(530 + 2 * R.endJaw(0, 1e6, z, 1, 530)).toFixed(0)} mm（板厚の ${(1 + 2 * R.endJaw(0, 1e6, z, 1, 530) / 530).toFixed(2)} 倍）`);
          ok('折れ込みは板厚の半分で頭打ち（上下のあごが中心で重ならない）',
             Math.abs(R.endJaw(0, 1e6, z, 1, 200) + 200 * K.SLAB.OVERHANG.JAW_MAX) < 1e-9,
             `板厚 200 mm で片側 ${(-R.endJaw(0, 1e6, z, 1, 200)).toFixed(0)} mm 内へ`);
        }
      }
      A.bus.emit('CMD_RESET');
    }
  }

  /* ---------- スプリングバック（除荷で戻る曲率）---------- */
  {
    const al = K.ALLOYS.A5052, E = al.E * 1000, h = 130, kf = 60;
    const kE = 2 * kf / (E * h);                       // 降伏開始曲率
    ok('弾性域（κ ≤ κe）では反りが残らない', R.springback(kE * 0.999, h, kf, al) === 0,
       `κ/κe = 0.999 → 残る曲率 ${R.springback(kE * 0.999, h, kf, al)}`);
    const rr = [1.5, 2, 4, 8, 20];
    const rs = rr.map(r => R.springback(kE * r, h, kf, al) / kE);
    ok('κe をわずかに超えたところで連続に立ち上がる',
       R.springback(kE * 1.001, h, kf, al) >= 0 && R.springback(kE * 1.001, h, kf, al) < kE * 0.01,
       `κ/κe = 1.001 → ${(R.springback(kE * 1.001, h, kf, al) / kE).toExponential(2)} κe`);
    ok('残る曲率は与えた曲率に対して単調に増える', rs.every((v, i) => i === 0 || v > rs[i - 1]),
       rs.map((v, i) => `${rr[i]}→${v.toFixed(2)}`).join(' '));
    ok('残る曲率が与えた曲率を超えない', rr.every((r, i) => rs[i] < r),
       `最大 ${Math.max(...rs.map((v, i) => v / rr[i])).toFixed(3)} 倍`);
    ok('大きく曲げたときの戻り量が 1.5·κe に飽和する', Math.abs(20 - rs[4] - 1.5) < 0.01,
       `戻り ${(20 - rs[4]).toFixed(4)} κe（理論 1.5）`);
    ok('板が厚いほど戻る曲率が小さい（κe ∝ 1/h）',
       R.springback(3e-5, 300, kf, al) > R.springback(3e-5, 100, kf, al),
       `h=300: ${R.springback(3e-5, 300, kf, al).toExponential(2)} / h=100: ${R.springback(3e-5, 100, kf, al).toExponential(2)}`);
    ok('符号が保たれる', R.springback(-kE * 4, h, kf, al) === -R.springback(kE * 4, h, kf, al), '正負で対称');
  }

  /* ---------- 圧延の «体積保存»（クロップ前）----------
   * 板は塑性変形するだけなので体積は変わらない。噛み込み・尻抜けの途中で
   * 全圧下ぶん伸ばしていると、接触弧の長さぶん（Ld·(1−r)）が毎パス余計に伸びる。 */
  {
    A.bus.emit('CMD_RESET');
    await new Promise(r => setTimeout(r, 300));
    window.__startAuto(false);
    const rec = []; let last = -1, v0 = null, stop = false;
    window.__ff((p) => {
      const s = p.slab, m = p.mill;
      if (m.passIndex !== last) {
        last = m.passIndex;
        const V = s.thickness * s.width * s.length;
        if (v0 === null) v0 = V; else rec.push({ pass: m.passIndex + 1, err: V / v0 - 1 });
      }
      if (p.finish.scraps.length) stop = true;      // クロップが始まったら打ち切る
      return stop || p.finish.done || !!p.tripped;
    }, 120 * 3000, 0);
    const worst = rec.reduce((a, b) => (Math.abs(b.err) > Math.abs(a.err) ? b : a), { pass: 0, err: 0 });
    ok('圧延で体積が保存する（クロップ前、1 % 以内）', Math.abs(worst.err) < 0.01,
       `最大のずれ ${(worst.err * 100).toFixed(2)} %（第 ${worst.pass} パス）／ ${rec.length} パス`);
    ok('体積のずれがパスごとに積み上がらない（1 パスあたり 0.2 % 以内）',
       rec.every((q, i) => Math.abs(q.err - (i ? rec[i - 1].err : 0)) < 0.002),
       rec.map(q => (q.err * 100).toFixed(2)).join(' / ') + ' %');
    A.bus.emit('CMD_RESET');
  }

  /* ================= 幅反り（アンチクラスティック）とプロファイルカーブ値 ================= */
  {
    const nu = K.SHAPE.POISSON, W = 1330, h = 20;
    const kw = (k, w, hh) => R.anticlastic(k, w, hh);
    ok('幅反りは丈反りと逆向き（ポアソン効果）', kw(1e-5, W, h) < 0 && kw(-1e-5, W, h) > 0,
       `κ +1e-5 → ${kw(1e-5, W, h).toExponential(2)} ／ κ −1e-5 → ${kw(-1e-5, W, h).toExponential(2)}`);
    ok('幅反りの曲率は ν·κ を超えない', Math.abs(kw(1e-5, W, h)) <= nu * 1e-5 * (1 + 1e-9),
       `${Math.abs(kw(1e-5, W, h) / 1e-5).toFixed(3)} ≦ ν ${nu}`);
    // 細くて薄い（β 小）ほど完全に出る。広い／曲げが強い（β 大）ほど中央では消える
    const narrow = Math.abs(kw(1e-6, 300, 40) / 1e-6), wide = Math.abs(kw(1e-4, 2200, 8) / 1e-4);
    ok('板が広く曲げが強いほど幅反りは抑えられる（Searle 数）', narrow > wide * 5 && narrow > 0.9 * nu,
       `細く薄い ${narrow.toFixed(3)} / 広く強い ${wide.toExponential(2)}（ν ${nu}）`);
    ok('反り量は弦の 2 乗に比例する', Math.abs(R.chordRise(1e-5, 2000) / R.chordRise(1e-5, 1000) - 4) < 1e-9,
       `1 m → ${R.chordRise(1e-5, 1000).toFixed(3)} mm ／ 2 m → ${R.chordRise(1e-5, 2000).toFixed(3)} mm`);
    ok('曲率ゼロなら反り量もゼロ', R.chordRise(0, 1000) === 0 && kw(0, W, h) === 0);
    // 板の状態から «計器・記録が読む 1 式» が出ていること
    const wp = P.slab.warp;
    ok('板が反り・太りの読み取り値を 1 か所で持つ（SlabState.warp）',
       wp && ['len', 'wid', 'prof', 'R', 'kappa'].every(k2 => k2 in wp),
       `丈 ${wp.len.toFixed(2)} mm ／ 幅 ${wp.wid.toFixed(2)} mm ／ P ${wp.prof === null ? '–' : wp.prof.toFixed(4)}`);
    // プロファイルカーブ値: 中央が厚ければ 1 超、端が厚ければ 1 未満
    const sh = R.crown({ hIn: 30, hOut: 25, width: W, forceT: 1200, T: 420, alloy: P.slab.alloy });
    if (sh) {
      // 測定位置は «端から 50 mm» ちょうど（格子点に丸めず、隣り合う 2 点から線形に取る）
      ok('プロファイルカーブ値の測定位置が端から 50 mm ちょうど',
         Math.abs(W / 2 - sh.profZ - K.SHAPE.PROF_MM) < 1e-6,
         `端から ${(W / 2 - sh.profZ).toFixed(1)} mm ／ 格子の間隔 ${(W / (sh.n - 1)).toFixed(0)} mm`);
      ok('プロファイルカーブ値が «中央厚 ÷ その位置の厚み»', sh.profRatio > 0.9 && sh.profRatio < 1.1,
         `P ${sh.profRatio.toFixed(5)}`);
      ok('中央が厚ければ 1 を超える（中厚）', (sh.crownAbs > 0) === (sh.profRatio > 1),
         `クラウン ${sh.crownAbs.toFixed(0)} µm → P ${sh.profRatio.toFixed(5)}`);
    } else ok('プロファイルカーブ値が求まる', false, 'crown が解けない');
  }

  Res.failed = Res.checks.filter(c => !c.pass).length;
  return Res;
});

for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
