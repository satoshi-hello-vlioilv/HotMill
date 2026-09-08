// 頭・尻の荷重差を «要因ごとに» 分解する評価器。
//
// なぜ要るか: loadtrace.mjs は «頭・尻が内側より高いか» を測るが、«なぜ» までは答えない。
// 実機では頭と尻の荷重がほぼ同等（どちらも内側より高い）なのに対し、本アプリでは
// 厚いパスで «頭 < 内側 < 尻»、薄いパスで «頭 > 尻» と、パスによって向きが変わる。
// ここでは頭帯・内側・尻帯のそれぞれで、荷重を決める入力
//   ・その場所の入側板厚 hLoc（前パスが残したプロファイル）
//   ・その場所の温度偏差 dTloc（端部の冷え）と層平均温度
//   ・ライン速度（ひずみ速度）
//   ・実ギャップ（＝圧下量）
// を平均し、感度の一次近似で «荷重差のうち何がどれだけか» を出す。
//   node tools/headtail.mjs [index.html]
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const args = process.argv.slice(2);
const TARGET = args.find(a => !a.startsWith('--')) || DEFAULT_TARGET;
const OPT = { strip: (args.find(a => a.startsWith('--strip=')) || '').split('=')[1] || null,
              coolant: !args.includes('--nocoolant'), prof: args.includes('--prof') };
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate((OPT) => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL;
  if (OPT.strip) K.MATERIAL.STRIP_COOL.MODE = OPT.strip;
  if (!OPT.coolant) { const c = document.getElementById('chk-coolant'); c.checked = false; c.dispatchEvent(new Event('change')); }
  const ZONE = 1500, REF = 6000;
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  window.__startAuto(false);
  const s = P.slab, m = P.mill;
  const passes = [], profs = []; let cur = null, rec = [], t = 0;
  const band = (q, key, lo, hi) => q.filter(r => r[key] >= lo && r[key] < hi);
  const finish = () => {
    if (!cur || rec.length < 40) { cur = null; rec = []; return; }
    const vRun = Math.max(...rec.map(q => q.v)) * 0.5;
    const full = rec.filter(q => q.fill >= 0.999 && q.v >= vRun);
    if (full.length < 20) { cur = null; rec = []; return; }
    const stats = (arr) => ({
      n: arr.length, f: avg(arr.map(q => q.f)), h: avg(arr.map(q => q.h)), dT: avg(arr.map(q => q.dT)),
      Tm: avg(arr.map(q => q.Tm)), v: avg(arr.map(q => q.v)), gap: avg(arr.map(q => q.gap)),
      screw: avg(arr.map(q => q.screw)), kf: avg(arr.map(q => q.kf)), t: avg(arr.map(q => q.t)),
    });
    const head = stats(band(full, 'dHead', 0, ZONE)), ref = stats(band(full, 'dHead', ZONE, REF).filter(q => q.dTail >= ZONE));
    const tail = stats(band(full, 'dTail', 0, ZONE));
    // 感度の一次近似（その場で Rolling.solve を数値微分）
    const al = s.alloy, W = s.width, base = R.solve(ref.h, ref.gap, W, ref.v, ref.Tm + ref.dT, 0, al).forceTon;
    const dF = (h, gap, v, T) => R.solve(h, gap, W, v, T, 0, al).forceTon / Math.max(base, 1) - 1;
    const part = (z) => ({
      ratio: z.f / Math.max(ref.f, 1),
      byH: dF(z.h, ref.gap, ref.v, ref.Tm + ref.dT),
      byT: dF(ref.h, ref.gap, ref.v, z.Tm + z.dT),
      byV: dF(ref.h, ref.gap, z.v, ref.Tm + ref.dT),
      byGap: dF(ref.h, z.gap, ref.v, ref.Tm + ref.dT),
      dh: z.h - ref.h, dT: (z.Tm + z.dT) - (ref.Tm + ref.dT), dv: z.v - ref.v, dgap: z.gap - ref.gap,
    });
    passes.push({ pass: cur.pass, gapPlan: cur.gap, len: Math.round(cur.len / 1000),
                  hIn: +ref.h.toFixed(2), F: Math.round(ref.f), head: part(head), tail: part(tail),
                  nH: head.n, nT: tail.n, nR: ref.n });
    cur = null; rec = [];
  };
  while (t < 4000 && !P.finish.done && !P.tripped) {
    P.step(1 / 120); t += 1 / 120;
    const i = m.passIndex;
    if (s.inBite && i >= 0) {
      if (!cur || cur.pass !== i + 1) { finish(); cur = { pass: i + 1, gap: K.SCHEDULE[i]?.gap ?? 0, len: s.length };
        if (OPT.prof) { const D = s.dTProf, N = D.length, pk = (a) => Array.from(a).map(v => v.toFixed(1)).join(' ');
          const lo = s.dir > 0 ? 'xMin' : 'xMax';
          profs.push(`P${i + 1} 頭側=${s.dir > 0 ? 'u=1' : 'u=0'}  D[0..7]=${pk(D.subarray(0, 8))} | D[N-8..]=${pk(D.subarray(N - 8))}  h[0..3]=${pk(s.hProf.subarray(0,4))} h[N-4..]=${pk(s.hProf.subarray(N-4))}`); } }
      const gap = m.gap, hIn = s.thickness, u = s.uBite(gap);
      rec.push({ t, f: m.forceMeas ?? s.rollForce, fill: s.biteFill, gap, v: Math.abs(m.currentSpeed), screw: m.screw,
                 h: s.hBite, dT: s.dTAt(u), Tm: s.temperature, kf: s.flowStress,
                 dHead: (s.dir > 0 ? s.xMax : -s.xMin) * gap / Math.max(hIn, 1e-6),
                 dTail: s.dir > 0 ? -s.xMin : s.xMax });
    } else if (cur) finish();
  }
  finish();
  return { passes, profs, done: P.finish.done, tripped: P.tripped };
}, OPT);
for (const l of out.profs) console.log(l);

const pct = (x) => ((x >= 0 ? '+' : '') + (x * 100).toFixed(1)).padStart(6) + ' %';
console.log('パス  出側厚   板長  基準荷重 | 帯   荷重比   板厚寄与  温度寄与  速度寄与  ギャップ寄与 |   Δh mm   ΔT K   Δv mpm  Δgap mm');
for (const q of out.passes) {
  for (const [nm, z] of [['頭', q.head], ['尻', q.tail]]) {
    console.log(`P${String(q.pass).padStart(2)} ${String(q.gapPlan).padStart(7)} ${String(q.len).padStart(4)} m ${String(q.F).padStart(7)} t | ${nm} ` +
      `${z.ratio.toFixed(3)}  ${pct(z.byH)}  ${pct(z.byT)}  ${pct(z.byV)}  ${pct(z.byGap)}   | ` +
      `${z.dh.toFixed(2).padStart(7)} ${z.dT.toFixed(1).padStart(7)} ${z.dv.toFixed(1).padStart(7)} ${z.dgap.toFixed(3).padStart(8)}`);
  }
}
console.log(`\n完走 ${out.done}  停止 ${out.tripped || 'なし'}`);
await browser.close();
