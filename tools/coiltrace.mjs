// 巻取の «幾何と物理の整合» を実体の座標で検査する。
//  1. 巻き数の積分（板の周速 ÷ 巻き付け半径）と巻いた長さが一致するか（面積式の外径との差）
//  2. 描画される板メッシュが板の入口 A より先へ出ていないか（板がコイルと出側へ二分しない）
//  3. 渡り板の先端がコイルの巻き付け円に接しているか（接線で入る）
//  4. 押えコロがコイル外周（段を含む）に接し、当たりの極角が上側（95〜135°）にあるか
//  5. マンドレルセグメントが拡張時に Φ610、縮小時にそれより小さいか
//  6. ベルトラッパー: 先端が来る前に閉じ切るか、ロールがコイル外周に接するか、
//     所定の巻き数で開くか（マンドレルは板を掴まないので、ここが «巻き始め» を成立させる）
//  7. コイルカー: 受け取り → マンドレル縮小 → 搬出 → 降ろす、の順に進むか。
//     受け取り時にデッキ上面がコイル下端と一致するか（浮き／めり込みが無いか）
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
  let wrapAtGrip = null, wrapAfterHold = null, gapClosed = [], beltErr = [];
  let carOrder = [], deckErr = null, coilZ = null;
  // ラッパーは «マンドレル芯を原点» にしたグループ（FV.wrap）の中にあるので、
  // ロールの position はそのまま芯からの相対座標になる（芯高さを引かない）
  const rollGaps = () => {                   // 閉じたときのロール面とコイル外周の隙間 [mm]
    const f = P.finish, s = P.slab;
    const h = s.inBite ? P.mill.gap : s.thickness;
    return FV.wrapRolls.map(w => {
      const dx = w.roll.position.x / sc, dy = w.roll.position.y / sc;
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
      if (f.wrap >= 0.999 && f.gripped) {
        gapClosed.push(...rollGaps());
        // ベルトの実寸（頂点の座標）をロールの外接半径と突き合わせる。
        // ベルトは «3 本のロールに掛かる帯» を毎フレーム作るので、いちばん外のロールの
        // 外接半径がそのままベルトの最大半径になる
        const rMax = Math.max(...FV.wrapRolls.map(w => Math.hypot(w.roll.position.x / sc, w.roll.position.y / sc)));
        const bp = FV.belt.geometry.attributes.position, bv = new T.Vector3();
        let rb = 0;
        for (let i = 0; i < bp.count; i++) { bv.fromBufferAttribute(bp, i); rb = Math.max(rb, Math.hypot(bv.x / sc, bv.y / sc)); }
        beltErr.push(Math.abs(rb - (rMax + C.WRAPPER.ROLL_D / 2 + C.WRAPPER.BELT_T / 2)));
      }
      if (wrapAfterHold === null && f.turns > WR.TURNS_HOLD + 1) wrapAfterHold = f.wrap;
    }
    // 工程の記録は «毎ステップ»。n%60 に間引くと、REST になった瞬間にループを抜けるので
    // 最後の工程を取りこぼす（検査が «SET で止まった» ように見えてしまう）。
    if (carOrder[carOrder.length - 1] !== f.carStage) carOrder.push(f.carStage);
    if (f.carStage === 'STRIP' && deckErr === null) {            // 受け取り切った瞬間
      W.render(P, 0.1);
      // V 受けなのでコイル芯は «デッキ上面 + V での芯高さ» に来る（下端が上面に一致するのではない）
      const rC = Math.max(f.od, C.MANDREL_D) / 2;
      deckErr = (FV.coil.position.y / sc - FV.car.position.y / sc) - window.__CRADLE.centerY(rC);
    }
    return f.carStage === 'REST';
  }, 120 * 2500, 0);
  const f = P.finish;
  W.render(P, 0.1);
  coilZ = FV.coil.position.z / sc;                               // 搬出し終えた位置は «ループを抜けたあと» に読む
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
  ok('ベルトの半径がロール外周と一致する（単位系の取り違えが無い）',
     beltErr.length > 0 && Math.max(...beltErr) < 3, `最大差 ${beltErr.length ? Math.max(...beltErr).toFixed(1) : '—'} mm`);
  ok(`${C.WRAPPER.TURNS_HOLD} 巻きした後にベルトが開く`, wrapAfterHold !== null && wrapAfterHold < 0.05,
     `${C.WRAPPER.TURNS_HOLD}+1 巻き時点の閉じ度 ${wrapAfterHold === null ? '—' : wrapAfterHold.toFixed(3)}`);
  ok('巻取中はマンドレルが拡張したまま（途中で縮んでコイルを落とさない）',
     samples.length > 0 && expandedR * 2 >= C.MANDREL_D - 2, `巻取中の外接径 Φ${(expandedR * 2).toFixed(0)}`);
  // --- コイルカー ---
  ok('コイルカーが 受け取り → マンドレル縮小 → 搬出 → 降ろす の順に進む',
     ['IDLE', 'APPROACH', 'LIFT', 'STRIP', 'CARRY', 'SET', 'REST'].every((v, i) => carOrder[i] === v), carOrder.join(' → '));
  ok('マンドレルはカーが受けてから縮小する（コイルを落とさない）',
     carOrder.indexOf('LIFT') > 0 && carOrder.indexOf('LIFT') < carOrder.indexOf('STRIP'), carOrder.join(' → '));
  // 待機はリール下ではなく搬出位置。圧延中はリール下に板が通るので、そこで待つと当たる
  ok('コイルカーは圧延中リール下に居ない（搬出位置で待機する）',
     carOrder[0] === 'IDLE' && carOrder[1] === 'APPROACH', `待機 → ${carOrder[1] ?? '—'}`);
  ok('受け取り時にコイルが V 受けに正しく載る（浮き／めり込みが無い）',
     deckErr !== null && Math.abs(deckErr) < 3, `差 ${deckErr === null ? '—' : deckErr.toFixed(1)} mm`);
  ok('搬出後のコイルがマンドレルの外（操作側）にある',
     coilZ !== null && coilZ >= C.CAR.TRAVEL_Z - 5, `コイル Z ${coilZ === null ? '—' : coilZ.toFixed(0)} mm（搬出 ${C.CAR.TRAVEL_Z}）`);
  return { checks, n: samples.length, first: samples[0], last, turns: +f.turns.toFixed(1) };
});
console.log(JSON.stringify({ first: out.first, last: out.last, turns: out.turns }, null, 1));
for (const c of out.checks) console.log(c.pass ? '  PASS' : '  FAIL', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.n} samples)`);
await browser.close();
