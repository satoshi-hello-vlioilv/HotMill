// 巻取の «幾何と物理の整合» を実体の座標で検査する。
//  1. 巻き数の積分（板の周速 ÷ 巻き付け半径）と巻いた長さが一致するか（面積式の外径との差）
//  2. 描画される板メッシュが板の入口 A より先へ出ていないか（板がコイルと出側へ二分しない）
//  3. 渡り板の先端がコイルの巻き付け円に接しているか（接線で入る）
//  4. 押えコロがコイル外周（段を含む）に接し、当たりの極角が上側（95〜135°）にあるか
//  5. マンドレルセグメントが拡張時に Φ610、縮小時にそれより小さいか
//  6. ベルトラッパー: 先端が来る前に閉じ切るか、ロールがコイル外周に接するか、
//     所定の巻き数で開くか（マンドレルは板を掴まないので、ここが «巻き始め» を成立させる）
//  （コイルカーはリールの真下に出側テーブルが通っていて成立しないため未実装）
import { openApp, installHelpers } from './harness.mjs';
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, sc = K.SCALE, T = window.__T;
  const F = K.FLIP, C = K.COILER, FV = W.finishView;
  window.__startAuto(false);
  const checks = [], ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });
  const samples = [];
  let expandedR = 0, collapsedR = 0;
  // --- ベルトラッパー / コイルカーの記録 ---
  const WR = C.WRAPPER;
  let wrapAtGrip = null, wrapAfterHold = null, gapClosed = [];
  const rollGaps = () => {                   // 閉じたときのロール面とコイル外周の隙間 [mm]
    const cy = K.MILL.PASS_LINE + C.Y_ABOVE, f = P.finish, s = P.slab;
    const h = s.inBite ? P.mill.gap : s.thickness;
    return FV.wrapRolls.map(w => {
      const dx = w.roll.position.x / sc, dy = w.roll.position.y / sc - cy;
      // コイルは 1 周ごとに段が付くので、当たりの極角での実半径と比べる（押えコロと同じ式）
      const rC = window.__ROLL.coilRadiusAt(Math.atan2(dy, dx), h, f.turns, f.entry, f.windSign);
      return Math.hypot(dx, dy) - C.WRAPPER.ROLL_D / 2 - rC;
    });
  };
  const segR = () => {                       // セグメント外面の実半径（インスタンス行列から）
    const m = new T.Matrix4(), v = new T.Vector3(); let r = 0;
    const g = FV.segments.mesh.geometry.attributes.position;
    for (let i = 0; i < C.SEGMENTS; i++) { FV.segments.mesh.getMatrixAt(i, m);
      for (let j = 0; j < g.count; j += 7) { v.fromBufferAttribute(g, j).applyMatrix4(m); r = Math.max(r, Math.hypot(v.x, v.y) / sc); } }
    return r;
  };
  window.__ff((p, n) => {
    if (n % 60 === 0) W.render(P, 0.5);
    if (n % 60 === 0 && p.finish.expand <= 0) collapsedR = segR();
    if (n % 120 === 0 && p.finish.gripped && !p.finish.done && p.finish.turns > 0.5) {
      const f = p.finish, s = p.slab, h = s.inBite ? p.mill.gap : s.thickness;
      const cy = K.MILL.PASS_LINE + C.Y_ABOVE;
      // 2. 板メッシュの先端
      W.slabView.mesh.geometry.computeBoundingBox();
      const bb = W.slabView.mesh.geometry.boundingBox;
      const headX = W.slabView.mesh.visible ? (F > 0 ? bb.max.x : bb.min.x) / sc : null;
      const Ax = f.entryPoint(h).x;
      // 3. 渡り板の先端（メッシュの +X 端）とコイル中心の距離
      FV.bridge.updateWorldMatrix(true, false);
      const tip = new T.Vector3(0.5, 0, 0).applyMatrix4(FV.bridge.matrixWorld);
      const tipR = Math.hypot(tip.x / sc - C.X, tip.y / sc - cy);
      // 4. 押えコロ
      const hr = FV.holdRoll.position, rx = hr.x / sc, ry = hr.y / sc - cy;
      // 極角は «第1パスが +X» の正準向きで測る（ミル側が −X）。左右反転配置でも同じ値になる
      const rollDist = Math.hypot(rx, ry), rollAng = Math.atan2(ry, F * rx) * 180 / Math.PI;
      const rOut = window.__ROLL.coilRadiusAt(Math.atan2(ry, rx), h, f.turns, f.entry, f.windSign);
      if (f.expand >= 1) expandedR = segR();
      samples.push({ t: +(n / 120).toFixed(0), turns: +f.turns.toFixed(2), layers: f.layers, h: +h.toFixed(1),
        coiledLen: +f.coiledLen.toFixed(0), odArea: +f.od.toFixed(0), odLayers: +(2 * (C.MANDREL_D / 2 + f.turns * h)).toFixed(0),
        headPastA: headX === null ? null : +(F * (headX - Ax)).toFixed(0),
        tipR: +tipR.toFixed(0), layR: +f.layR.toFixed(0),
        rollGap: +(rollDist - rOut - C.HOLD.ROLL_D / 2).toFixed(1), rollAng: +rollAng.toFixed(0) });
    }
    const f = p.finish;
    // 描画は n % 60 で更新されるので、ロール位置を読むのも同じ刻みに合わせる
    // （ずらすと «そのフレームの巻き数» と «描かれている半径» が食い違って見える）
    if (n % 60 === 0) {
      if (wrapAtGrip === null && f.gripped) wrapAtGrip = f.wrap;
      if (f.wrap >= 0.999 && f.gripped) gapClosed.push(...rollGaps());
      if (wrapAfterHold === null && f.turns > WR.TURNS_HOLD + 1) wrapAfterHold = f.wrap;
    }
    return f.done;
  }, 120 * 2500, 0);
  const f = P.finish;
  const last = samples[samples.length - 1];
  const odErr = samples.map(s => Math.abs(s.odArea - s.odLayers) / s.odArea);
  ok('巻き数の積分と巻き長さが整合（外径差 3 % 以内）', Math.max(...odErr) < 0.03, `最大差 ${(Math.max(...odErr) * 100).toFixed(1)} %（最終 Φ${last.odArea} vs 段数から Φ${last.odLayers}）`);
  ok('板メッシュが入口 A より先へ出ない', samples.every(s => s.headPastA === null || s.headPastA <= 2), `最大 ${Math.max(...samples.map(s => s.headPastA ?? -1e9))} mm`);
  ok('渡り板の先端がコイルの巻き付け円に接する', samples.every(s => Math.abs(s.tipR - s.layR) < 3), `最大差 ${Math.max(...samples.map(s => Math.abs(s.tipR - s.layR))).toFixed(1)} mm`);
  ok('押えコロがコイル外周に接する（段込み）', samples.every(s => Math.abs(s.rollGap) < 3), `最大隙間 ${Math.max(...samples.map(s => Math.abs(s.rollGap))).toFixed(1)} mm`);
  ok('押えコロの当たりは上側 95〜135°', samples.every(s => s.rollAng >= 95 && s.rollAng <= 135), `範囲 ${Math.min(...samples.map(s => s.rollAng))}〜${Math.max(...samples.map(s => s.rollAng))}°`);
  // セグメントは各自の二等分線方向にストローク分だけ引っ込む。外接径は角の頂点で決まるので
  // 縮小量は STROKE·cos45° × 2（＝ 42 mm）になる。
  const shrink = 2 * C.SEG_STROKE * Math.cos(Math.PI / 4);
  ok('マンドレル拡張時 Φ610・縮小時は外接径が 42 mm 以上小さい', Math.abs(expandedR * 2 - C.MANDREL_D) < 2 && collapsedR * 2 < C.MANDREL_D - shrink + 3,
     `拡張 Φ${(expandedR * 2).toFixed(0)} / 縮小 Φ${(collapsedR * 2).toFixed(0)}（外接径の減少 ${(C.MANDREL_D - collapsedR * 2).toFixed(0)} mm）`);
  // --- ベルトラッパー ---
  ok('ベルトラッパーは先端が来る前に閉じ切っている（掴む機構が無いので必須）',
     wrapAtGrip !== null && wrapAtGrip >= 0.999, `巻き付き開始時の閉じ度 ${wrapAtGrip === null ? '—' : wrapAtGrip.toFixed(3)}`);
  ok('閉じたラッパーロールがコイル外周に接する', gapClosed.length > 0 && Math.max(...gapClosed.map(Math.abs)) < 3,
     `最大隙間 ${gapClosed.length ? Math.max(...gapClosed.map(Math.abs)).toFixed(1) : '—'} mm（${gapClosed.length} 標本）`);
  ok(`${C.WRAPPER.TURNS_HOLD} 巻きした後にベルトが開く`, wrapAfterHold !== null && wrapAfterHold < 0.05,
     `${C.WRAPPER.TURNS_HOLD}+1 巻き時点の閉じ度 ${wrapAfterHold === null ? '—' : wrapAfterHold.toFixed(3)}`);
  ok('巻取中はマンドレルが拡張したまま（途中で縮んでコイルを落とさない）',
     samples.length > 0 && expandedR * 2 >= C.MANDREL_D - 2, `巻取中の外接径 Φ${(expandedR * 2).toFixed(0)}`);
  return { checks, n: samples.length, first: samples[0], last, turns: +f.turns.toFixed(1) };
});
console.log(JSON.stringify({ first: out.first, last: out.last, turns: out.turns }, null, 1));
for (const c of out.checks) console.log(c.pass ? '  PASS' : '  FAIL', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.n} samples)`);
await browser.close();
