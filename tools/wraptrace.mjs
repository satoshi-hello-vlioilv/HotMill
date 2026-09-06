// ベルトラッパーが «設備として» 成立しているかを見る評価器。
//
// なぜ要るか: 以前の実装は «巻き付けている間だけ現れて、終わると消える» もので、
// 待機中は belt.visible = false・ロール 3 本とも false、つまり設備が存在しなかった。
// さらにアームが scale で伸び縮みしていた（剛体の揺動アームになっていなかった）。
// 「常にそこにあり、腕の長さは変わらず、コイルの通り道を塞がない」ことを実測で縛る。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const T = window.__T = window.__T || await import('/__three__');
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, sc = K.SCALE;
  const C = K.COILER, WR = C.WRAPPER, FV = W.finishView;
  const R = { checks: [], log: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: d });
  const mm = v => +(+v).toFixed(0);
  const cy = K.MILL.PASS_LINE + C.Y_ABOVE;                 // マンドレル芯の床上高さ
  const wrapperCfg = () => WR;

  // --- 静的な取り合い（架構）------------------------------------------------
  const bb = (name) => {
    let f = null; W.scene.traverse(o => { if (o.name === name && !f) f = o; });
    if (!f) return null;
    const b = new T.Box3().setFromObject(f);
    return { x: [b.min.x / sc, b.max.x / sc], y: [b.min.y / sc, b.max.y / sc], z: [b.min.z / sc, b.max.z / sc] };
  };
  W.render(P, 1 / 60);
  const fr = bb('ラッパー架台');
  ok('ラッパー架台がある', !!fr, fr ? `x ${mm(fr.x[0])}〜${mm(fr.x[1])} / y ${mm(fr.y[0])}〜${mm(fr.y[1])} / z ${mm(fr.z[0])}〜${mm(fr.z[1])}` : '—');

  // 架構の三角形を全部取り、«マンドレル軸からの距離» と Z で通り道を侵していないか見る
  const tri = [];
  {
    for (const nm of ['ラッパー架台', 'ラッパーキャリッジ']) {
      let f = null; W.scene.traverse(o => { if (o.isMesh && o.name === nm && !f) f = o; });
      if (!f) continue;
      f.updateWorldMatrix(true, false);
      const pos = f.geometry.attributes.position, idx = f.geometry.index, v = new T.Vector3();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i++) {
        const j = idx ? idx.getX(i) : i;
        v.fromBufferAttribute(pos, j).applyMatrix4(f.matrixWorld);
        tri.push([v.x / sc - C.X, v.y / sc, v.z / sc]);     // リール中心を原点にした mm
      }
    }
  }
  // コイルの通り道: 半径 OD_MAX/2 の円筒（軸 = Z、芯 = マンドレル芯）。搬出は Z 方向なので全長で見る
  const rCoil = C.OD_MAX / 2;
  let inCoil = 0, worstCoil = 0;
  for (const [x, y] of tri) {
    const r = Math.hypot(x, y - cy);
    if (r < rCoil) { inCoil++; worstCoil = Math.max(worstCoil, rCoil - r); }
  }
  ok('架台とキャリッジがコイルの通り道（Φ' + C.OD_MAX + '）に入らない', inCoil === 0,
     inCoil === 0 ? `最小の逃げ ${mm(Math.min(...tri.map(([x, y]) => Math.hypot(x, y - cy))) - rCoil)} mm` : `${inCoil} 点 / 最大 ${mm(worstCoil)} mm`);
  // コイルカーの走行域: |z| ≤ W/2、床から待機デッキ上面まで
  const carZ = C.CAR.W / 2;
  let inCar = 0;
  for (const [, y, z] of tri) if (Math.abs(z) < carZ && y < C.CAR.REST_Y) inCar++;
  ok('架台がコイルカーの走行域（|z| < ' + carZ + '）に立っていない', inCar === 0, `${inCar} 点`);
  // 床に着く脚は駆動側だけ（操作側の床に何も立っていない）
  const legOS = tri.filter(([, y, z]) => y < 200 && z > 0).length;
  const legDS = tri.filter(([, y, z]) => y < 200 && z < 0).length;
  ok('床へ降ろす脚は駆動側だけ', legOS === 0 && legDS > 0, `駆動側 ${legDS} 点 / 操作側 ${legOS} 点`);

  // --- 可動部（アーム・ロール・ベルト）--------------------------------------
  const armErr = [], visMiss = [], beltErr = [], digIn = [];
  const wv0 = new T.Vector3();
  const rollR = () => FV.wrapRolls.map(w => { w.roll.getWorldPosition(wv0);
    return Math.hypot(wv0.x / sc - C.X, wv0.y / sc - cy); });
  let closedR = null, parkR = null, lowPark = null;
  const sample = (tag) => {
    W.render(P, 1 / 120);            // __ff は物理だけを進めるので、実測の前に必ず 1 フレーム描く
    const fin = P.finish;
    if (!(FV.belt.visible && FV.wrapRolls.every(w => w.roll.visible && w.arms.every(m => m.visible)))) visMiss.push(tag);
    const wv = new T.Vector3();
    const rollXY = (w) => { w.roll.getWorldPosition(wv); return { x: wv.x / sc - C.X, y: wv.y / sc - cy }; };
    for (const w of FV.wrapRolls) {
      const rc0 = rollXY(w);
      const cx = rc0.x, cyr = rc0.y;                        // マンドレル芯を原点にした mm
      const o = FV.cradle.position;                        // キャリッジは平行移動だけ
      const pw = { x: w.pivot.x + o.x / sc, y: w.pivot.y + o.y / sc };
      armErr.push(Math.abs(Math.hypot(cx - pw.x, cyr - pw.y) - window.__WRAP.armL(w.i)));
      // 巻いている最中はコイル外周より内側へ入らない
      // 描画側と同じ «その極角での実半径» を使う（板厚は噛み込み中ならギャップ）
      const wound = (fin.gripped || fin.threading) && fin.turns > 0.002;
      const hh = P.slab.inBite ? P.mill.gap : P.slab.thickness;
      const rc = wound ? window.__ROLL.coilRadiusAt(w.th, hh, fin.turns, fin.entry, fin.windSign) : C.MANDREL_D / 2;
      digIn.push(rc + WR.ROLL_D / 2 - Math.hypot(cx, cyr));
    }
    // ベルトはロールの外周に接する（各頂点は必ずどれかのロールから ROLL_D/2 + BELT_T/2 以上）
    const bp = FV.belt.geometry.attributes.position, v = new T.Vector3();
    const rb = WR.ROLL_D / 2 + WR.BELT_T / 2;
    const rc = FV.wrapRolls.map(w => ({ x: w.roll.position.x / sc, y: w.roll.position.y / sc }));
    let near = 1e9;
    for (let i = 0; i < bp.count; i++) {
      v.fromBufferAttribute(bp, i);
      const x = v.x / sc, y = v.y / sc;                     // ベルトもロールもキャリッジ座標
      near = Math.min(near, Math.min(...rc.map(q => Math.hypot(x - q.x, y - q.y))));
    }
    beltErr.push(near - rb);
    if (closedR === null && fin.wrap >= 0.999) closedR = rollR();   // «閉じ切った» 最初の 1 点
    if (fin.wrap <= 0.001) {                                        // 退避し切っているとき
      parkR = rollR();
      let lo = 1e9;
      for (const o of [FV.belt, ...FV.wrapRolls.map(w => w.roll), ...FV.wrapRolls.flatMap(w => w.arms)]) {
        const b = new T.Box3().setFromObject(o); lo = Math.min(lo, b.min.y / sc);
      }
      lowPark = lowPark === null ? lo : Math.min(lowPark, lo);
    }
    R.log.push(`${tag}\twrap ${(fin.wrap ?? 0).toFixed(2)}\tturns ${(fin.turns ?? 0).toFixed(1)}\tr ${rollR().map(mm).join('/')}`);
  };

  sample('待機');
  window.__startAuto(false);
  const seen = { close: false, hold: false, park: false, off: false };
  window.__ff((p) => {
    const f = p.finish;
    if (!seen.close && f.wrap >= 0.999) { seen.close = true; sample('閉'); }
    if (!seen.hold && f.turns > 1 && f.wrap > 0.5) { seen.hold = true; sample('巻付'); }
    if (!seen.park && f.turns > WR.TURNS_HOLD + 2) { seen.park = true; sample('開'); }
    if (!seen.off && f.coilOff) { seen.off = true; sample('搬出'); }
    return seen.close && seen.hold && seen.park && seen.off;
  }, 120 * 3000);

  ok('ラッパーが全工程で見えている（設備として常設）', visMiss.length === 0,
     visMiss.length ? `見えない工程: ${visMiss.join(',')}` : `${R.log.length} 点で確認`);
  ok('アームの長さが変わらない（剛体の揺動アーム）', Math.max(...armErr) < 1,
     `最大の誤差 ${Math.max(...armErr).toFixed(2)} mm / 設計 ${WR.ARM_T.map(Math.abs).join('/')} mm`);
  ok('退避位置は最大コイルの外', parkR !== null && Math.min(...parkR) - WR.ROLL_D / 2 >= C.OD_MAX / 2,
     parkR ? `いちばん内側のロール面 ${mm(Math.min(...parkR) - WR.ROLL_D / 2)} mm ≥ コイル半径 ${C.OD_MAX / 2} mm` : '—');
  ok('退避時にラッパーが板の通り道（パスライン + 板厚）へ入らない', lowPark !== null && lowPark >= WR.CLEAR_Y,
     lowPark === null ? '—' : `いちばん低い点 ${mm(lowPark)} mm ≥ ${WR.CLEAR_Y} mm`);
  const rClosed = C.MANDREL_D / 2 + WR.ROLL_D / 2;
  ok('閉じるとロール面がマンドレル外周に接する',
     closedR && Math.max(...closedR.map(r => Math.abs(r - rClosed))) < 1,
     closedR ? `閉じたときの半径 ${closedR.map(mm).join('/')} mm（設計 ${mm(rClosed)}）` : '閉じた状態を観測できず');
  ok('ロールがコイル外周へ食い込まない', Math.max(...digIn) < 1,
     `最大の食い込み ${Math.max(...digIn).toFixed(2)} mm`);
  ok('ベルトがロールの外周に掛かる', Math.abs(Math.min(...beltErr)) < 1,
     `ロール面からベルトまで ${(Math.min(...beltErr) + WR.ROLL_D / 2 + WR.BELT_T / 2).toFixed(1)} mm（設計 ${WR.ROLL_D / 2 + WR.BELT_T / 2}）`);
  // 押し込みの途中でマンドレルに当たらないか（C の口が押し込みの向きへ開いているか）
  {
    const WR2 = window.__WRAP, rM = C.MANDREL_D / 2;
    let worst = 1e9, at = 0;
    for (let k = 0; k <= 40; k++) {
      const w = k / 40, off = WR2.offset(w);
      for (let i = 0; i < WR.N; i++) {
        const c = WR2.at(i, WR2.phiAt(i, WR2.rClosed, w));
        const d = Math.hypot(c.x + off.x, c.y + off.y) - WR.ROLL_D / 2 - rM;
        if (d < worst) { worst = d; at = w; }
      }
      for (const p of [...Array(WR.N).keys()].map(i => WR2.pivot(i)).concat([WR2.hitch])) {
        const d = Math.hypot(p.x + off.x, p.y + off.y) - WR.FRAME_W / 2 - rM;
        if (d < worst) { worst = d; at = w; }
      }
    }
    ok('押し込みの途中でキャリッジがマンドレルに当たらない', worst >= -1,
       `いちばん近づく隙間 ${worst.toFixed(0)} mm（押し込み度 ${at.toFixed(2)}）`);
  }
  const bz = bb('ラッパーベルト');
  ok('ベルトの面長がロールの面長と一致', bz && Math.abs((bz.z[1] - bz.z[0]) - WR.FACE) < 1,
     `${mm(bz.z[1] - bz.z[0])} mm / ロール ${WR.FACE} mm`);
  return R;
});

for (const l of out.log) console.log('  ' + l);
console.log('');
for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name} — ${c.detail}`);
const bad = out.checks.filter(c => !c.pass).length;
console.log(`\nRESULT: ${bad ? 'FAIL' : 'PASS'} (${out.checks.length - bad}/${out.checks.length})`);
await browser.close();
process.exit(bad ? 1 : 0);
