// 長手方向の板厚変動（X 線板厚計が読むもの）と、その計器そのものを検査する評価器。
//
// なぜ要るか: «実績のログがきれいすぎる» という不具合は、画面を見ても分からない。
// 分かるのは «数字の散らばりを測ったとき» だけなので、ここで機械に測らせる。
//
// 見るのは 3 つ。
//   ① 振れの大きさ —— 熱間圧延の実力は ±50 µm（3σ）。ゼロでもなく、大き過ぎもしないこと。
//   ② 振れの中身 —— 偏芯（ロール 1 回転 ＝ π・D の波長）が効いていること。
//      «ただの白色雑音» を足しただけなら、偏芯を切っても振れは減らない。切って減ることを見る。
//   ③ 計器 —— 入側 1 基・出側 2 基（固定型・走査型）が、サイドガイドとサイドトリマーの
//      あいだの隙間に、テーブルのローラを抜いた所へ据わっていること。読みが実厚と
//      «測定ノイズと輸送遅れのぶんだけ» 違うこと。走査型が板幅の中を往復すること。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, S = K.SCALE, T = window.__T;
  const R = { checks: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: String(d) });
  const st = a => { const m = a.reduce((x, y) => x + y, 0) / a.length;
                    return { m, sd: Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) }; };

  /* ---------- ① 計器の «現物»（3D）------------------------------------------ */
  W.scene.updateMatrixWorld(true);
  const box = o => { const b = new T.Box3().setFromObject(o);
                     return { x: [b.min.x / S, b.max.x / S], y: [b.min.y / S, b.max.y / S], z: [b.min.z / S, b.max.z / S] }; };
  const units = W.guideView.xray;
  ok('X 線板厚計が 3 基（入側 1・出側 2）', units.length === 3, units.map(u => u.unit.id).join('/'));
  ok('出側の 1 基だけが走査型', units.filter(u => u.unit.scan).length === 1,
     units.filter(u => u.unit.scan).map(u => u.unit.name).join());
  const F = K.FLIP;
  const entry = units.filter(u => u.unit.x * F < 0), exit = units.filter(u => u.unit.x * F > 0);
  ok('入側 1 基・出側 2 基', entry.length === 1 && exit.length === 2, `入側 ${entry.length} / 出側 ${exit.length}`);

  /* 据付位置: サイドガイド架構（正準 |x| 2,450〜4,350）の外、サイドトリマー架構より手前。
   * 正準 X（＝ CONFIG の値）で見る。 */
  const G = K.TABLE.GUIDE, gEnd = G.X + G.LEN / 2;
  const trimX = Math.abs(K.TRIMMER.X);
  for (const u of units) {
    const cx = Math.abs(u.unit.x);
    ok(`${u.unit.name}: サイドガイド架構（|x| ≤ ${gEnd}）の外側`, cx > gEnd, `|x| = ${cx}`);
    ok(`${u.unit.name}: サイドトリマー架構（|x| ${trimX} 前後）に掛からない`, cx < trimX - 400, `|x| = ${cx}`);
  }
  // テーブルのローラが «抜いてある»（下側の検出器が入る隙間）
  const rollXs = window.__LAYOUT.rolls().filter(r => !r.split).map(r => r.x);
  for (const u of units) {
    const near = Math.min(...rollXs.map(x => Math.abs(x - u.unit.x)));
    ok(`${u.unit.name}: 直下のテーブルローラが抜いてある（最寄り ${near.toFixed(0)} mm）`,
       near >= K.XRAY.SLOT / 2, near.toFixed(0));
  }
  // 線源（上）と検出器（下）が板を挟んで向かい合う
  for (const u of units) {
    const src = u.head.children.find(c => /線源/.test(c.name)), det = u.head.children.find(c => /検出器/.test(c.name));
    const bs = box(src), bd = box(det);
    ok(`${u.unit.name}: 線源が板の上・検出器が板の下`, bs.y[0] > K.MILL.PASS_LINE && bd.y[1] < K.MILL.PASS_LINE,
       `線源 y ${bs.y[0].toFixed(0)} / 検出器 y ${bd.y[1].toFixed(0)} / パスライン ${K.MILL.PASS_LINE}`);
    ok(`${u.unit.name}: 線源と検出器が同じ横位置で向かい合う`, Math.abs((bs.z[0] + bs.z[1]) / 2 - (bd.z[0] + bd.z[1]) / 2) < 5,
       `Δz ${(((bs.z[0] + bs.z[1]) - (bd.z[0] + bd.z[1])) / 2).toFixed(1)} mm`);
  }
  // モニタ AGC の輸送遅れは «現物の据付位置» から取れている（出どころが 1 つ）
  ok('モニタ AGC の輸送距離が 出側 固定型 の据付位置と一致',
     Math.abs(K.AGC.XRAY_X - Math.abs(K.XRAY.UNITS.find(g => g.id === 'EXIT').x)) < 1,
     `${K.AGC.XRAY_X} mm`);

  /* ---------- ② 運転して長手の振れを測る ------------------------------------ */
  const runOnce = () => {
    A.reset ? A.reset() : null;
    window.__startAuto(false);
    const trace = [];
    window.__ff(p => {
      const m = p.mill, s = p.slab;
      if (s.inBite && s.biteFill > 0.99 && m.passIndex >= 0)
        trace.push({ pass: m.passIndex + 1, t: p.log.lot ? p.log.lot.t : 0, hd: s.hDeliv,
                     x: s.dir > 0 ? s.xMax : s.xMin, v: Math.abs(m.currentSpeed),
                     ecc: m.ecc, hx: m.gauge.EXIT, hs: m.gauge.SCAN, he: m.gauge.ENTRY, sz: m.scanZ });
      return m.passIndex < 0 && p.log.passes.length >= K.SCHEDULE.length;
    }, 120 * 4000);
    return trace;
  };
  const tr = runOnce();
  const byPass = {};
  for (const r of tr) (byPass[r.pass] ??= []).push(r);
  // 仕上げ側のパス（薄くなってから）を «実力» の判定対象にする
  const finishing = Object.keys(byPass).map(Number).filter(k => k >= K.SCHEDULE.length - 10 && k < K.SCHEDULE.length);
  const band = [];
  for (const k of finishing) {
    const a = byPass[k]; if (a.length < 200) continue;
    const mid = a.slice(a.length * 0.15 | 0, a.length * 0.85 | 0);
    const s = st(mid.map(r => r.hd));
    band.push({ pass: k, n: mid.length, mean: +s.m.toFixed(3), sd: +(s.sd * 1000).toFixed(1) });
  }
  R.band = band;
  const sds = band.map(b => b.sd), avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const m3 = avg(sds) * 3, max3 = Math.max(...sds) * 3;
  ok('長手の板厚が «振れて» いる（1 本の線ではない）', sds.every(v => v > 4), `σ ${sds.join('/')} µm`);
  /* 実機の実力 ±50 µm は «その辺りに収まる» という意味の数字で、1 パスも外さない上限ではない。
   * 平均がその桁に乗っていること、どのパスも大きく外れないことの 2 本で縛る。
   * 厚いパスほど絶対値の振れは大きい（偏芯はギャップの振れなので板厚に依らない）。 */
  ok(`振れの平均が実機の実力（±50 µm ＝ 3σ）の桁に乗る`, m3 >= 35 && m3 <= 55,
     `3σ 平均 ${m3.toFixed(0)} µm ／ 各パス ${sds.map(v => (v * 3).toFixed(0)).join('/')}`);
  ok('どのパスも実力から大きく外れない（3σ ≤ 70 µm）', max3 <= 70, `3σ 最大 ${max3.toFixed(0)} µm`);
  ok('振れが実機の実力より大きく下回らない（きれい過ぎない）', Math.min(...sds) * 3 >= 25,
     `3σ 最小 ${(Math.min(...sds) * 3).toFixed(0)} µm`);

  /* 記録の分解能。0.01 mm 刻みだとログが «階段» になり、±50 µm が量子化に埋もれる。
   * 見るのは «隣り合う値の最小の差» —— 0.01 mm 刻みならそこが 0.01 で頭打ちになる。 */
  const S2 = P.log.series.filter(p => p.pass === band.at(-1).pass);
  const lv = [...new Set(S2.map(p => p.hd))].sort((a, b) => a - b);
  let minStep = Infinity;
  for (let i = 1; i < lv.length; i++) minStep = Math.min(minStep, lv[i] - lv[i - 1]);
  ok('ログの板厚が 1 µm 刻みで残っている（0.01 mm の階段ではない）', minStep <= 0.0021,
     `最小の刻み ${(minStep * 1000).toFixed(1)} µm ／ ${lv.length} 段 / ${S2.length} 点`);

  /* ---------- ③ 振れの中身が «偏芯» であること ------------------------------ */
  /* 偏芯はロール 1 回転で 1 周する。板の進み方向の波長は π・D。
   * いちばん長いパスで自己相関を取り、π・D_BUR の所に山が立つことを見る。 */
  /* 最終パスは巻取パスで、張力と巻き径の効果が乗って偏芯が埋もれる。可逆パスのうち
   * いちばん長いもの（＝周期が何回も入るもの）で見る。 */
  const cand = Object.keys(byPass).map(Number).filter(k => k < K.SCHEDULE.length);
  const longest = cand.sort((a, b) => byPass[b].length - byPass[a].length)[0];
  const a0 = byPass[longest], mid0 = a0.slice(a0.length * 0.2 | 0, a0.length * 0.8 | 0);
  // 材料の «進んだ距離» で等間隔に並べ直す（速度が変わるので時間軸では波長が測れない）
  const xs = mid0.map(r => Math.abs(r.x)), hs = mid0.map(r => r.hd);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), N = 2048, dx = (x1 - x0) / (N - 1);
  const grid = new Float64Array(N);
  { let j = 0; for (let i = 0; i < N; i++) { const xt = x0 + i * dx;
      while (j < xs.length - 2 && xs[j + 1] < xt) j++; grid[i] = hs[j]; } }
  /* AGC のゆっくりした追い込み（数十秒）を引く。引かないと自己相関が «長い坂» に
   * 支配されて、偏芯の山（数 m 周期）が見えない。窓は偏芯の波長の 2 倍。 */
  { const win = Math.max(4, Math.round(Math.PI * P.mill.brDia * 2 / dx));
    const cs = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) cs[i + 1] = cs[i] + grid[i];
    const sm = new Float64Array(N);
    for (let i = 0; i < N; i++) { const a = Math.max(0, i - win), b = Math.min(N, i + win + 1);
      sm[i] = (cs[b] - cs[a]) / (b - a); }
    for (let i = 0; i < N; i++) grid[i] -= sm[i]; }
  const g = st([...grid]); for (let i = 0; i < N; i++) grid[i] -= g.m;
  const acf = lag => { let s = 0, n = 0; for (let i = 0; i + lag < N; i++) { s += grid[i] * grid[i + lag]; n++; }
                       return n ? s / n / (g.sd * g.sd) : 0; };
  const lamBR = Math.PI * P.mill.brDia, lamWR = Math.PI * P.mill.wrDia;
  const peakNear = lam => { const c = Math.round(lam / dx); let best = -2, at = 0;
    for (let l = Math.max(2, c - Math.round(c * 0.18)); l <= c + Math.round(c * 0.18) && l < N / 2; l++)
      if (acf(l) > best) { best = acf(l); at = l * dx; }
    return { r: best, lam: at }; };
  const pB = peakNear(lamBR), pW = peakNear(lamWR);
  R.acf = { dx: +dx.toFixed(1), lamBR: +lamBR.toFixed(0), rBR: +pB.r.toFixed(3),
            lamWR: +lamWR.toFixed(0), rWR: +pW.r.toFixed(3) };
  ok(`ロール偏芯の波長（BUR π・D ＝ ${lamBR.toFixed(0)} mm）に自己相関の山がある`, pB.r > 0.15,
     `r = ${pB.r.toFixed(3)} @ ${pB.lam.toFixed(0)} mm`);
  ok('偏芯がギャップを揺らしている（m.ecc がゼロでない）',
     st(mid0.map(r => r.ecc)).sd * 1000 > 3, `σ ${(st(mid0.map(r => r.ecc)).sd * 1000).toFixed(1)} µm`);

  /* 偏芯を切ると振れが減る（＝ 振れが偏芯で出来ていることの証明）。
   * 白色雑音を足しただけのモデルなら、ここで «変わらない» ので落ちる。 */
  const keep = { BR: K.MILL.GAUGE_MODEL.ECC_BR, WR: K.MILL.GAUGE_MODEL.ECC_WR };
  K.MILL.GAUGE_MODEL.ECC_BR = 0; K.MILL.GAUGE_MODEL.ECC_WR = 0;
  const tr2 = runOnce();
  K.MILL.GAUGE_MODEL.ECC_BR = keep.BR; K.MILL.GAUGE_MODEL.ECC_WR = keep.WR;
  const by2 = {}; for (const r of tr2) (by2[r.pass] ??= []).push(r);
  const sd2 = [];
  for (const k of finishing) { const a = by2[k]; if (!a || a.length < 200) continue;
    const m2 = a.slice(a.length * 0.15 | 0, a.length * 0.85 | 0);
    sd2.push(+(st(m2.map(r => r.hd)).sd * 1000).toFixed(1)); }
  R.noEcc = sd2;
  ok('偏芯を切ると長手の振れが小さくなる（振れの主因が偏芯）', avg(sd2) < avg(sds) * 0.75,
     `偏芯あり σ平均 ${avg(sds).toFixed(1)} → なし ${avg(sd2).toFixed(1)} µm`);

  /* ---------- ④ 計器の «読み» ------------------------------------------------ */
  const gm = tr.filter(r => r.hx !== null && r.he !== null);
  ok('出側 固定型が読めている', gm.length > 200, `${gm.length} 点`);
  ok('入側の計器が «前のパスが残した板厚» を読む（いまの出側厚より厚い）',
     gm.filter(r => r.he > r.hd).length > gm.length * 0.9,
     `${(gm.filter(r => r.he > r.hd).length / gm.length * 100).toFixed(0)} %`);
  // 読みは実厚そのものではない（測定ノイズと輸送遅れ）
  const diff = st(gm.map(r => r.hx - r.hd));
  ok('出側の読みが実厚と «ぴったり同じ» ではない（測定ノイズ・輸送遅れがある）',
     diff.sd * 1000 > 2, `σ(読み − 実厚) ${(diff.sd * 1000).toFixed(1)} µm`);
  ok('読みの «ずれ» に偏りが無い（校正がずれていない）', Math.abs(diff.m) * 1000 < 25,
     `平均 ${(diff.m * 1000).toFixed(1)} µm`);
  // 走査型が板幅の中を往復している
  const sz = tr.filter(r => r.sz !== undefined).map(r => r.sz);
  const half = Math.min(K.XRAY.SCAN_Z, P.slab.width / 2);
  ok('走査型のヘッドが板幅の中を往復する', Math.max(...sz) > half * 0.9 && Math.min(...sz) < -half * 0.9,
     `${Math.min(...sz).toFixed(0)} 〜 ${Math.max(...sz).toFixed(0)} mm（板幅 ±${half.toFixed(0)}）`);
  ok('走査型がセンターを通るとき固定型と一致する（校正が取れる）',
     (() => { const c = tr.filter(r => r.hs !== null && r.hx !== null && Math.abs(r.sz) < 30);
              return c.length > 20 && Math.abs(st(c.map(r => r.hs - r.hx)).m) * 1000 < 30; })(),
     (() => { const c = tr.filter(r => r.hs !== null && r.hx !== null && Math.abs(r.sz) < 30);
              return c.length ? `${c.length} 点 / 差 ${(st(c.map(r => r.hs - r.hx)).m * 1000).toFixed(1)} µm` : '0 点'; })());
  return R;
});

console.log(JSON.stringify({ band: out.band, acf: out.acf, noEcc: out.noEcc }, null, 1));
for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name} — ${c.detail}`);
const bad = out.checks.filter(c => !c.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${out.checks.length - bad.length}/${out.checks.length})`);
await browser.close();
process.exit(bad.length ? 1 : 0);
