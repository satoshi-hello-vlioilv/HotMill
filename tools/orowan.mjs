// Orowan の圧延理論（不均一変形・すべり／固着・傾斜 2 平面の係数 ϖ(a)）を、柳本「圧延理論（中級）」
// §2〜3 の式 (27)〜(41) とプログラムどおりに解き、いまのアプリの核（Bland–Ford ＋ Hitchcock）と
// «同じ入力» で荷重を比べる。ブラウザを使わない —— 変形抵抗（Sellars–Tegart・接触弧の局所ひずみ速度）
// 摩擦・扁平はアプリの式を写してある（A5052・実機ロットの 4 パス）。
//
//   ・検算 ① 固着を強制した Orowan の平均圧力が Sims の解析解（全面固着）と一致する
//   ・検算 ② 薄板・低摩擦の極限（すべりだけ）で Bland–Ford に戻る
//   ・検算 ③ 刻み N で収束する
//   ・参考   同じ入力で核だけを替えた荷重の比（Orowan / Bland–Ford）と μ を振ったときの伸び
//
// 【なぜ要るか】荷重の核を Orowan に替える計画（docs/圧延荷重に効く要因.md §6）の «期待効果» を
// 見積もりでなく数で置くため。ここで出る比が、いまの μ ＝ 0.32 が «何を肩代わりしているか» を示す。
//
//   node tools/orowan.mjs          # 独立実装だけ（ブラウザ不要）
//   node tools/orowan.mjs --app    # アプリ内の Rolling.solve とも突き合わせる
const RG = 8.314;
const AL = { Q: 175000, n: 5.0, alpha: 0.02, lnA: 27.092, KF_MAX: 280 };
const R0 = 465, W = 1330, ROLL_E = 210, NU = 0.3, FLAT_MAX = 4;
const MU0 = 0.32, MU_KV = 0.10, MU_VREF = 60;
const sigmaOf = (T, sr) => Math.asinh(Math.exp((Math.log(Math.max(sr, 1e-4)) + AL.Q / (RG * (T + 273.15)) - AL.lnA) / AL.n)) / AL.alpha;
const flowStress = (T, sr) => { const kf = sigmaOf(T, sr), p = 20; return kf / Math.pow(1 + Math.pow(kf / AL.KF_MAX, p), 1 / p); };
const arcSR = (phi, hOut, R, Q) => { const h = hOut + 2 * R * (1 - Math.cos(phi)); return h > 0 ? 2 * Q * Math.tan(phi) / (h * h) : 0; };
function flowStressArc(T, hIn, hOut, R, v) {           // 接触弧の中の局所ひずみ速度で平均（アプリと同じ）
  const dh = hIn - hOut, a = Math.acos(Math.max(-1, Math.min(1, 1 - dh / (2 * R))));
  const L = R * Math.sin(a), Q = v * hOut, N = 8; let s = 0;
  for (let i = 0; i < N; i++) { const x = L * (i + 0.5) / N, phi = Math.asin(Math.min(1, x / R)); s += flowStress(T, arcSR(phi, hOut, R, Q)); }
  return s / N;
}
/** 局所の変形抵抗 kf(x)（x: 出口からの水平距離 mm）。ひずみ速度分布はアプリと同じ、温度は一定 */
const SR_FLOOR = 0.1;                                    // 局所ひずみ速度の下限（弧平均に対する比。アプリの Rolling.SR_FLOOR と同じ）
const kfLocal = (T, hIn, hOut, R, v) => { const Ld = contactLength(hIn, hOut, R), srMean = (v / Ld) * Math.log(hIn / hOut);
  return (x) => { const phi = Math.asin(Math.min(1, x / R)); return flowStress(T, Math.max(arcSR(phi, hOut, R, v * hOut), SR_FLOOR * srMean)); }; };
const contactLength = (hIn, hOut, R) => { const dh = hIn - hOut; return Math.sqrt(Math.max(R * dh - dh * dh / 4, 0)); };
const flattened = (R, fpw, dh) => { const C = 16 * (1 - NU * NU) / (Math.PI * ROLL_E * 1000); return (dh > 0 && fpw > 0) ? R * Math.min(1 + C * fpw / dh, FLAT_MAX) : R; };
const friction = (v) => Math.max(0.14, Math.min(0.42, MU0 * Math.pow(MU_VREF / Math.max(v, 1), MU_KV)));

/* ---- いまの核: Bland–Ford（アプリの写し。せん断の上限はトルクにだけ） ---- */
function blandFord(hIn, hOut, R, mu, kp, width) {
  const dh = hIn - hOut, a = Math.sqrt(dh / R), g = Math.sqrt(R / hOut);
  const H = (phi) => 2 * g * Math.atan(g * phi), Ha = H(a), m2 = Math.max(mu, 1e-4);
  const Hn = Ha / 2 + Math.log(hOut / hIn) / (2 * m2);
  const phiN = Math.max(0, Math.min(a, Math.tan(Math.max(-1.5, Math.min(1.5, Hn / (2 * g)))) / g));
  const h = (phi) => hOut + R * phi * phi;
  const pEnt = (phi) => kp * (h(phi) / hIn) * Math.exp(m2 * (Ha - H(phi))), pExt = (phi) => kp * (h(phi) / hOut) * Math.exp(m2 * H(phi));
  const N = 16, kS = kp / 2, tau = (q) => Math.min(m2 * q, kS);
  let sE = 0, sN = 0, tE = 0, tN = 0, pMax = 0, stick = 0;
  for (let i = 0; i < N; i++) { const pe = phiN * (i + 0.5) / N, q = pExt(pe), dw = phiN / N; sE += q * dw; tE += tau(q) * dw; pMax = Math.max(pMax, q); if (m2 * q >= kS) stick += dw; }
  for (let i = 0; i < N; i++) { const pe = phiN + (a - phiN) * (i + 0.5) / N, q = pEnt(pe), dw = (a - phiN) / N; sN += q * dw; tN += tau(q) * dw; pMax = Math.max(pMax, q); if (m2 * q >= kS) stick += dw; }
  const force = width * R * (sE + sN), Ld = R * a;
  return { force, torque: width * R * R * (tN - tE) / 1000, phiN, pMax, stickFrac: stick / a, pm: force / (width * Ld), fwd: R * phiN * phiN / hOut };
}

/* ---- Orowan（中級 §3 のプログラムを写す。RK は標準 4 次） ----
 * kpAt(x), muAt(x): 出口からの水平距離 x [mm] での 2 次元降伏応力 k'（= 1.155 kf）と μ。
 * sigF / sigB: 前方・後方張力 [MPa]（引張り正）。forceStick: 全面固着を強制（Sims 相当） */
function orowan(hIn, hOut, R, muAt, kpAt, width, sigF = 0, sigB = 0, opt = {}) {
  const N = opt.N || 400, forceStick = !!opt.forceStick;
  const DIA = 2 * R, DH = hIn - hOut;
  const XL = Math.sqrt(R * DH - 0.25 * DH * DH), OM = Math.atan(XL / (R - 0.5 * DH)), DQ = OM / N;
  const PI4 = Math.PI / 4;
  // その点の (p, df/dφ, 固着か)。side: +1 出口側からの積分, −1 入口側からの積分
  const point = (O, F, side) => {
    const X = R * Math.sin(O), H = hOut + 2 * R * (1 - Math.cos(O));
    let U = muAt(X); const RK = kpAt(X);
    const C1 = -0.5 / U, C2 = 1 - PI4, C3 = 1 + F / H / RK, C4 = Math.sqrt(C1 * C1 + 4 * C2 * C3);
    const A = 0.5 * (C1 + C4) / C2;
    if (A >= 1 || forceStick) {                                    // 固着
      const Wst = PI4; let C2s;
      if (O > 0) { const t = Math.tan(O); C2s = side > 0 ? Wst - 0.5 * (1 / O - 1 / t) : Wst + 0.5 * (1 / O - 1 / t); } else C2s = Wst;
      const V = side > 0 ? C2s * Math.sin(O) + 0.5 * Math.cos(O) : C2s * Math.sin(O) - 0.5 * Math.cos(O);
      const PM = F / H + RK * C2s;
      const dF = F * DIA * Math.sin(O) / H + DIA * RK * V;           // FNSTIK
      return { PM, dF, stick: true, A, tau: 0.5 * RK };
    }
    const Wsl = 1 - C2 * A * A;                                     // ϖ(a) ＝ 1 − (1 − π/4)·a²
    let C2s = 1; if (O > 0) { const t = Math.tan(O); C2s = 1 + U * (1 / O - 1 / t); }
    const PM = (F / H + RK * Wsl) / C2s;
    const Us = side > 0 ? U : -U;                                  // 入口側は U ＝ −U で呼ぶ（原典どおり）
    const c1 = Math.sin(O) + Us * Math.cos(O);
    let dF = F * DIA * c1 / H + DIA * RK * Wsl * c1;               // FNSLIP
    if (O > 0) { const t = Math.tan(O); dF /= (1 + Us * (1 / O - 1 / t)); }
    return { PM, dF, stick: false, A, tau: U * PM };
  };
  const rk4 = (O, F, dO, side) => {
    const k1 = point(O, F, side).dF, k2 = point(O + dO / 2, F + dO / 2 * k1, side).dF;
    const k3 = point(O + dO / 2, F + dO / 2 * k2, side).dF, k4 = point(O + dO, F + dO * k3, side).dF;
    return F + dO / 6 * (k1 + 2 * k2 + 2 * k3 + k4);
  };
  // 出口側: O = 0 → OM、F = −σf·h2
  const ex = []; { let O = 0, F = -sigF * hOut;
    for (let i = 0; i <= N; i++) { const q = point(O, F, +1); ex.push({ O, X: R * Math.sin(O), F, P: q.PM, stick: q.stick, tau: q.tau }); if (i === N) break; F = rk4(O, F, DQ, +1); O += DQ; } }
  // 入口側: O = OM → 0、F = −σb·h1（原典は DQ を負にして同じ式で積む）
  const en = []; { let O = OM, F = -sigB * hIn;
    for (let i = 0; i <= N; i++) { const q = point(O, F, -1); en.push({ O, X: R * Math.sin(O), F, P: q.PM, stick: q.stick, tau: q.tau }); if (i === N) break; F = rk4(O, F, -DQ, -1); O -= DQ; } }
  // 中立点: 出口側の f と入口側の f が交わるところ（SERCH）
  let iN = -1;
  for (let i = 0; i <= N; i++) { const j = N - i; if (en[j].F - ex[i].F <= 0) { iN = i; break; } }
  if (iN < 0) return { ok: false, force: 0 };
  // 荷重 ＝ 出口側 [0, xN] と入口側 [xN, XL] の p を x で積む。トルク ＝ 摩擦応力のモーメント（上下 2 本）
  let sumP = 0, sumT = 0, stickLen = 0;
  for (let i = 0; i < iN; i++) { const dx = ex[i + 1].X - ex[i].X, p = 0.5 * (ex[i].P + ex[i + 1].P); sumP += p * dx; sumT -= 0.5 * (ex[i].tau + ex[i + 1].tau) * dx; if (ex[i].stick) stickLen += dx; }
  for (let j = N - iN; j > 0; j--) { const dx = en[j - 1].X - en[j].X, p = 0.5 * (en[j].P + en[j - 1].P); sumP += p * dx; sumT += 0.5 * (en[j].tau + en[j - 1].tau) * dx; if (en[j].stick) stickLen += dx; }
  const phiN = ex[iN].O, pMax = Math.max(...ex.slice(0, iN + 1).map(q => q.P), ...en.slice(N - iN).map(q => q.P));
  return { ok: true, force: width * sumP, torque: width * R * sumT * 2 / 1000, phiN, pMax, pm: sumP / XL, stickFrac: stickLen / XL,
           fwd: R * phiN * phiN / hOut, Ld: XL, entryP: en[0].P, exitP: ex[0].P };
}
/* Sims（全面固着）の平均圧力 p̄/k' —— 固着強制の Orowan の検算用 */
function sims(hIn, hOut, R) {
  const r = 1 - hOut / hIn, q = Math.sqrt((1 - r) / r), g = Math.sqrt(R / hOut);
  const phiN = Math.sqrt(hOut / R) * Math.tan(0.5 * Math.atan(1 / q) + (Math.PI / 8) * Math.sqrt(hOut / R) * Math.log(1 - r));
  const hn = hOut + R * phiN * phiN;
  const Q = (Math.PI / 2) * q * Math.atan(1 / q) - Math.PI / 4 - q * g * Math.log(hn / hOut) + 0.5 * q * g * Math.log(1 / (1 - r));
  return { Q, phiN, fwd: R * phiN * phiN / hOut };
}
/* 扁平を含めて解く（アプリの solve と同じ不動点反復）。kernel: 'bf' | 'oro' | 'stick' */
function solvePass(P, kernel, muScale = 1, opt = {}) {
  const { hIn, hOut, v, T, sigF } = P, dh = hIn - hOut, vmm = v / 60 * 1000;
  const mu = friction(v) * muScale;
  let R = R0, res = null;
  for (let it = 0; it < 20; it++) {
    const kf = flowStressArc(T, hIn, hOut, R, vmm);
    if (kernel === 'bf') {
      const kfT = Math.max(kf - sigF, kf * 0.35);                   // アプリ: 張力は見かけの kf 低下
      res = blandFord(hIn, hOut, R, mu, 1.155 * kfT, W); res.kf = kf;
    } else {
      const kp = opt.local ? ((x) => 1.155 * kfLocal(T, hIn, hOut, R, vmm)(x)) : (() => 1.155 * kf);
      res = orowan(hIn, hOut, R, () => mu, kp, W, sigF, 0, { forceStick: kernel === 'stick', N: 400 }); res.kf = kf;
    }
    const Rn = flattened(R0, res.force / W, dh);
    if (Math.abs(Rn - R) / R < 1e-6) { R = Rn; break; }
    R += 0.7 * (Rn - R);
  }
  return { ...res, R, mu, ton: res.force / 9806.65, Ld: contactLength(hIn, hOut, R) };
}

const PASSES = [
  { name: 'P2  520→490 (厚板段)', hIn: 520, hOut: 490, v: 120, T: 433, sigF: 0 },
  { name: 'P11 250→220 (中間)  ', hIn: 250, hOut: 220, v: 120, T: 441, sigF: 0 },
  { name: 'P22  26→16  (仕上げ)', hIn: 26, hOut: 16, v: 80, T: 427, sigF: 0 },
  { name: 'P23  16→8   (巻取)  ', hIn: 16, hOut: 8, v: 50, T: 400, sigF: 13.35 },
];
const checks = [];
const ok = (name, pass, got, ref = false) => checks.push({ name, pass: !!pass, got, ref });
/* アプリ内の Rolling.solve（核 OROWAN・バイト内温度場 off・ひずみの過渡 off ＝ ここと同じ入力）が、
 * この独立実装（局所 kf(x)）と一致するか。ブラウザを開くので --app を付けたときだけ。 */
let inApp = null;
if (process.argv.includes('--app')) {
  const { openApp, installHelpers } = await import('./harness.mjs');
  const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
  await installHelpers(page);
  inApp = await page.evaluate((P) => {
    const R = window.__ROLL, K = window.__CFG, al = K.ALLOYS.A5052;
    const keep = { k: K.PROCESS.KERNEL, b: K.PROCESS.BITE_THERMAL, t: K.MICRO.TRANSIENT.ON };
    K.PROCESS.KERNEL = 'OROWAN'; K.PROCESS.BITE_THERMAL = false; K.MICRO.TRANSIENT.ON = false;
    const rows = P.map(p => { const r = R.solve(p.hIn, p.hOut, 1330, p.v, p.T, p.sigF, al); return { ton: r.forceTon, fwd: r.forwardSlip, stick: r.stickFrac }; });
    K.PROCESS.KERNEL = keep.k; K.PROCESS.BITE_THERMAL = keep.b; K.MICRO.TRANSIENT.ON = keep.t;
    return { rows, kernel: keep.k, srFloor: R.SR_FLOOR, N: R.ORO_N };
  }, PASSES);
  await browser.close();
}

console.log('■ 同じ入力（A5052・kf・μ・扁平）で核だけを替えた荷重 [t]');
console.log('パス                     Ld/h̄    μ     kf MPa   BF(いま)   Orowan   固着(Sims)  Orowan/BF  固着率   前進率 BF/Oro/Sims  p_max/k\' Oro');
const rows = [];
for (const P of PASSES) {
  const bf = solvePass(P, 'bf'), oro = solvePass(P, 'oro'), st = solvePass(P, 'stick');
  const sm = sims(P.hIn, P.hOut, st.R), ldh = bf.Ld / ((P.hIn + P.hOut) / 2);
  const simsErr = st.pm / (1.155 * st.kf) / sm.Q - 1;
  rows.push({ P, bf, oro, st, sm, ldh, simsErr });
  console.log(`${P.name}  ${ldh.toFixed(2).padStart(5)}  ${bf.mu.toFixed(3)}  ${bf.kf.toFixed(1).padStart(6)}   ${bf.ton.toFixed(0).padStart(6)}   ${oro.ton.toFixed(0).padStart(6)}   ${st.ton.toFixed(0).padStart(6)}      ${(oro.ton / bf.ton).toFixed(3)}   ${(oro.stickFrac * 100).toFixed(0).padStart(3)} %   ${(bf.fwd * 100).toFixed(1)} / ${(oro.fwd * 100).toFixed(1)} / ${(sm.fwd * 100).toFixed(1)} %   ${(oro.pMax / (1.155 * oro.kf)).toFixed(2)}`);
  console.log(`      固着強制の p̄/k' ${(st.pm / (1.155 * st.kf)).toFixed(3)} vs Sims ${sm.Q.toFixed(3)}（差 ${(simsErr * 100).toFixed(1)} %）／ 入口 p/k' ${(oro.entryP / (1.155 * oro.kf)).toFixed(3)} 出口 ${(oro.exitP / (1.155 * oro.kf)).toFixed(3)}`);
}
console.log('\n■ μ を振ったときの荷重 [t]（P23 16→8・巻取）—— Coulomb は指数で伸び、固着が入ると頭打ちになる');
console.log('  μ倍率   μ      BF(いま)   Orowan   固着率');
const sweep = [];
for (const s of [0.5, 0.7, 0.85, 1.0, 1.15, 1.3]) { const P = PASSES[3], bf = solvePass(P, 'bf', s), oro = solvePass(P, 'oro', s); sweep.push({ s, bf, oro }); console.log(`  ${s.toFixed(2)}    ${bf.mu.toFixed(3)}   ${bf.ton.toFixed(0).padStart(6)}   ${oro.ton.toFixed(0).padStart(6)}   ${(oro.stickFrac * 100).toFixed(0)} %`); }
console.log('\n■ 薄板・低摩擦の極限で Orowan → Bland–Ford に戻るか（2 → 1.6 mm・μ 0.05・kf 一定）');
const thin = (() => { const kp = () => 1.155 * 100, R = 465;
  const bf = blandFord(2, 1.6, R, 0.05, 1.155 * 100, W), oro = orowan(2, 1.6, R, () => 0.05, kp, W);
  console.log(`  BF ${(bf.force / 9806.65).toFixed(1)} t / Orowan ${(oro.force / 9806.65).toFixed(1)} t（比 ${(oro.force / bf.force).toFixed(3)}）・前進率 BF ${(bf.fwd * 100).toFixed(2)} % / Oro ${(oro.fwd * 100).toFixed(2)} %・固着率 ${(oro.stickFrac * 100).toFixed(0)} %`);
  return { ratio: oro.force / bf.force, stick: oro.stickFrac }; })();
console.log('\n■ 変形抵抗を接触弧の中で «局所» に与えたとき（ひずみ速度分布だけ。温度は一定）—— Orowan は k\'(x) をそのまま受ける');
for (const P of PASSES) { const a = solvePass(P, 'oro'), b = solvePass(P, 'oro', 1, { local: true }); console.log(`  ${P.name}  平均 kf ${a.ton.toFixed(0)} t → 局所 kf(x) ${b.ton.toFixed(0)} t（${((b.ton / a.ton - 1) * 100).toFixed(1)} %）`); }
console.log('\n■ 刻み N の収束（P23）');
const conv = [];
for (const N of [50, 100, 200, 400, 800]) { const P = PASSES[3]; const vmm = P.v / 60 * 1000, kf = flowStressArc(P.T, P.hIn, P.hOut, 465, vmm); const o = orowan(P.hIn, P.hOut, 465, () => friction(P.v), () => 1.155 * kf, W, P.sigF, 0, { N }); conv.push({ N, t: o.force / 9806.65 }); console.log(`  N ${String(N).padStart(4)}  ${(o.force / 9806.65).toFixed(1)} t  中立角 ${(o.phiN * 1e3).toFixed(3)} mrad`); }

if (inApp) {
  const mine = PASSES.map(P => solvePass(P, 'oro', 1, { local: true }));
  const diff = mine.map((m, i) => inApp.rows[i].ton / m.ton - 1);
  console.log('\n■ アプリ内の Rolling.solve（核 OROWAN・温度場 off・過渡 off）との突き合わせ');
  PASSES.forEach((P, i) => console.log(`  ${P.name}  独立実装 ${mine[i].ton.toFixed(0)} t ／ アプリ ${inApp.rows[i].ton.toFixed(0)} t（差 ${(diff[i] * 100).toFixed(2)} %）前進率 ${(mine[i].fwd * 100).toFixed(1)} / ${(inApp.rows[i].fwd * 100).toFixed(1)} %`));
  ok('アプリ内の solve が独立実装と一致する（4 パスとも 0.5 % 以内。同じ刻み・同じ下限）', diff.every(d => Math.abs(d) < 5e-3),
     diff.map(d => (d * 100).toFixed(2) + ' %').join(' / ') + `（アプリの既定の核: ${inApp.kernel}・N ${inApp.N}・下限 ${inApp.srFloor}）`);
}
const worstSims = Math.max(...rows.map(r => Math.abs(r.simsErr)));
ok('固着を強制した Orowan の平均圧力が Sims の解析解と一致する（4 パスとも 3 % 以内）', worstSims < 0.03, `最大の差 ${(worstSims * 100).toFixed(1)} %`);
ok('薄板・低摩擦の極限（すべりだけ）で Bland–Ford に戻る（1 % 以内）', Math.abs(thin.ratio - 1) < 0.01 && thin.stick === 0, `比 ${thin.ratio.toFixed(3)}・固着率 ${(thin.stick * 100).toFixed(0)} %`);
const c100 = conv.find(c => c.N === 100).t, c800 = conv.find(c => c.N === 800).t;
ok('刻み N ＝ 100 で 0.1 % 以内に収束する', Math.abs(c100 / c800 - 1) < 1e-3, `N100 ${c100.toFixed(1)} t / N800 ${c800.toFixed(1)} t`);
ok('中立点が接触弧の中にあり、前進率が正（4 パスとも）', rows.every(r => r.oro.ok && r.oro.phiN > 0 && r.oro.fwd > 0), rows.map(r => (r.oro.fwd * 100).toFixed(1) + ' %').join(' / '));
ok('入口・出口の圧力が k\' 以下（傾斜 2 平面の境界圧。張力があれば更に下がる）', rows.every(r => r.oro.entryP <= 1.155 * r.oro.kf + 1e-9 && r.oro.exitP <= 1.155 * r.oro.kf + 1e-9), rows.map(r => `${(r.oro.entryP / (1.155 * r.oro.kf)).toFixed(2)}/${(r.oro.exitP / (1.155 * r.oro.kf)).toFixed(2)}`).join(' '));
ok('（参考）同じ入力で核を Orowan に替えたときの荷重の比 Orowan / Bland–Ford', true, rows.map(r => `${r.P.name.trim().split(' ')[0]} ${(r.oro.ton / r.bf.ton).toFixed(3)}`).join('・') + `（固着率 ${rows.map(r => (r.oro.stickFrac * 100).toFixed(0) + ' %').join('/')}）`, true);
const s0 = sweep[0], s5 = sweep[sweep.length - 1];
ok('（参考）μ 0.16 → 0.42 で荷重が何倍に伸びるか（巻取パス）', true, `Bland–Ford ${(s5.bf.ton / s0.bf.ton).toFixed(2)} 倍 ／ Orowan ${(s5.oro.ton / s0.oro.ton).toFixed(2)} 倍（固着で頭打ち）`, true);
ok('（参考）Orowan にしたときの巻取パスの荷重と実機の帯', true, `${rows[3].oro.ton.toFixed(0)} t（帯 2,400〜2,900 t。μ を 0.42 にしても ${s5.oro.ton.toFixed(0)} t —— 足りないぶんは μ でなく k の側）`, true);

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}、参考 ${nRef} 件)`);
