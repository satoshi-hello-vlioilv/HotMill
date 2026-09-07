// 幅方向の形状（クラウン・平坦度・幅広がり・据わり）の «実測» トレース。
//   node shapetrace.mjs
// 結果の数値ではなく «式が持つべき性質» を問う。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const R = window.__ROLL, K = window.__CFG, A = window.__app;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  const al = K.ALLOYS.A5052, w = 1500;
  const base = { width: w, hIn: 60, hOut: 45, T: 450, speedMpm: 120, bendT: 0,
                 rollTemp: K.MILL.ROLL_T0, wear: 0, tPass: 6, alloy: al };
  const F = (o) => R.solve(o.hIn, o.hOut, o.width, o.speedMpm, o.T, 0, o.alloy).forceTon;
  const run = (o) => R.crown({ ...base, ...o, forceT: F({ ...base, ...o }) });
  const A2 = window.__app;

  // 1) ロール系の応答演算子: 対称・零平均・一様荷重で中央が開く
  {
    const so = R.stackOps(w, R.contactStiff(3000));
    const n = so.n, G = so.G, ns = so.ns, i0 = so.g.i0;
    let sym = 0;
    for (let k = 0; k < ns; k++) for (let i = 0; i < n; i++)
      sym = Math.max(sym, Math.abs(G[k][i] - G[ns - 1 - k][n - 1 - i]));
    ok('ロール系の応答が左右対称', sym < 1e-18, `最大の非対称 ${sym.toExponential(2)}`);
    // 一様な板荷重 → 中央のギャップが開く（＝中央が厚くなる）
    const mid = i0 + ((ns - 1) >> 1);
    let ym = 0, ye = 0;
    for (let k = 0; k < ns; k++) { ym += G[k][mid]; ye += G[k][i0]; }
    ok('一様な板荷重で中央のギャップが開く', ym > ye, `中央 ${(ym * 1e3).toFixed(4)} / 端 ${(ye * 1e3).toFixed(4)} µm/(N/mm)`);
    // ベンディングは中央を閉じる
    ok('ベンディングは中央のギャップを閉じる', so.Hb[mid] < so.Hb[i0],
       `中央 ${(so.Hb[mid] * 1000).toFixed(2)} / 端 ${(so.Hb[i0] * 1000).toFixed(2)} µm/t`);
  }
  // 2) 接触剛性が実機の桁（1〜10 t/mm/mm）
  {
    const k1 = R.contactStiff(3000), k2 = R.contactStiff(9000);
    ok('WR–BUR 接触剛性が実機の桁（1〜10 t/mm per mm）', k1 / 9807 > 1 && k1 / 9807 < 10,
       `${(k1 / 9807).toFixed(2)} t/mm/mm（線荷重 3,000 N/mm）`);
    ok('接触剛性は荷重が高いほど硬い（対数的）', k2 > k1, `${(k1 / 9807).toFixed(2)} → ${(k2 / 9807).toFixed(2)}`);
  }
  // 3) クラウン: 荷重が高いほど中凸が強い / 板が厚いほどクラウン «率» は小さい
  {
    const a = run({ hIn: 60, hOut: 45 }), b = run({ hIn: 60, hOut: 30 });
    ok('圧下が大きい（荷重が高い）ほど中央が厚くなる', b.crownAbs > a.crownAbs,
       `45 mm: ${a.crownAbs.toFixed(1)} µm → 30 mm: ${b.crownAbs.toFixed(1)} µm`);
    ok('クラウンが実機の桁（0〜300 µm）', a.crownAbs > 0 && a.crownAbs < 300, `${a.crownAbs.toFixed(1)} µm`);
    let mw = 0, sw = 0;
    for (let i = 0; i < a.n; i++) { mw += a.x[i] * a.wt[i]; sw += a.wt[i]; }
    ok('板厚分布が（重み付き）零平均', Math.abs(mw / sw) < 1e-12, `${(mw / sw).toExponential(2)} mm`);
  }
  // 4) ベンディング: 正のベンディングはクラウンを減らす・単調
  {
    const c0 = run({ bendT: 0 }), c1 = run({ bendT: 80 }), c2 = run({ bendT: 160 });
    ok('ベンディングを掛けるとクラウンが減る', c1.crownAbs < c0.crownAbs && c2.crownAbs < c1.crownAbs,
       `0 t: ${c0.crownAbs.toFixed(1)} → 80 t: ${c1.crownAbs.toFixed(1)} → 160 t: ${c2.crownAbs.toFixed(1)} µm`);
    ok('ベンディングの効きが実機の桁（定格で数十 µm 以上）', c0.crownAbs - c2.crownAbs > 10,
       `${(c0.crownAbs - c2.crownAbs).toFixed(1)} µm`);
  }
  // 5) 熱クラウン・摩耗クラウンの向き（ロールが中凸になればギャップは «閉じる»）
  {
    const c0 = run({ rollTemp: K.MILL.ROLL_T0 }), c1 = run({ rollTemp: K.MILL.ROLL_T0 + 60 });
    ok('ロールが温まると板クラウンが減る（熱クラウン＝中凸）', c1.crownAbs < c0.crownAbs,
       `${c0.crownAbs.toFixed(1)} → ${c1.crownAbs.toFixed(1)} µm`);
    const c2 = run({ wear: 2e12 });
    ok('摩耗が進むと板クラウンが増える（中央が減る＝中凹）', c2.crownAbs > c0.crownAbs,
       `${c0.crownAbs.toFixed(1)} → ${c2.crownAbs.toFixed(1)} µm`);
  }
  // 6) 幅方向の温度: 端が冷たい・薄い板ほど強い
  {
    const zs = R.widthGrid(w).z.slice(R.widthGrid(w).i0, R.widthGrid(w).i1 + 1);
    const a = R.widthChill(zs, 45, w, 6, al), b = R.widthChill(zs, 10, w, 6, al);
    ok('幅方向は端がいちばん冷たい', a.prof[0] < a.prof[(a.prof.length - 1) >> 1], `端 ${a.prof[0].toFixed(1)} K`);
    ok('薄い板ほど端の冷えが強い', b.drop > a.drop, `45 mm: ${a.drop.toFixed(1)} K / 10 mm: ${b.drop.toFixed(1)} K`);
  }
  // 7) 平坦度: «クラウン率の変化» で決まる（比例クラウンなら平坦）
  {
    const c = run({});
    // 入側が同じクラウン率なら、どれだけクラウンが付いていても平坦になる
    const xIn = new Float64Array(c.x.length);
    for (let i = 0; i < xIn.length; i++) xIn[i] = c.x[i] * 60 / 45;
    const cp = run({ xIn });
    ok('比例クラウン（C/h 一定）なら平坦になる', Math.abs(cp.iUnit) < 1e-6 && cp.modeName === '平坦',
       `${cp.iUnit.toExponential(2)} I-unit / ${cp.modeName}`);
    ok('入側が平らならクラウンがそのまま伸び差になる', Math.abs(c.iUnit) > 1,
       `${c.iUnit.toFixed(1)} I-unit / ${c.modeName}`);
    ok('平坦度の符号が正しい（厚い側は伸びが小さい）', (c.iu[(c.n - 1) >> 1] < c.iu[0]) === (c.x[(c.n - 1) >> 1] > c.x[0]),
       `中央 x ${(c.x[(c.n - 1) >> 1] * 1000).toFixed(1)} µm / I ${c.iu[(c.n - 1) >> 1].toFixed(1)}`);
    ok('残留応力が零平均（板は 1 枚なので長さは揃う）',
       Math.abs(Array.from(c.sig).reduce((s, v) => s + v, 0)) < 1e-6,
       `${Array.from(c.sig).reduce((s, v) => s + v, 0).toExponential(2)} MPa`);
    ok('平坦度の判定名が出る', ['平坦', '中伸び', '耳伸び'].includes(c.modeName), `${c.modeName} / ${c.iUnit.toFixed(1)} I-unit`);
    ok('座屈応力が正で有限', c.sigCr > 0 && Number.isFinite(c.sigCr), `σcr ${c.sigCr.toFixed(1)} MPa / σ圧縮 ${c.sigComp.toFixed(1)} MPa`);
  }
  // 8) 幅広がり: 厚いパスほど広がる・薄いパスではほぼ 0
  {
    const s1 = R.spread(1500, 536, 455, R.contactLength(536, 455));
    const s2 = R.spread(1500, 14.3, 10.9, R.contactLength(14.3, 10.9));
    ok('厚いパスは幅が広がる', s1 > 0, `536→455 mm: +${s1.toFixed(2)} mm`);
    ok('薄いパスではほぼ広がらない', s2 < s1 / 10, `14.3→10.9 mm: +${s2.toFixed(4)} mm`);
  }
  // 9) 据わり（片側接触）: 平らな中央があれば傾かない／両端反りで支持が狭まると傾く
  {
    const flat = [];
    for (let i = 0; i <= 20; i++) flat.push({ u: i * 500, b: i < 4 || i > 16 ? Math.pow(Math.abs(i - 10) - 6, 2) * 20 : 0 });
    const p1 = R.restPose(flat, 5000);
    ok('中央が平らなら傾かない', Math.abs(p1.tilt) < 1e-9, `傾き ${(p1.tilt * 1000).toFixed(3)} mm/m ／ 接地 ${p1.seat.toFixed(0)} mm`);
    // 両端が強く反り、左右で反り量が違う板 → 支持は 1〜2 点になり、重心側へ傾く
    const bow = [];
    for (let i = 0; i <= 20; i++) { const t = (i - 10) / 10;
      bow.push({ u: i * 500, b: 300 * t * t * (t < 0 ? 1 : 0.6) }); }
    const p2 = R.restPose(bow, 5200);
    ok('両端が反って支持が狭まると板は傾く', Math.abs(p2.tilt) > 1e-6 || p2.seat < 2000,
       `傾き ${(p2.tilt * 1000).toFixed(2)} mm/m ／ 接地区間 ${p2.seat.toFixed(0)} mm ／ 接点 ${p2.contacts.length}`);
    // 食い込まないこと（片側接触の条件）
    let pen = 0;
    for (const q of bow) pen = Math.min(pen, q.b + p2.lift + p2.tilt * q.u);
    ok('どのローラにも食い込まない（接触は押すだけ）', pen > -1e-6, `最小すき間 ${pen.toExponential(2)} mm`);
  }
  return { checks };
});
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
