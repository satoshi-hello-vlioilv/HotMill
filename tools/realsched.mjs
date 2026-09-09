// 実機のパススケジュールをそのまま流し、本アプリの圧延モデルと突き合わせる評価器。
//
// 実機データ（A5052、560 厚・片面 15 面削 → 530、1,330 W × 3,450 L）:
//   120 mpm  530→520→490→…→85→65（65 でクロップ）   約 3 分
//   120 mpm  65→56→46→36→26                            約 4 分 30 秒
//    80 mpm  26→16                                      約 1 分 30 秒
//    50 mpm  16→8（巻取）                                約 4 分
// ここでは «実機の圧下配分と速度で通したとき» に本アプリが出す荷重・動力・温度・所要時間を
// パスごとに出し、実機の所要時間および本アプリの自動生成スケジュールと比べる。
//   node tools/realsched.mjs [--temp=500] [--curl]
import { openApp, installHelpers } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TEMP = +opt('temp', 500), MU = opt('mu', null);
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async ({ TEMP, MU }) => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, F = K.FLIP;
  if (MU) K.PROCESS.MU = +MU;
  const REAL = { gaps: [520, 490, 460, 430, 400, 370, 340, 310, 280, 250, 220, 190, 160, 130, 105, 85, 65,
                        56, 46, 36, 26, 16, 8],
                 speed: (i) => i < 21 ? 120 : i === 21 ? 80 : 50,
                 seg: [[0, 17, 180], [17, 21, 270], [21, 22, 90], [22, 23, 240]] };   // [from, to, 実機の秒]
  const d = { cast: 560, scalp: 15, width: 1330, length: 3450, temp: TEMP, alloy: 'A5052', target: 8, trim: 15, mode: 'COIL' };
  const c = document.getElementById('chk-supply-anim'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); }
  A.bus.emit('CMD_SET_SLAB', d);
  await new Promise(r => setTimeout(r, 50));
  const h0 = 560 - 30, al = K.ALLOYS.A5052;
  const gen = R.buildSchedule(h0, 8, 1330, TEMP, { coil: true, length: 3450, alloy: 'A5052' });
  // 実機スケジュールを本アプリの形式へ。予測荷重は本アプリのモデルで «そのパスの入側温度» で解く（比較用）
  let h = h0;
  const real = REAL.gaps.map((g, i) => {
    const v = REAL.speed(i), st = R.solve(h, g, 1330, v, TEMP, 0, al).forceTon;
    const row = { pass: i + 1, gap: g, dir: F * (i % 2 === 0 ? 1 : -1), coil: i === REAL.gaps.length - 1,
                  speed: v, force: Math.round(st * K.PROCESS.PEAK_K), steady: Math.round(st), tEnd: TEMP,
                  bite: +(Math.acos(1 - (h - g) / K.MILL.WR_D) * 180 / Math.PI).toFixed(1) };
    h = g; return row;
  });
  K.SCHEDULE = real;
  A.ui.renderSchedule?.();
  document.getElementById('btn-start').click();
  const s = P.slab, m = P.mill, rows = [];
  let t = 0, cur = -1, wasRolling = false, hd = {}, tl = {};
  while (t < 6000 && !P.finish.done && !P.tripped) {
    P.step(1 / 120); t += 1 / 120;
    if (s.inBite && s.biteFill > 0.99) {                 // 頭（弧が満ちた直後）と尻（最後）の荷重・局所温度
      const u = s.uBite(m.gap), T = s.temperature + s.dTEntry(u);
      if (!wasRolling) hd = { f: m.forceMeas, T };
      tl = { f: m.forceMeas, T };
    }
    const endOfPass = wasRolling && !s.rollingActive; wasRolling = s.rollingActive;
    if (endOfPass && m.passIndex >= 0) {
      const sp = R.curlSpan(s.kNew, s.thickness, s.width, s.alloy);
      rows[m.passIndex] = { k: s.kNew, R_m: Math.abs(s.kNew) > 1e-9 ? 1 / Math.abs(s.kNew) / 1000 : Infinity,
                            kb: s.kBite, tip: sp.tip, lift: sp.liftOff, top: s.tTop, bot: s.tBot, Tm: s.temperature, len: s.length,
                            fHead: hd.f, fTail: tl.f, Thead: hd.T, Ttail: tl.T };
    }
  }
  const log = P.log.rows;
  const passes = log.map((r, i) => ({ ...r, ...(rows[i] || {}), plan: real[i] }));
  const segs = REAL.seg.map(([a, b, realSec]) => {
    const p = log.slice(a, b);
    const sim = p.length ? (p[p.length - 1].sec === null ? null : log[b - 1].t1 !== undefined ? null : null) : null;
    return { a, b, realSec, n: p.length };
  });
  // 区間時間はロットの時系列 t0/t1 から
  const t0 = (i) => P.log.passes[i]?.t0, t1 = (i) => P.log.passes[i]?.t1;
  for (const sg of segs) sg.simSec = (t0(sg.a) !== undefined && t1(sg.b - 1) != null) ? t1(sg.b - 1) - t0(sg.a) : null;
  return { passes, gen, segs, done: P.finish.done, tripped: P.tripped, total: P.log.lot?.t,
           coil: { od: P.finish.od, mass: P.finish.coilMass } };
}, { TEMP, MU });

const f0 = (x, w = 6) => (x == null || !Number.isFinite(x) ? '–' : Math.round(x)).toString().padStart(w);
const f1 = (x, w = 6) => (x == null || !Number.isFinite(x) ? '–' : (+x).toFixed(1)).toString().padStart(w);
console.log(`炉出し ${TEMP} ℃ / 完走 ${out.done} / 停止 ${out.tripped || 'なし'} / 総時間 ${f0(out.total)} s`);
console.log('pass 出側  圧下率  速度 噛込角 | 荷重max  荷重avg  予測  動力MW | 入温 出温 | 板長 m  所要 s  圧延 s | 上下ΔT  κ_bite     反り R[m]  先端 mm | 頭 t / 尻 t  尻局所℃');
for (const p of out.passes) {
  console.log(`${String(p.no).padStart(3)} ${f0(p.hOut, 5)} ${f1(p.red, 6)}% ${f0(p.vMax, 4)} ${f1(p.plan?.bite, 5)}° | ` +
    `${f0(p.fMax, 7)} ${f0(p.fAvg, 8)} ${f0(p.plan?.steady, 6)} ${f1(p.pMax, 6)} | ${f0(p.tIn, 4)} ${f0(p.tOut, 4)} | ` +
    `${f1(p.len / 1000, 6)} ${f1(p.sec, 6)} ${f1(p.len / (p.vMax / 60 * 1000), 6)} | ${f1(p.bot - p.top, 6)} ${(p.kb ?? 0).toExponential(1).padStart(9)} ${f1(p.R_m, 9)} ${f0(p.tip, 8)} | ${f0(p.fHead, 5)} / ${f0(p.fTail, 5)} ${f0(p.Ttail, 5)}`);
}
console.log('\n区間時間（実機 vs 本アプリ）:');
for (const sg of out.segs) console.log(`  パス ${sg.a + 1}〜${sg.b}: 実機 ${sg.realSec} s / 本アプリ ${f0(sg.simSec)} s`);
console.log('\n本アプリの自動生成スケジュール（同じ素材）:');
console.log('  ' + out.gen.map(q => `${q.gap}@${q.speed}`).join(' → ') + `  （${out.gen.length} パス）`);
await browser.close();
