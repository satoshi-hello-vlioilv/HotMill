// ピットクレーン（装入クレーン）の «実際に動く速度» を工程ごとに実測し、
// 定格速度（CONFIG.CRANE.SPEED）と実機の一般値に収まっているかを見る。
//
// 秒数を手で置く方式だと、炉の位置や桁の高さを動かした瞬間に速度が壊れる
// （走行 77 m を 4.6 秒＝約 1,000 m/min で走っていた）。この評価器は
// «距離と時間から出した速度» そのものを見るので、その壊れ方を必ず捕まえる。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, L = window.__LAYOUT;
  const SV = W.supplyView, SP = K.CRANE.SPEED;
  const DT = 1 / 240;                                   // 速度の山を見逃さない細かさ

  // 工程 → 見る軸（クレーンが動かす方向）。ピットクレーンとトランスファークレーンの両方。
  // dive（吊具だけを炉へ降ろす）はスラブが動かないので、この測り方では見えない。
  // 所要秒だけを別に確かめる（下の diveSec）。
  const AXIS = { hoist: 'y', travel: 'x', traverse: 'z', set: 'y', grab: 'y', transfer: 'z', lower: 'y' };
  const MV = K.CRANE_MOVES;
  /* 判定に使うのは «運転速度» ＝ 仕様書の定格 × CONFIG.CRANE_SPEED_K。仕様の表はそのまま
   * 残し、見せる速さだけを倍率で変えているので、実体と突き合わせるのはこちら。 */
  const RATED = Object.fromEntries(Object.keys(AXIS).map(k => [k, K[MV[k].by].SPEED[MV[k].v] * K.CRANE_SPEED_K]));
  const CRANE_OF = Object.fromEntries(Object.keys(AXIS).map(k => [k, MV[k].by]));

  P.reset();
  A.bus.emit('CMD_START_SUPPLY');
  const sup = P.supply, slab = P.slab, passY = P.mill.passLine;
  const path = L.supplyPath(slab, passY);

  const seen = {};                                       // key → { d, sec, vMax, vStart, vEnd, n }
  let prev = null, t = 0, guard = 0;
  while (sup.active && guard++ < 400000) {
    const ph = sup.phase, key = K.SEQUENCE[sup.step][1];
    const pose = SV._pose(sup, slab, passY);
    if (AXIS[key]) {
      const ax = AXIS[key], s = seen[key] ||= { d: Math.abs(path.move[MV[key].d]), sec: 0, vMax: 0, v: [], n: 0 };
      if (prev && prev.key === key) {
        const v = Math.abs(pose[ax] - prev[ax]) / DT;    // mm/s
        s.vMax = Math.max(s.vMax, v); s.v.push(v); s.sec += DT; s.n++;
      }
      prev = { key, x: pose.x, y: pose.y, z: pose.z };
    } else prev = null;
    P.step(DT); t += DT;
  }

  const mpm = (v) => v * 60 / 1000;
  const rows = Object.entries(seen).map(([key, s]) => {
    // 発進・停止が «瞬時» でないことを見るので、最初と最後の 1 標本そのものを見る
    // （区間平均にすると加速時間が短い工程で山に埋もれ、判定にならない）。
    const vStart = s.v[0], vEnd = s.v[s.v.length - 1];
    return { key, axis: AXIS[key], d_m: +(s.d / 1000).toFixed(2), sec: +s.sec.toFixed(2),
             vMax: +mpm(s.vMax).toFixed(1), vMean: +mpm(s.d / s.sec).toFixed(1),
             vStart: +mpm(vStart).toFixed(1), vEnd: +mpm(vEnd).toFixed(1),
             rated: RATED[key], by: CRANE_OF[key], predSec: +L.moveSec(key, slab, passY).toFixed(2) };
  });
  const diveSec = +L.moveSec('dive', slab, passY).toFixed(2);
  const hoistSec = +L.moveSec('hoist', slab, passY).toFixed(2);
  return { rows, speed: SP, tspeed: K.TRANSFER.SPEED, kSpeed: K.CRANE_SPEED_K, diveSec, hoistSec,
           totalSec: +t.toFixed(1), done: !sup.active,
           seq: K.SEQUENCE.map(q => ({ ph: q[0], key: q[1], fixed: q[2], dur: +(sup.dur[q[1]] || 0).toFixed(2) })) };
});
await browser.close();

// --- 判定 ---------------------------------------------------------------
// 実機の一般値（装入・ソーキングピットクレーン）。ここを外れる定格はそもそも設定ミス。
const NORM = { TRAVEL: [60, 150], TRAVERSE: [20, 60], HOIST: [8, 25] };
const checks = [];
const ok = (name, cond, got) => checks.push({ name, pass: !!cond, got });

ok('装入シーケンスが完走する', out.done, out.done);
/* 運転速度の倍率。仕様書の定格は «一般値» の判定でそのまま見張ったうえで、画面で追える
 * 速さにするための倍率を別に持つ。1.0 に戻せば仕様どおりの速さで動く。 */
ok(`運転速度の倍率が ${out.kSpeed} 倍（仕様の定格はそのまま残す）`,
   out.kSpeed >= 1 && out.kSpeed <= 5,
   `走行 ${out.speed.TRAVEL}→${out.speed.TRAVEL * out.kSpeed} ／ 横行 ${out.speed.TRAVERSE}→${out.speed.TRAVERSE * out.kSpeed}`
   + ` ／ 巻上 ${out.speed.HOIST}→${out.speed.HOIST * out.kSpeed} m/min`);
for (const [k, [lo, hi]] of Object.entries(NORM))
  ok(`定格 ${k} = ${out.speed[k]} m/min が一般値 ${lo}〜${hi} の範囲`, out.speed[k] >= lo && out.speed[k] <= hi, out.speed[k]);
// 空荷の巻上（吊具だけを降ろす）は定格より速い —— インバータ制御の巻上装置の実機どおり
ok(`空荷の巻上が定格の 1.5〜2.5 倍（${out.speed.HOIST_EMPTY} / ${out.speed.HOIST} m/min）`,
   out.speed.HOIST_EMPTY >= out.speed.HOIST * 1.5 && out.speed.HOIST_EMPTY <= out.speed.HOIST * 2.5,
   out.speed.HOIST_EMPTY);
ok(`炉へ降ろす工程が吊り上げより速い（${out.diveSec} s < ${out.hoistSec} s）`,
   out.diveSec < out.hoistSec * 0.75, `${out.diveSec} / ${out.hoistSec}`);
ok(`加速度 ${out.speed.ACCEL} m/s² が 0.2〜0.8 の範囲`, out.speed.ACCEL >= 0.2 && out.speed.ACCEL <= 0.8, out.speed.ACCEL);
for (const [k, [lo, hi]] of Object.entries(NORM))
  if (out.tspeed[k] !== undefined)
    ok(`トランスファー 定格 ${k} = ${out.tspeed[k]} m/min が一般値 ${lo}〜${hi} の範囲`,
       out.tspeed[k] >= lo && out.tspeed[k] <= hi, out.tspeed[k]);

for (const r of out.rows) {
  ok(`${r.key}: 最大速度 ${r.vMax} ≤ 運転速度 ${r.rated} m/min`, r.vMax <= r.rated * 1.02, r.vMax);
  // 十分に長い移動（ランプ 2 本ぶんより長い）は定格まで上がりきるはず
  const acc = (r.by === 'TRANSFER' ? out.tspeed : out.speed).ACCEL;
  const dRamp = (r.rated * 1000 / 60) ** 2 / (acc * 1000) / 1000;   // [m]
  if (r.d_m > dRamp * 1.5)
    ok(`${r.key}: 運転速度まで加速しきる（最大 ${r.vMax} ≥ ${(r.rated * 0.95).toFixed(0)}）`, r.vMax >= r.rated * 0.95, r.vMax);
  ok(`${r.key}: 発進が瞬時でない（初速 ${r.vStart} < 運転速度の 5 %）`, r.vStart < r.rated * 0.05, r.vStart);
  ok(`${r.key}: 停止が瞬時でない（終速 ${r.vEnd} < 運転速度の 5 %）`, r.vEnd < r.rated * 0.05, r.vEnd);
  ok(`${r.key}: 加減速がある（平均 ${r.vMean} < 最大 ${r.vMax}）`, r.vMean < r.vMax * 0.995, r.vMean);
  ok(`${r.key}: 所要秒が距離÷運転速度と一致（実測 ${r.sec} / 予測 ${r.predSec}）`,
     Math.abs(r.sec - r.predSec) <= Math.max(0.15, r.predSec * 0.03), r.sec);
}

console.log(JSON.stringify({ speed: out.speed, rows: out.rows, totalSec: out.totalSec }, null, 2));
const bad = checks.filter(c => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
console.log(`\n${checks.length - bad.length}/${checks.length} ${bad.length ? 'FAIL' : 'PASS'}`);
process.exit(bad.length ? 1 : 0);
