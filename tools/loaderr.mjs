// 圧延荷重の «精度» を測る評価器。
//
// 「荷重をもっと当てたい」と言うとき、実は 3 つの別の話が混ざっている。ここはそれを分けて数にする。
//
//   ① どれだけ外れているか … 実機の荷重帯に対して、本アプリがどこにいるか
//   ② どちらへ外れているか … 外れ方が Ld/h̄（接触弧 ÷ 平均板厚）と連動しているか。
//                            連動していれば «倍率のずれ» ではなく «形のずれ» で、
//                            変形抵抗の絶対値（LN_A）をいくら動かしても直らない
//   ③ どこまで測れるか     … 実機データが «帯» でしか無いので、荷重を一様に何 % ずらしても
//                            判定は通ってしまう。その幅より細かい改善は検証できない
//
// そのうえで «逆問題» を出す —— 荷重を ±5 % に収めたいなら、各量をどれだけの精度で
// 知っている必要があるか。感度の逆数なので、ここには推定が一切入らない。
//
// 【なぜ要るか】tools/sensload.mjs の «影響度» は «感度 × 実機でその量が振れる幅» で、
// 板幅と圧下量が上位に来る。しかし板幅も圧下量も «こちらが決めている既知の量» なので
// 荷重の «誤差» にはならない。誤差になるのは «知らない量»（μ・変形抵抗の絶対値・
// 接触弧の中の温度・残留ひずみ）だけ。影響度の順に手を入れても精度は上がらない ——
// この評価器はそこを分けるために作った。
//
// 【測り方】まず実機スケジュールを 1 本ずつ «運転» し（tools/reallot.mjs の runReal）、
// 帯との比較にはそこで出た «パス平均の荷重»（calib が判定に使うのと同じ量）を使う。
// 掃引（荷重を何 % ずらすと判定が落ちるか）だけは 1 点 1 ms の定常解に切り替え、
// そのとき «そのパスの実測入側温度» を与える。
//
// ここは一度まちがえた —— 定常解を «持ちかかり温度一定» で解くと、後段ほど板が冷える
// ぶんを取りこぼして薄いパスの荷重が低く出る（実測: 16 → 8 mm で 1,992 t、
// 実際の運転は 2,455 t）。«薄いパスほど荷重が足りない» という結論がその取りこぼしから
// 出てしまうので、温度はパスごとの実測値を使う。
//
//   node tools/loaderr.mjs
import { openApp, installHelpers } from './harness.mjs';
import { REAL, LOT_A1100, runReal } from './reallot.mjs';

const TARGET = 5;                       // 逆問題で置く «当てたい精度» [%]
const flat = (L) => ({ lot: L.lot, gaps: L.gaps, seg: L.seg,
                       speedTable: L.gaps.map((_, i) => L.speed(i)) });

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

/* 実機スケジュールを «運転» して、パスごとの入側温度とパス平均荷重を取る。
 * 帯との比較はこの «運転の平均» で行う —— calib.mjs が判定に使うのと同じ量。 */
const RUN = {};
for (const [key, L] of Object.entries({ A5052: REAL, A1100: LOT_A1100 })) {
  const r = await runReal(page, { real: L });
  RUN[key] = r.passes.map(p => ({ no: p.no, tIn: p.tIn, fAvg: p.fAvg, fMax: p.fMax }));
}

const out = await page.evaluate(({ LOTS, RUN, TARGET }) => {
  const R = window.__ROLL, K = window.__CFG;

  /** そのロットの全パスを定常の解析解で解く。温度は «そのパスの実測入側温度»。
   *  lnA / muScale で «ずらした» 解も作れる（掃引用）。
   *  meas を渡すと、帯と比べる荷重を «運転のパス平均» に差し替える。 */
  const solveLot = (L, opt = {}) => {
    const d = L.lot, al = K.ALLOYS[d.alloy], a0 = al.LN_A, run = L.run;
    if (opt.lnA != null) { al.LN_A = opt.lnA; al._st = null; }
    let h = d.cast - 2 * d.scalp;
    const rows = L.gaps.map((g, i) => {
      const v = L.speedTable[i], T = run[i]?.tIn ?? d.temp;
      const r = R.solve(h, g, d.width, v, T, 0, al, null, opt.muScale ?? 1);
      const row = { no: i + 1, hIn: h, hOut: g, v, T, kf: r.kf, mu: r.mu, Ld: r.Ld,
                    ldh: r.Ld / ((h + g) / 2),
                    Fst: r.forceTon, Fmeas: run[i]?.fAvg ?? 0, Fmax: run[i]?.fMax ?? 0 };
      /* 帯と比べるのは «運転の平均»。掃引のときは定常解を «倍率» として重ねる
       * （運転を何百回も回せないため。倍率の効きは両者で同じ ∂lnF/∂lnkf ≒ 1）。 */
      row.F = opt.lnA != null && row.Fmeas > 0
            ? row.Fmeas * (r.forceTon / (L.base0?.[i] ?? r.forceTon))
            : (row.Fmeas > 0 ? row.Fmeas : r.forceTon);
      h = g; return row;
    });
    if (opt.lnA != null) { al.LN_A = a0; al._st = null; }
    return rows;
  };

  /** 帯の «どこにいるか»。0 で下限、1 で上限、負なら下へ外れている。 */
  const pos = (F, [lo, hi]) => (F - lo) / (hi - lo);
  /** calib と同じ除き方 —— 初パス（軽圧下の頭出し）は帯の外で当然なので除く。 */
  const segRows = (rows, sg) => rows.slice(sg.a, sg.b).filter((r, i) => !(sg.a === 0 && i === 0));

  const lots = {};
  for (const [key, L] of Object.entries(LOTS)) {
    L.run = RUN[key] || [];
    L.base0 = null;
    const rows = solveLot(L);
    L.base0 = rows.map(r => r.Fst);              // 掃引の基準（無摂動の定常解）
    const segs = L.seg.map((sg) => {
      const rs = segRows(rows, sg), Fs = rs.map(r => r.F);
      const lo = Math.min(...Fs), hi = Math.max(...Fs);
      return { name: sg.name, band: sg.band, n: rs.length, fLo: lo, fHi: hi,
               posLo: pos(lo, sg.band), posHi: pos(hi, sg.band),
               ldhLo: Math.min(...rs.map(r => r.ldh)), ldhHi: Math.max(...rs.map(r => r.ldh)),
               /* 実機の帯が «区間内の最小と最大» なら、本アプリの振れ幅も同じだけ要る。
                * ただし 1 パスしか無い区間では «パス平均» は 1 点しか出ないので、帯の幅は
                * パスの中の振れ（頭・尻・噛み込みの峰）を読んだものと解するほかない ——
                * そこは最大荷重まで含めて比べる。«帯が何の値か»（平均かピークか）は
                * 実機に確認が要る（README の残件«荷重帯が何の読みか»）。 */
               swingReal: sg.band[1] / sg.band[0],
               swingApp: rs.length > 1 ? hi / lo : Math.max(...rs.map(r => r.Fmax)) / lo,
               swingHow: rs.length > 1 ? 'パス平均の最小〜最大' : 'そのパスの 平均〜最大',
               out: rs.filter(r => r.F < sg.band[0] * 0.9 || r.F > sg.band[1] * 1.1)
                      .map(r => ({ no: r.no, hOut: r.hOut, F: r.F })) };
    });
    /* --- ② 外れ方が Ld/h̄ と連動しているか。帯の中の位置を ln(Ld/h̄) に回帰する。
     *        傾きが負なら «薄いパスほど下へ寄る» ＝ 形のずれ。 */
    const pts = [];
    for (const sg of L.seg) for (const r of segRows(rows, sg)) pts.push({ x: Math.log(r.ldh), y: pos(r.F, sg.band) });
    const n = pts.length, sx = pts.reduce((a, p) => a + p.x, 0), sy = pts.reduce((a, p) => a + p.y, 0);
    const sxx = pts.reduce((a, p) => a + p.x * p.x, 0), sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);

    /* --- ③ 帯で縛れる幅。荷重を一様に s 倍したとき、calib の判定
     *        （全パスが [lo×0.9, hi×1.1] に入る）が通る s の範囲を二分で探す。
     *        一様な倍率は変形抵抗の絶対値 LN_A で作る —— Sellars–Tegart は
     *        sinh(ασ)^n ＝ Z/A なので、lnA を n·ln(s) 動かすと σ がおよそ s 倍になる。 */
    const al = K.ALLOYS[L.lot.alloy], a0 = al.LN_A, nExp = al.N_EXP;
    const passes = (s) => {
      const rs = solveLot(L, { lnA: a0 - nExp * Math.log(s) });
      return L.seg.every(sg => segRows(rs, sg)
        .every(r => r.F >= sg.band[0] * 0.9 && r.F <= sg.band[1] * 1.1));
    };
    const edge = (dir) => {
      let okS = 1, ngS = null;
      for (let i = 1; i <= 60; i++) { const s = 1 + dir * 0.02 * i; if (!passes(s)) { ngS = s; break; } okS = s; }
      if (ngS === null) return null;                       // 1.2 倍まで振っても通る＝縛れていない
      for (let i = 0; i < 24; i++) { const m = (okS + ngS) / 2; if (passes(m)) okS = m; else ngS = m; }
      return okS;
    };
    const base = passes(1);
    lots[key] = { name: key, base, segs, slope, rows,
                  sUp: base ? edge(+1) : null, sDn: base ? edge(-1) : null };
  }

  /* --- ④ 逆問題。荷重を ±TARGET % に収めるには各量をどれだけの精度で知る必要があるか。
   *        必要精度 ＝ 目標 ÷ 感度。感度は中心差分で取るので、ここに推定は入らない。 */
  const need = [];
  {
    const L = LOTS.A5052, d = L.lot, al = K.ALLOYS[d.alloy], rows = solveLot(L);
    for (const i of [1, 10, 21, 22]) {            // 厚板段の頭・中間・26→16・巻取
      const r = rows[i], hIn = r.hIn, hOut = r.hOut, T0 = r.T;
      const F = (o = {}) => R.solve(hIn, o.hOut ?? hOut, d.width, o.v ?? r.v, o.T ?? T0,
                                    0, al, null, o.muScale ?? 1).forceTon;
      const dln = (mk, e = 0.05) => Math.log(F(mk(1 + e)) / F(mk(1 - e))) / Math.log((1 + e) / (1 - e));
      const eMu = dln(k => ({ muScale: k }));
      const eH = dln(k => ({ hOut: hIn - (hIn - hOut) * k }));
      const eKf = (() => { const a0 = al.LN_A, dd = 0.05 * al.N_EXP;
        al.LN_A = a0 - dd; al._st = null; const up = R.solve(hIn, hOut, d.width, r.v, T0, 0, al);
        al.LN_A = a0 + dd; al._st = null; const dn = R.solve(hIn, hOut, d.width, r.v, T0, 0, al);
        al.LN_A = a0; al._st = null;
        return Math.log(up.forceTon / dn.forceTon) / Math.log(up.kf / dn.kf); })();
      const eT = Math.log(F({ T: T0 + 15 }) / F({ T: T0 - 15 })) / 30 * 100;   // [%/K]
      need.push({ no: r.no, hIn, hOut, ldh: r.ldh, T: T0, eMu, eKf, eT, eH,
                  nMu: TARGET / Math.abs(eMu), nKf: TARGET / Math.abs(eKf),
                  nT: TARGET / Math.abs(eT), nDh: TARGET / Math.abs(eH) });
    }
  }
  return { lots, need };
}, { LOTS: { A5052: flat(REAL), A1100: flat(LOT_A1100) }, RUN, TARGET });
await browser.close();

/* ------------------------------ 出力 ------------------------------ */
const checks = [];
const ok = (name, pass, got, ref = false) => checks.push({ name, pass: !!pass, got, ref });
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;

for (const L of Object.values(out.lots)) {
  console.log(`\n■ ${L.name} ロット —— 実機の荷重帯に対する位置（0 ＝ 帯の下限・1 ＝ 上限）`);
  console.log('  区間                        実機の帯 t      本アプリ t     帯の中の位置    Ld/h̄     振れ幅 実機/本アプリ');
  console.log('  （振れ幅は パスが複数なら «パス平均の最小〜最大»、1 パスなら «そのパスの 平均〜最大»）');
  for (const s of L.segs) {
    const mark = s.out.length ? '★' : '  ';
    console.log(`  ${mark}${s.name.padEnd(22)} ${String(s.band[0]).padStart(5)}〜${String(s.band[1]).padStart(5)}`
      + `  ${s.fLo.toFixed(0).padStart(5)}〜${s.fHi.toFixed(0).padStart(5)}`
      + `   ${s.posLo.toFixed(2).padStart(5)}〜${s.posHi.toFixed(2).padStart(5)}`
      + `  ${s.ldhLo.toFixed(2).padStart(5)}〜${s.ldhHi.toFixed(2).padStart(5)}`
      + `   ${s.swingReal.toFixed(2)} 倍 / ${s.swingApp.toFixed(2)} 倍`);
    for (const r of s.out)
      console.log(`      → 帯の外: パス ${r.no}（出側 ${r.hOut} mm）${r.F.toFixed(0)} t`);
  }
  console.log(`  帯の中の位置 vs ln(Ld/h̄) の傾き: ${L.slope.toFixed(3)}`
    + `（負 ＝ 薄いパスほど下へ寄る ＝ «倍率» ではなく «形» のずれ）`);
}

console.log('\n■ 実機データで «縛れる» 幅 —— 荷重を一様に何 % ずらすと判定が落ちるか');
for (const L of Object.values(out.lots)) {
  if (!L.base) { console.log(`  ${L.name}: いまの荷重が既に帯から外れているので測れない`); continue; }
  const up = L.sUp === null ? '+20 % 超' : `+${((L.sUp - 1) * 100).toFixed(1)} %`;
  const dn = L.sDn === null ? '−20 % 超' : `${((L.sDn - 1) * 100).toFixed(1)} %`;
  console.log(`  ${L.name}: ${dn} 〜 ${up} の範囲なら帯の判定を通る`);
}

console.log(`\n■ 逆問題 —— 荷重を ±${TARGET} % に収めるには、各量をどれだけの精度で知る必要があるか`);
console.log('  パス（出側・入側温度）  Ld/h̄    摩擦 μ      変形抵抗 kf   温度        圧下量 Δh');
for (const n of out.need)
  console.log(`  P${String(n.no).padStart(2)} ${String(n.hOut).padStart(4)} mm ${n.T.toFixed(0).padStart(4)} ℃ ${n.ldh.toFixed(2).padStart(5)}`
    + `   ±${n.nMu.toFixed(1).padStart(5)} %   ±${n.nKf.toFixed(1).padStart(4)} %`
    + `     ±${n.nT.toFixed(1).padStart(4)} K    ±${n.nDh.toFixed(1).padStart(4)} %`);
console.log('  （感度 ∂lnF/∂lnX の逆数。μ と kf は «いま推定で置いている量» なので、'
  + 'この精度で知らないかぎり荷重はこの幅で外れる）');

/* ---- 合否。測定そのものが効いているかだけを数え、見つかった «ずれ» は参考で出す ---- */
const A5 = out.lots.A5052, A1 = out.lots.A1100;
ok('較正の基準ロット（A5052）は全区間で帯に入る', A5.base,
   A5.base ? '全区間 OK' : A5.segs.flatMap(s => s.out.map(r => `P${r.no} ${r.F.toFixed(0)} t`)).join(', '));
ok('荷重を一様にずらせば必ず帯から外れる（測定が効いている）',
   A5.sUp !== null || A5.sDn !== null,
   `上 ${A5.sUp === null ? '—' : pc(A5.sUp - 1)} ／ 下 ${A5.sDn === null ? '—' : pc(A5.sDn - 1)}`);
ok('必要精度は感度の逆数として正の有限値になる',
   out.need.every(n => n.nMu > 0 && n.nKf > 0 && n.nT > 0 && Number.isFinite(n.nMu)),
   out.need.map(n => `P${n.no} μ±${n.nMu.toFixed(1)} %`).join(' / '));
/* 摩擦丘の領域（Ld/h̄ ≥ 1）では薄いパスほど μ が効く。Ld/h̄ < 1 の厚板段は Orowan の不均一変形で
 * μ が ϖ(a) を通して逆向きにも効く（∂lnF/∂lnμ ≈ −0.09、tools/sensload.mjs）ので、単調ではない。 */
const hill = out.need.filter(n => n.ldh >= 1);
ok('摩擦丘の領域（Ld/h̄ ≥ 1）では薄いパスほど μ の必要精度が厳しい',
   hill.length >= 2 && hill.every((n, i, a) => i === 0 || n.nMu <= a[i - 1].nMu * 1.001),
   out.need.map(n => `Ld/h̄ ${n.ldh.toFixed(2)}→±${n.nMu.toFixed(1)} %`).join('  '));
ok('（参考）A1100 ロットの巻取パスが帯の下限を割る', A1.base,
   A1.base ? '帯に入る' : A1.segs.flatMap(s => s.out.map(
     r => `P${r.no} 出側 ${r.hOut} mm ${r.F.toFixed(0)} t（帯 ${s.band[0]}〜${s.band[1]} t）`)).join(' / '), true);
/* 傾きが 0 なら «倍率» のずれだけ（LN_A で直せる）、負なら «形» のずれ（LN_A では直らない）。
 * 実測: A5052 はほぼ 0 ＝ 形は合っている。A1100 は負 ＝ 薄いパスほど足りない。 */
ok('（参考）外れ方が Ld/h̄ と連動しているか（0 なら倍率のずれ・負なら形のずれ）',
   Math.abs(A5.slope) < 0.05 && A1.slope < -0.05,
   `A5052 ${A5.slope.toFixed(3)}（倍率のずれのみ）／ A1100 ${A1.slope.toFixed(3)}（形のずれ）`, true);
ok('（参考）区間内で荷重がどれだけ振れるか（実機の帯 / 本アプリ）',
   true, Object.values(out.lots).flatMap(L => L.segs.map(
     s => `${s.name} 実機 ${s.swingReal.toFixed(2)} 倍 / 本アプリ ${s.swingApp.toFixed(2)} 倍`)).join('  '), true);

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}`
  + `、参考 ${nRef} 件)`);
process.exit(bad.length ? 1 : 0);
