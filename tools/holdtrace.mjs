// コイル押え（巻き広がりを抑える押えコロ）の «当て方» を検査する。
//
// 見たいのは 2 つ。
//   ① シリンダーの推力がそのまま押さえ力になるか
//      —— 胴・ロッド・コロが 1 本の直線に載り、その直線がコイルの中心軸を通ること。
//   ② コロの «外周» がコイルの外周に接しているか（中心を外周に置くと半径ぶん食い込む）。
// どちらも実際のメッシュの世界座標で測る（設計値の突き合わせでは «描けているか» が分からない）。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, S = K.SCALE, T = window.__T;
  const FV = W.coilerView ?? W.finishView, C = K.COILER, H = C.HOLD;
  const v = new T.Vector3(), pos = (o) => { o.getWorldPosition(v); return { x: v.x / S, y: v.y / S, z: v.z / S }; };

  window.__startAuto(true);
  const rows = [];
  let g = 0, last = -1;
  while (g++ < 120 * 1200 && !P.finish.done) {
    P.step(1 / 120);
    const f = P.finish;
    if (f.mode !== 'COIL' || !(f.od > 0) || !f.gripped) continue;
    const turn = Math.floor(f.turns);
    if (turn === last || rows.length >= 14) continue;
    last = turn;
    W.render(P, 1 / 60);
    W.scene.updateMatrixWorld(true);
    const ax = { x: (C.X), y: K.MILL.PASS_LINE + C.Y_ABOVE };     // コイルの中心軸（世界）
    const rc = pos(FV.holdRoll), rd = pos(FV.holdRod), rm = pos(FV.holdRam);
    const dR = Math.hypot(rc.x - ax.x, rc.y - ax.y);
    // コロの «外周» とコイル外周の差。＋が隙間、−が食い込み
    rows.push({ turn, od: +f.od.toFixed(0),
      gap: +(dR - H.ROLL_D / 2 - f.od / 2).toFixed(1),
      // 直線性: コイル軸 → コロ中心 の向きと、コロ → ロッド / ロッド → 胴 の向きの差 [deg]
      aim: +(Math.atan2(rc.y - ax.y, rc.x - ax.x) * 180 / Math.PI).toFixed(2),
      aRod: +(Math.atan2(rd.y - rc.y, rd.x - rc.x) * 180 / Math.PI).toFixed(2),
      aRam: +(Math.atan2(rm.y - rd.y, rm.x - rd.x) * 180 / Math.PI).toFixed(2),
      rodOut: +(Math.hypot(rm.x - rd.x, rm.y - rd.y)).toFixed(0),
      z: +rc.z.toFixed(0) });
  }
  return { rows, angle: H.ANGLE, rollD: H.ROLL_D, baseR: H.BASE_R, coilerX: C.X,
           done: P.finish.done, turns: P.finish.turns };
});
await browser.close();

const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
const R = out.rows;

ok(`巻取中の姿勢を採れた（${R.length} 標本）`, R.length >= 6, R.length);
if (R.length) {
  const gaps = R.map(r => r.gap);
  const worstPen = Math.min(...gaps), worstGap = Math.max(...gaps);
  ok(`コロがコイルへ食い込まない（最悪 ${worstPen.toFixed(1)} mm）`, worstPen >= -6, worstPen.toFixed(1));
  ok(`コロが浮かない（最大の隙間 ${worstGap.toFixed(1)} mm）`, worstGap <= 25, worstGap.toFixed(1));
  // 直線性: コロ → ロッド → 胴 が、コイル軸から見た «外向き» と同じ向きに並ぶ
  const dev = R.flatMap(r => {
    const out180 = (a) => Math.abs(((a - r.aim + 540) % 360) - 180);   // aim の «逆向き» からのずれ
    return [out180(r.aRod), out180(r.aRam)];
  });
  const worstDev = Math.max(...dev);
  ok(`胴・ロッド・コロが 1 直線に載る（最大のずれ ${worstDev.toFixed(2)}°）`, worstDev <= 1, worstDev.toFixed(2));
  const aims = R.map(r => r.aim);
  ok(`押さえる向きがコイルが太っても変わらない（${Math.min(...aims).toFixed(1)}〜${Math.max(...aims).toFixed(1)}°）`,
     Math.max(...aims) - Math.min(...aims) <= 0.5, (Math.max(...aims) - Math.min(...aims)).toFixed(2));
  /* 極角は «上流側へ倒す» 向きなので、入側・出側を左右反転すると 180 − ANGLE になる。
   * どちらでも «コイルの巻き終わり側の上寄り» を指しているので、両方を正とする。 */
  ok(`押さえる極角が設定どおり（実測 ${Math.abs(aims[0]).toFixed(0)}° ＝ ${out.angle}° または ${180 - out.angle}°）`,
     Math.abs(Math.abs(aims[0]) - out.angle) <= 1 || Math.abs(Math.abs(aims[0]) - (180 - out.angle)) <= 1,
     aims[0]);
  ok('押さえる位置がコイルの «上» にある（巻き広がりを上から押さえる）', aims.every(a => a > 20 && a < 160), aims[0]);
  const rods = R.map(r => r.rodOut);
  ok(`ロッドが縮み切らない（最短 ${Math.min(...rods)} mm）`, Math.min(...rods) >= 80, Math.min(...rods));
  ok('コイルが太るとロッドが押し戻される（伸びが単調に縮む）',
     R.every((r, i) => i === 0 || r.rodOut <= R[i - 1].rodOut + 2), rods.join(','));
  ok('コロはコイルの幅の中央に居る', R.every(r => Math.abs(r.z) <= 5), R[0].z);
}

console.log(JSON.stringify({ angle: out.angle, rows: R }, null, 1).slice(0, 2200));
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} ${bad.length ? 'FAIL' : 'PASS'}`);
process.exit(bad.length ? 1 : 0);
