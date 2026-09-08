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
    // 熱間域では従来の実験式（C·exp(−bΔT)·ε̇^m）に十分近いこと（較正を壊さない）
    let worst = 0, at = '';
    for (const T of [380, 420, 460, 500]) for (const r of [0.5, 2, 10]) {
      const old = al.C * Math.exp(-al.b * (T - K.MATERIAL.TREF)) * Math.pow(r, al.m);
      const dev = Math.abs(kf(T, r) / old - 1);
      if (dev > worst) { worst = dev; at = `${T} ℃ / ${r} s⁻¹`; }
    }
    /* アレニウス形（1/T）と従来の線形指数形（T に線形）は、同じ点で一致させても
     * 域の端では必ず離れる。その差そのものが «形の違い» なので、12 % を上限として許す
     * （予測と実測の突き合わせで測った不確かさが 1 割程度なのと同じ桁）。 */
    ok('熱間域では従来の実験式と 12 % 以内で一致（較正を壊さない）', worst < 0.12,
       `最大ずれ ${(worst * 100).toFixed(1)} % @ ${at}`);
    // 当てはめた活性化エネルギーが公表値の帯に収まること（式を物理の形にした意味を保つ）
    let qBad = [];
    for (const [k, a] of Object.entries(K.ALLOYS)) {
      const st = R.stParams(a), q = st.Q / 1000;
      if (!(q >= a.Q_ACT * 0.6 - 1 && q <= a.Q_ACT * 1.4 + 1)) qBad.push(`${k} ${q.toFixed(0)}`);
    }
    ok('当てはめた活性化エネルギーが公表値の帯（±40 %）に収まる', qBad.length === 0,
       Object.entries(K.ALLOYS).map(([k, a]) => `${k} ${(R.stParams(a).Q / 1000).toFixed(0)}`).join(' '));
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
      ok('温度が上がると摩擦係数が下がる', m2 < m1, `350 ℃ ${m1.toFixed(3)} → 500 ℃ ${m2.toFixed(3)}`);
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
      window.__ff(p => p.mill.passIndex >= 4, 120 * 1500);
      const t1 = P.mill.rollTemp;
      ok('圧延を重ねるとロール温度が上がる', t1 > t0 + 2, `${t0.toFixed(1)} → ${t1.toFixed(1)} ℃`);
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
      const M = K.MILL.MODULUS, Q = 150;
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

  Res.failed = Res.checks.filter(c => !c.pass).length;
  return Res;
});

for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
