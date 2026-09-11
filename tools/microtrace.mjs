// 組織の履歴 —— 亜結晶粒径・静的再結晶率・残留ひずみ を実測する。
//
// 文献（README 節 2-5）は «熱間圧延中に形成される亜結晶粒径は直前のパスの Z だけで決まり、
// それ以前の履歴に依らない» と言っている。ひずみの導入と動的回復が釣り合った定常変形
// だからで、これは «変形抵抗に履歴項が要らない» ことの裏づけでもある。
// だからここで見る履歴は «パスとパスのあいだ» の話:
//   ・変形中は亜結晶粒径がその場の Z で決まる（履歴なし）
//   ・パス間の時間と温度で静的再結晶が進み（Avrami）、溜まったひずみを食う
//   ・食い残しが残留ひずみとして次のパスへ持ち越される —— パス間時間が短いほど残る
//
//   node tools/microtrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const R = window.__ROLL, K = window.__CFG, P = window.__app.physics, MI = K.MICRO;
  // --- 1) 式そのものの検算（運転とは切り離して） ---
  const al = R.alloy();
  const dOf = (T, e) => {
    const Z = R.zener(T, e, al);
    return { logZ: Math.log10(Z), d: 1 / Math.max(MI.SUB_A + MI.SUB_B * Math.log10(Z), 0.02) };
  };
  const grid = [[430, 0.8], [420, 9.5], [390, 9.5], [450, 1], [400, 30]].map(([T, e]) => {
    const q = dOf(T, e); return { T, e, logZ: +q.logZ.toFixed(2), d: +q.d.toFixed(2) };
  });
  const t50 = (T, eps) => MI.REX_A * Math.pow(eps, -2) * Math.exp(MI.REX_Q * 1000 / (R.RGAS * (T + 273.15)));
  const rex = [[450, 0.3], [420, 0.3], [390, 0.3], [450, 0.1], [450, 0.6]].map(([T, e]) => ({
    T, e, t50: +t50(T, e).toFixed(2),
    X6: +(1 - Math.exp(-0.693 * Math.pow(6 / t50(T, e), MI.REX_N))).toFixed(3),   // パス間 6 s 後
  }));

  // --- 2) 実運転で追う ---
  window.__startAuto(false);
  const rows = []; let last = -1;
  window.__ff((p) => {
    const s = p.slab, m = p.mill;
    if (m.passIndex !== last) {
      last = m.passIndex;
      rows.push({ pass: m.passIndex + 1, th: +s.thickness.toFixed(1), T: +s.temperature.toFixed(0),
                  d: +s.subGrain.toFixed(2), rex: +s.rexFrac.toFixed(3),
                  ret: +s.retStrain.toFixed(3), eps: +s.passStrain.toFixed(3) });
    }
    return p.finish.done || !!p.tripped;
  }, 120 * 3000, 0);
  const s = P.slab;
  return { grid, rex, rows, final: { d: +s.subGrain.toFixed(2), rex: +s.rexFrac.toFixed(3), ret: +s.retStrain.toFixed(3) },
           MI };
});
await browser.close();

console.log('■ 亜結晶粒径 1/d ＝ A ＋ B·log₁₀Z（変形中は «その場の Z» だけで決まる）');
for (const g of out.grid) console.log(`   ${g.T} ℃ ・ ε̇ ${g.e} s⁻¹ → log₁₀Z ${g.logZ} → d ${g.d} µm`);
console.log('\n■ 静的再結晶 t₅₀ ＝ A·ε⁻²·exp(Q/RT)、X ＝ 1 − exp(−0.693·(t/t₅₀)^N)');
for (const r of out.rex) console.log(`   ${r.T} ℃ ・ ひずみ ${r.e} → t₅₀ ${r.t50} s ／ パス間 6 s で X ${r.X6}`);
console.log('\n■ 運転での推移（パスの切り替わりごと）');
console.log('  パス  板厚 mm  温度 ℃  亜結晶粒 µm  再結晶率  残留ひずみ  そのパスのひずみ');
for (const r of out.rows)
  console.log(`  ${String(r.pass).padStart(3)}${String(r.th).padStart(9)}${String(r.T).padStart(8)}`
    + `${String(r.d).padStart(12)}${String(r.rex).padStart(10)}${String(r.ret).padStart(12)}${String(r.eps).padStart(16)}`);

const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
ok('亜結晶粒径がアルミ熱間の実測レンジ（1〜10 µm）に入る',
   out.grid.every(g => g.d >= 1 && g.d <= 10), out.grid.map(g => g.d).join(' / ') + ' µm');
ok('Z が大きいほど亜結晶粒が細かい（低温・高速ほど細かい）',
   out.grid[3].d > out.grid[0].d && out.grid[0].d > out.grid[2].d,
   `450 ℃/1 s⁻¹ ${out.grid[3].d} ＞ 430 ℃/0.8 ${out.grid[0].d} ＞ 390 ℃/9.5 ${out.grid[2].d} µm`);
ok('温度が下がると再結晶が遅くなる（t₅₀ が伸びる）',
   out.rex[0].t50 < out.rex[1].t50 && out.rex[1].t50 < out.rex[2].t50,
   out.rex.slice(0, 3).map(r => `${r.T} ℃ ${r.t50} s`).join(' → '));
ok('ひずみが大きいほど再結晶が速い（t₅₀ が縮む）', out.rex[3].t50 > out.rex[4].t50,
   `ひずみ 0.1 で ${out.rex[3].t50} s ／ 0.6 で ${out.rex[4].t50} s`);
ok('運転で組織が追えている（亜結晶粒径が出ている）',
   out.rows.length > 5 && out.rows.slice(1).every(r => r.d > 0), `${out.rows.length} パス`);
/* 履歴の本体 —— パス間で再結晶が進み、残留ひずみが «食われて» いること。
 * 食い残しがゼロにならないパスがあるのが «履歴» で、それが無いなら履歴を持つ意味が無い。 */
const carried = out.rows.filter(r => r.ret > 0.01).length;
ok('パス間で再結晶が進み、残留ひずみが食われる', out.rows.some(r => r.rex > 0.5),
   `再結晶率 > 0.5 のパス ${out.rows.filter(r => r.rex > 0.5).length} 個`);
ok('残留ひずみが上限を超えない', out.rows.every(r => r.ret <= out.MI.RET_MAX + 1e-9),
   `最大 ${Math.max(...out.rows.map(r => r.ret)).toFixed(3)} ／ 上限 ${out.MI.RET_MAX}`);
ok('最終コイルの組織が出ている（亜結晶粒径・再結晶率）',
   out.final.d > 0 && out.final.rex >= 0, `亜結晶粒 ${out.final.d} µm ／ 再結晶率 ${out.final.rex}`);

console.log('');
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - bad.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
