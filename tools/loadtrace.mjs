// 圧延荷重の «パスの中での形» を全パスにわたって実測する評価器。
//
// なぜ要るか: これまでの評価器は «パスごとの最大・平均荷重» しか見ておらず、
// «1 パスの中で荷重がどう動くか» を問う検査がどこにも無かった。実機では
//   ・噛み込んだ瞬間に荷重が跳ねる（圧下はミルの伸びを見込んで締めてあり、
//     荷重が立つまでその無負荷ギャップがそのまま材料に当たるため）
//   ・頭と尻で荷重が高い（端部が冷えていて硬い）
// という形になる。ここではその 3 つを «そのすぐ内側» と比べて測る。
//
// 位置の取り方: いまロールバイトに入っている材料が «板の頭 / 尻» から何 mm かは、
// 入側（未圧延）座標で測る。入側の端までの距離はそのまま、出側の端までの距離は
// 伸びの逆比（gap/hIn）で入側座標へ戻す。
//
// 効果の強さは板厚で変わる（噛み込み衝撃は伸び F/M が圧下量に占める割合で決まり、
// 端部の冷えは板厚に反比例する）。厚い前段パスでは弱く、薄い後段パスで強く出る。
// また板長が端部冷却域より短いパスでは «頭・中央・尻» の区別がそもそも付かない。
// そこで «薄いパス（出側 60 mm 以下）では必ず出ること» を合格条件にしている。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG;
  const R = { checks: [], passes: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: d });
  const ZONE = 1500, REF = 6000;                 // 端部として見る範囲 ／ その基準にする範囲
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  window.__startAuto(false);
  const s = P.slab, m = P.mill;
  let cur = null, rec = [], t = 0;
  const finish = () => {
    if (!cur || rec.length < 40) { cur = null; rec = []; return; }
    const full = rec.filter(q => q.fill >= 0.999);
    if (full.length < 20) { cur = null; rec = []; return; }
    const pick = (key, lo, hi) => full.filter(q => q[key] >= lo && q[key] < hi).map(q => q.f);
    const headF = avg(pick('dHead', 0, ZONE)), headRef = avg(pick('dHead', ZONE, REF));
    const tailF = avg(pick('dTail', 0, ZONE)), tailRef = avg(pick('dTail', ZONE, REF));
    const t0 = rec[0].t, early = rec.filter(q => q.t - t0 < 1.0);
    const spike = Math.max(...early.map(q => q.f));
    const late = full.filter(q => q.dHead > ZONE).map(q => q.gap);
    R.passes.push({
      pass: cur.pass, gap: cur.gap, len: Math.round(cur.len / 1000),
      spike: Math.round(spike), headRef: Math.round(headRef),
      spikeR: +(spike / Math.max(headRef, 1)).toFixed(3),
      headR: +(headF / Math.max(headRef, 1)).toFixed(3),
      tailR: +(tailF / Math.max(tailRef, 1)).toFixed(3),
      band: +(late.length ? Math.max(...late) - Math.min(...late) : 0).toFixed(2),
      hOut: +full[full.length - 1].gap.toFixed(2),
      dTend: +cur.dTend.toFixed(1), dTmid: +cur.dTmid.toFixed(1),
    });
    cur = null; rec = [];
  };
  while (t < 4000 && !P.finish.done && !P.tripped) {
    P.step(1 / 120); t += 1 / 120;
    const i = m.passIndex;
    if (s.inBite && i >= 0) {
      if (!cur || cur.pass !== i + 1) { finish(); cur = { pass: i + 1, gap: K.SCHEDULE[i]?.gap ?? 0, len: s.length }; }
      const gap = m.gap, hIn = s.thickness;
      rec.push({ t: +t.toFixed(3), f: s.rollForce, fill: s.biteFill, gap,
                 dHead: (s.dir > 0 ? s.xMax : -s.xMin) * gap / Math.max(hIn, 1e-6),
                 dTail: s.dir > 0 ? -s.xMin : s.xMax });
      const D = s.dTProf, N = D.length;
      const c = Math.max(1, Math.round(ZONE / Math.max(s.length / (N - 1), 1)));
      let e = 0; for (let j = 0; j < c; j++) e += D[j] + D[N - 1 - j];
      cur.dTend = e / (2 * c);
      cur.dTmid = (D[(N >> 1) - 2] + D[N >> 1] + D[(N >> 1) + 2]) / 3;
    } else if (cur) finish();
  }
  finish();
  R.done = P.finish.done; R.tripped = P.tripped;
  const ps = R.passes, thin = ps.filter(q => q.gap <= 60);
  const frac = (a, f) => a.filter(f).length / Math.max(a.length, 1);

  ok('全パスを過負荷停止せずに通せる', !!R.done && !R.tripped, R.tripped || `${ps.length} パス完走`);
  ok('薄いパス（出側 60 mm 以下）は必ず噛み込みのピークが立つ',
     thin.length > 0 && thin.every(q => q.spikeR >= 1.03),
     thin.map(q => `P${q.pass} ${q.spikeR}`).join(' '));
  ok('薄いパスは頭の荷重がその内側より高い', thin.length > 0 && thin.every(q => q.headR >= 1.03),
     thin.map(q => `P${q.pass} ${q.headR}`).join(' '));
  ok('薄いパスは尻の荷重がその内側より高い', thin.length > 0 && thin.every(q => q.tailR >= 1.03),
     thin.map(q => `P${q.pass} ${q.tailR}`).join(' '));
  ok('全パスの過半で頭・尻とも内側より高い', frac(ps, q => q.headR >= 1.0 && q.tailR >= 1.0) >= 0.5,
     `${Math.round(frac(ps, q => q.headR >= 1.0 && q.tailR >= 1.0) * 100)} %`);
  ok('端部の効きは薄いパスほど強い（出側厚と頭の割増が逆相関）',
     (() => { const a = ps.filter(q => q.gap <= 60), b = ps.filter(q => q.gap > 60);
              return !b.length || !a.length || avg(a.map(q => q.headR)) > avg(b.map(q => q.headR)); })(),
     `薄 ${avg(thin.map(q => q.headR)).toFixed(3)} / 厚 ${avg(ps.filter(q => q.gap > 60).map(q => q.headR)).toFixed(3)}`);
  ok('頭・尻が中央より冷えている（長手方向の温度偏差）', ps.every(q => q.dTend < q.dTmid - 3),
     ps.map(q => `P${q.pass} ${q.dTend}/${q.dTmid}`).slice(0, 4).join(' '));
  ok('板厚制御が発振しない（過渡後のギャップの振れが目標の 5 % 以内）',
     ps.every(q => q.band <= q.gap * 0.05), ps.map(q => `P${q.pass} ${q.band}`).join(' '));
  ok('出側板厚が目標に収まる（±3 %）', ps.every(q => Math.abs(q.hOut - q.gap) <= q.gap * 0.03),
     ps.map(q => `P${q.pass} ${q.hOut}/${q.gap}`).join(' '));
  ok('ピークが非常最大を超えない', ps.every(q => q.spike <= K.MILL.LIMIT_FORCE_T),
     `最大 ${Math.max(...ps.map(q => q.spike))} t / 非常最大 ${K.MILL.LIMIT_FORCE_T} t`);

  R.failed = R.checks.filter(c => !c.pass).length;
  return R;
});

for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log('\npass 別:');
for (const q of out.passes)
  console.log(`  P${String(q.pass).padStart(2)} 出側 ${String(q.gap).padStart(6)} mm  板長 ${String(q.len).padStart(3)} m  ` +
    `衝撃 ${q.spikeR}  頭 ${q.headR}  尻 ${q.tailR}  振れ ${q.band} mm  端部 ${q.dTend} K`);
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
