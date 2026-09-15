// 摩擦係数 μ を «固定値» にしてよいか —— すべり速度・温度依存の摩擦則と同じ入力で比べる（ブラウザ不要）。
//
// 【問い】バイトの中では中立点を境に、入側は材料がロールより遅く（引き込まれる）、出側は速い（送り出される）。
// 界面のせん断は、その «すべり速度» と表面温度で変わるはず —— 変形抵抗のひずみ速度感受性 m を通して。
// では μ を 1 つの値（Coulomb ＋ 固着で頭打ち。いまの核）で置くのと、τ(x) を場所ごとに解くのとで、
// 荷重・トルク・先進率・温度依存・速度依存がどれだけ違うか。
//
// 【せん断層（すべり速度依存）摩擦】 τ(x) ＝ min( (k'(x)/2)·MF·(|Δv(x)|/VREF)^m(T, ε̇),  μc·p(x),  k'(x)/2 )
//   Δv ＝ ロール周速の接線成分 − 材料速度（質量流から）。中立点で 0、入口・出口で最大。
//   m ＝ tanh(ασ)/(n·ασ)（Rolling.mEff と同じ。温度とひずみ速度で変わる）。μc は液膜のせん断の上限（いまの μ）。
//   MF・VREF は実測が無いので振る（先進率を 2 速度で測れば決まる —— DATAREQ FWDSLIP2）。
//   μ(x) ＝ τ/p を Orowan の核（tools/orowan.mjs と同じ写し）に返し、不動点反復（適応緩和）で解く。
//
//   ① 極限の一致: VREF → 小・MF ＝ 1 で Coulomb ＋ 固着に戻る（同一入力で荷重 ±0.5 %）
//   ② 形の性質: μ(x) の最小は中立点の上に来る（すべりが止まるところで界面のせん断が消える）
//   ③ 不動点が収束する（または有界: 最後の 2 回の変化 ＜ 5e-3）
//   参考: 同じ入力で法則だけを替えた荷重・トルク・先進率の比、温度（m(T) を通す）、速度（P23 30/50/80 mpm）
//
//   node tools/mushear.mjs
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
           fwd: R * phiN * phiN / hOut, Ld: XL, entryP: en[0].P, exitP: ex[0].P, ex, en, iN, N };
}
/* ---- ひずみ速度感受性 m_eff ＝ tanh(ασ)/(n·ασ)（アプリの Rolling.mEff と同じ） ---- */
const mEff = (T, sr) => { const x = AL.alpha * sigmaOf(T, sr); return x > 0 ? Math.tanh(x) / (AL.n * x) : 1 / AL.n; };
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
/* ---- せん断層（すべり速度依存）摩擦: τ(x) ＝ min( (k'/2)·MF·(|Δv|/VREF)^m(T, ε̇) , μc·p , k'/2 ) ---- */
function solveShear(P, prm, opt = {}) {
  const { hIn, hOut, v, T, sigF } = P, dh = hIn - hOut, vmm = v / 60 * 1000;
  const muC = friction(v) * (opt.muScale || 1) * (prm.MUC_K || 1);        // 液膜のせん断の上限（Coulomb 側）
  let R = R0, res = null, muArr = null, prevP = null, iters = 0, muHist = [], relax = 0.5, dmuPrev = Infinity;
  const kpF = (Rn) => { const f = kfLocal(T, hIn, hOut, Rn, vmm); return (x) => 1.155 * f(x); };
  const srF = (Rn) => { const Ld = contactLength(hIn, hOut, Rn), srMean = (vmm / Ld) * Math.log(hIn / hOut);
    return (x) => { const phi = Math.asin(Math.min(1, x / Rn)); return Math.max(arcSR(phi, hOut, Rn, vmm * hOut), SR_FLOOR * srMean); }; };
  let muFn = () => muC;                                                 // 1 回目は Coulomb で
  for (let it = 0; it < 40; it++) {
    iters++;
    const kp = kpF(R), sr = srF(R);
    res = orowan(hIn, hOut, R, muFn, kp, W, sigF, 0, { N: opt.N || 200 }); if (!res.ok) return { ok: false };
    const Rn = flattened(R0, res.force / W, dh);
    // p(x) と中立点から τ(x) → μ(x)
    const { ex, en, iN, N, phiN } = res, hN = hOut + 2 * R * (1 - Math.cos(phiN));
    const pAt = (x) => { const xN = ex[iN].X; const arr = x <= xN ? ex : en; // 単調な X で線形補間
      let lo = 0, hi = arr.length - 1; if (arr === en) { /* en は X 降順 */ }
      const asc = arr === ex; const X = (q) => q.X;
      if (asc) { for (let i = 0; i < arr.length - 1; i++) if (x <= X(arr[i + 1])) { const t = (x - X(arr[i])) / Math.max(X(arr[i + 1]) - X(arr[i]), 1e-12); return arr[i].P + t * (arr[i + 1].P - arr[i].P); } return arr[arr.length - 1].P; }
      for (let i = 0; i < arr.length - 1; i++) if (x >= X(arr[i + 1])) { const t = (x - X(arr[i])) / Math.min(X(arr[i + 1]) - X(arr[i]), -1e-12); return arr[i].P + t * (arr[i + 1].P - arr[i].P); } return arr[arr.length - 1].P; };
    const newMu = (x) => { const phi = Math.asin(Math.min(1, x / R)), h = hOut + 2 * R * (1 - Math.cos(phi));
      const dv = vmm * (Math.cos(phi) - Math.cos(phiN) * hN / h);       // ロール − 材料（入側 +、出側 −）
      const m = mEff(T, sr(x)), k2 = kp(x) / 2, p = Math.max(pAt(x), 1e-6);
      const tauM = k2 * prm.MF * Math.pow(Math.abs(dv) / prm.VREF, m);
      const tau = Math.min(tauM, muC * p, k2);
      return Math.max(tau / p, 1e-4); };
    // 緩和: μ(x) を格子に置いて前回と混ぜる（0.5）
    const M = 2 * (opt.N || 200) + 1, xs = Array.from({ length: M }, (_, i) => res.Ld * i / (M - 1));
    const cur = xs.map(newMu);
    const dmuRaw = muArr ? Math.max(...cur.map((u, i) => Math.abs(u - muArr[i]))) : 1;
    if (muArr && dmuRaw > dmuPrev * 0.9) relax = Math.max(relax * 0.5, 0.05); dmuPrev = dmuRaw;
    const mixed = muArr ? cur.map((u, i) => muArr[i] + relax * (u - muArr[i])) : cur;
    const dmu = muArr ? Math.max(...mixed.map((u, i) => Math.abs(u - muArr[i]))) : 1;
    muArr = mixed; const xsF = xs;
    muFn = (x) => { const t = x / res.Ld * (M - 1), i = Math.min(Math.floor(t), M - 2), f = t - i; return muArr[i] + f * (muArr[i + 1] - muArr[i]); };
    const dR = Math.abs(Rn - R) / R; R += 0.7 * (Rn - R);
    muHist.push(+dmu.toFixed(4));
    if (dR < 1e-6 && dmuRaw < 5e-4 && it > 2) break;
  }
  const muMean = muArr.reduce((a, b) => a + b, 0) / muArr.length;
  return { ...res, R, ton: res.force / 9806.65, iters, muMean, muArr, muC, muHist };
}
const PASSES = [
  { name: 'P2  520→490 厚板', hIn: 520, hOut: 490, v: 120, T: 433, sigF: 0 },
  { name: 'P11 250→220 中間', hIn: 250, hOut: 220, v: 120, T: 441, sigF: 0 },
  { name: 'P22  26→16  仕上', hIn: 26, hOut: 16, v: 80, T: 427, sigF: 0 },
  { name: 'P23  16→8   巻取', hIn: 16, hOut: 8, v: 50, T: 400, sigF: 13.35 },
];
const f1 = (x, d = 1) => (+x).toFixed(d);
const checks = [];
const ok = (name, pass, got, ref = false) => { checks.push({ name, pass: !!pass, got, ref }); console.log(`${ref ? '??' : pass ? 'OK' : 'NG'}   ${name}  → ${got}`); };
const base = {};
console.log('--- Coulomb ＋ 固着（いまの核。μ ＝ 0.32·(60/v)^0.1）---');
for (const P of PASSES) { const r = solvePass(P, 'oro', 1, { local: true }); base[P.name] = r;
  console.log(`${P.name}  μ ${f1(r.mu, 3)}  ${f1(r.ton, 0)} t  T ${f1(r.torque / 1000, 0)} kN·m  fwd ${f1(r.fwd * 100, 1)} %  固着 ${f1(r.stickFrac * 100, 0)} %`); }
const line = (P, r, b) => `${P.name}  ${f1(r.ton, 0)} t (${f1(r.ton / b.ton, 3)})  T ${f1(r.torque / 1000, 0)} kN·m (${f1(r.torque / b.torque, 2)})  fwd ${f1(r.fwd * 100, 1)} % (C ${f1(b.fwd * 100, 1)})  固着 ${f1(r.stickFrac * 100, 0)} %  μ̄ ${f1(r.muMean, 3)}  反復 ${r.iters}  dμ ${r.muHist.slice(-2).join('/')}`;
const runs = {};
for (const prm of [{ MF: 1.0, VREF: 10 }, { MF: 0.8, VREF: 100 }, { MF: 0.6, VREF: 300 }]) {
  const key = `MF ${prm.MF} VREF ${prm.VREF}`; runs[key] = {};
  console.log(`--- せん断層摩擦 ${key} mm/s ---`);
  for (const P of PASSES) { const r = solveShear(P, prm); runs[key][P.name] = r; console.log(line(P, r, base[P.name])); }
}
// ① 極限
{ const k = 'MF 1 VREF 10'; const dev = PASSES.map(P => Math.abs(runs[k][P.name].ton / base[P.name].ton - 1));
  ok('VREF → 小・MF ＝ 1 の極限で Coulomb ＋ 固着に戻る（4 パスとも荷重 ±0.5 %）', Math.max(...dev) < 0.005, PASSES.map((P, i) => `${P.name.split(' ')[0]} ${f1(dev[i] * 100, 2)} %`).join(' ／ ')); }
// ② 形
{ const r = runs['MF 0.8 VREF 100'][PASSES[3].name], M = r.muArr.length; let iMin = 0; for (let i = 1; i < M; i++) if (r.muArr[i] < r.muArr[iMin]) iMin = i;
  const xMin = iMin / (M - 1), xN = r.ex[r.iN].X / r.Ld;
  ok('μ(x) の最小が中立点の上に来る（P23、±0.05 Ld）', Math.abs(xMin - xN) < 0.05, `最小 x/Ld ${f1(xMin, 2)}（μ ${f1(r.muArr[iMin], 3)}）vs 中立点 ${f1(xN, 2)}。入口 ${f1(r.muArr[M - 1], 3)}・出口 ${f1(r.muArr[0], 3)}`); }
// ③ 収束
{ const worst = Math.max(...Object.values(runs).flatMap(o => Object.values(o).map(r => Math.max(...r.muHist.slice(-2)))));
  ok('不動点反復が収束または有界（全 12 例で最後の 2 回の変化 ＜ 5e-3）', worst < 5e-3, `最大 ${worst.toExponential(1)}`); }
// 参考
{ const k = 'MF 0.8 VREF 100';
  ok('（参考）同じ入力で法則だけを替えた荷重の比（せん断層 / Coulomb）', true, PASSES.map(P => `${P.name.split(' ')[0]} ${f1(runs[k][P.name].ton / base[P.name].ton, 3)}`).join(' ／ ') + `（3 組の中で最大の差 ${f1((1 - Math.min(...Object.values(runs).flatMap(o => PASSES.map(P => o[P.name].ton / base[P.name].ton)))) * 100, 1)} %）`, true);
  ok('（参考）先進率の差 [ポイント]', true, PASSES.map(P => `${P.name.split(' ')[0]} ${f1((runs[k][P.name].fwd - base[P.name].fwd) * 100, 1)}`).join(' ／ '), true);
  const tRows = [380, 427, 460].map(T => { const P = { ...PASSES[2], T }; const b = solvePass(P, 'oro', 1, { local: true }); const r = solveShear(P, { MF: 0.8, VREF: 100 }); return `${T} ℃ ${f1(r.ton / b.ton, 3)}（fwd ${f1(r.fwd * 100, 1)} vs ${f1(b.fwd * 100, 1)}、m ${f1(mEff(T, 20), 3)}）`; });
  ok('（参考）温度依存: P22 26 → 16 を 380/427/460 ℃（せん断層は m(T) を通す、Coulomb は μ 固定）', true, tRows.join(' ／ '), true);
  const vRows = [30, 50, 80].map(v => { const P = { ...PASSES[3], v }; const b = solvePass(P, 'oro', 1, { local: true }); const r = solveShear(P, { MF: 0.8, VREF: 100 }); return `${v} mpm ${f1(r.ton / b.ton, 3)}（μ̄ ${f1(r.muMean, 3)} vs μ ${f1(b.mu, 3)}）`; });
  ok('（参考）速度依存: P23 16 → 8 を 30/50/80 mpm（せん断層は速いほど τ が上がる、Coulomb は μ が下がる）', true, vRows.join(' ／ '), true); }
const fails = checks.filter(c => !c.ref && !c.pass).length, n = checks.filter(c => !c.ref).length;
console.log(`RESULT: ${fails ? 'FAIL' : 'PASS'} (${n - fails}/${n}、参考 ${checks.filter(c => c.ref).length} 件)`);
process.exit(fails ? 1 : 0);
