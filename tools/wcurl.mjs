// 幅方向の曲率プロファイル（Rolling.anticlasticProfile）を測る。
//
// 長手に曲げた板の幅方向の反り（アンチクラスティック）は «全幅で 1 つの値» ではない。
// 板が細ければ全幅に −ν·κ で出るが、広い板では面内の膜剛性に阻まれて中央は平らになり、
// 縁から ℓ = √(R·h)/(3(1−ν²))^{1/4} の帯だけが立つ（Searle–Ashwell）。
// ここで見るのは «式が持つべき性質»:
//   ① 細く薄い板（β ≪ 1）では全幅がほぼ一様に −ν·κ
//   ② 広く強く曲げた板（β ≫ 1）では中央が平らで縁だけが立つ
//   ③ 定規の隙間（rise）と等価曲率（kEq）が同じ 1 式でつながる（chordRise(kEq, w) = rise）
//   ④ β を上げるほど等価曲率は単調に減る（帯が細くなる）
//   ⑤ 形状モニタが «形» を描く（放物線ではなく、縁だけが立つ形が出る）
//
//   node tools/wcurl.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const R = window.__ROLL, K = window.__CFG, A = window.__app, nu = K.SHAPE.POISSON;
  const prof = (k, w, h, n = 41) => R.anticlasticProfile(k, w, h, n);
  const beta = (k, w, h) => (w / 2) * (w / 2) * Math.abs(k) / h;

  /* ① 細く薄い板 */
  const a = prof(1e-6, 300, 40), aRatio = Array.from(a.kw).map(v => v / (-nu * 1e-6));
  const aMin = Math.min(...aRatio), aMax = Math.max(...aRatio);
  /* ② 広く強い曲げ */
  const b = prof(1e-4, 2200, 8), N = b.kw.length, mid = (N - 1) >> 1;
  const edge = Math.abs(b.kw[0]), center = Math.abs(b.kw[mid]);
  let inner = 0; for (let i = mid - (N >> 2); i <= mid + (N >> 2); i++) inner = Math.max(inner, Math.abs(b.kw[i]));   // 中央 50 %
  /* ③ 隙間 ⇔ 等価曲率 */
  const c = prof(2e-6, 1330, 16), chord = R.chordRise(c.kEq, 1330);
  /* ④ β に対して単調 */
  const betas = [0.01, 0.1, 1, 10, 100].map(bt => {
    const w = 1330, h = 16, k = bt * h / ((w / 2) * (w / 2));
    const p = prof(k, w, h);
    return { beta: bt, ratio: p.kEq / (-nu * k), ell: p.ell, half: w / 2 };
  });
  /* 既定ロットの実物（いま・最終パスに近い薄さ）での帯の幅 */
  const s = A.physics.slab;
  const real = prof(1e-6, 1330, 8), realBeta = beta(1e-6, 1330, 8);
  /* ⑤ 形状モニタが形を描く: 縁だけ立つ板を渡して、中央付近の高さが端に比べて平らかを path から読む */
  const fake = (k, w, h) => ({ thickness: h, width: w, length: 30000, alloy: s.alloy,
    warp: { kappa: k, kappaW: prof(k, w, h).kEq, len: k * 1e6 / 8, wid: prof(k, w, h).rise, prof: 1,
            R: 1 / Math.abs(k) / 1000, wProfile: prof(k, w, h), kEnds: [k, k] } });
  A.ui.setShapeMon(true); A.ui.setShapeMonMode('warp');
  A.ui._shapeMon(fake(1e-4, 2200, 8));
  const pa = document.querySelector('#sm-wid .f-warp');
  const ys = [...(pa.getAttribute('d') || '').matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(m => +m[1]);
  const yEnd = ys[0], yMid = ys[ys.length >> 1], yQ = ys[ys.length >> 2];        // 端・中央・1/4
  A.ui._shapeMon(fake(1e-6, 300, 40));
  const pb = document.querySelector('#sm-wid .f-warp');
  const ys2 = [...(pb.getAttribute('d') || '').matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(m => +m[1]);
  A.ui.setShapeMon(false);
  return { aMin, aMax, aBeta: beta(1e-6, 300, 40), edge, center, inner, bBeta: beta(1e-4, 2200, 8), bEll: b.ell,
           cRise: c.rise, chord, betas, real: { ell: real.ell, beta: realBeta, rise: real.rise, kEq: real.kEq },
           mon: { yEnd, yMid, yQ, n: ys.length }, mon2: { yEnd: ys2[0], yMid: ys2[ys2.length >> 1], yQ: ys2[ys2.length >> 2] } };
});
await browser.close();

const checks = [];
const ok = (n, pass, got, ref = false) => checks.push({ name: n, pass: !!pass, got, ref });

console.log('β ごとの等価曲率（−ν·κ に対する比）と縁の帯の幅 ℓ（板幅 1,330・板厚 16）');
for (const q of out.betas) console.log(`  β ${String(q.beta).padStart(5)}  比 ${q.ratio.toFixed(3)}  ℓ ${(q.ell / 1000).toFixed(2)} m（半幅 ${(q.half / 1000).toFixed(2)} m）`);
console.log(`既定ロットの薄板（8 mm・1,330・κ 1e-6）: β ${out.real.beta.toFixed(3)}・帯 ${(out.real.ell / 1000).toFixed(2)} m・幅反り ${out.real.rise.toFixed(3)} mm`);

ok('細く薄い板（β ≪ 1）は全幅がほぼ一様に −ν·κ', out.aMin > 0.9 && out.aMax <= 1.0 + 1e-9,
   `比 ${out.aMin.toFixed(3)}〜${out.aMax.toFixed(3)}（β ${out.aBeta.toExponential(1)}）`);
ok('広く強い曲げ（β ≫ 1）は中央が平らで縁だけ立つ', out.inner < 0.1 * out.edge && out.center < 0.02 * out.edge,
   `縁 ${out.edge.toExponential(2)} ／ 中央 50 % の最大 ${out.inner.toExponential(2)} ／ 中央 ${out.center.toExponential(2)}（β ${out.bBeta.toFixed(0)}・帯 ${(out.bEll / 1000).toFixed(2)} m）`);
ok('定規の隙間と等価曲率が同じ 1 式でつながる（chordRise(kEq) = rise）', Math.abs(out.chord - out.cRise) < 1e-9,
   `rise ${out.cRise.toFixed(4)} ／ chordRise ${out.chord.toFixed(4)} mm`);
ok('β を上げるほど等価曲率の比は単調に減る', out.betas.every((q, i, a) => i === 0 || q.ratio <= a[i - 1].ratio + 1e-12),
   out.betas.map(q => q.ratio.toFixed(3)).join(' ≥ '));
ok('形状モニタが «縁だけ立つ形» を描く（1/4 点が端と中央の間で端寄りに来ず、中央付近は平ら）',
   out.mon.n >= 21 && Math.abs(out.mon.yQ - out.mon.yMid) < 0.25 * Math.abs(out.mon.yEnd - out.mon.yMid),
   `画面 y: 端 ${out.mon.yEnd} ／ 1/4 ${out.mon.yQ} ／ 中央 ${out.mon.yMid}（点 ${out.mon.n}）`);
ok('形状モニタは細い板では放物線に近い（1/4 点が端と中央のほぼ中間）',
   Math.abs((out.mon2.yQ - out.mon2.yMid) / (out.mon2.yEnd - out.mon2.yMid) - 0.25) < 0.08,
   `(1/4 − 中央)/(端 − 中央) ＝ ${((out.mon2.yQ - out.mon2.yMid) / (out.mon2.yEnd - out.mon2.yMid)).toFixed(3)}（放物線なら 0.25）`);

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - bad.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
