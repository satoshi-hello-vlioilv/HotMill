// 配置・機構の «成立» を数値で判定する評価器（今回の指摘 1〜5 に対応）。
//  1. 装入ローラ: 回転が «ローラ軸まわり» か（軸から外れた部材が一緒に振れていないか）、
//     回転の向きが材料の進行方向と一致するか、横送りローラが上昇時に主テーブルローラ面より上で板を運ぶか
//  2. 板面クーラント: サイドガイド上にヘッダがあり、熱モデルに板面冷却域があるか
//  3. 断面表示: 75 mm シャーの手前側と天面（クロスヘッド・上刃ホルダ）が半断面で透過するか
//  4. 端材: 切り落とした端材が板端の変形（舌・ワニ口）を保っているか、最終的にパレット上に載るか
//  5. テーブル: 図面の区分（本数・ピッチ・区間長）どおりにローラが並ぶか、シャー周辺のピッチ
import { openApp, installHelpers } from './harness.mjs';

const { browser, page, errors } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, sc = K.SCALE, T = window.__T;
  const R = { checks: [] };
  const ok = (name, pass, detail) => R.checks.push({ name, pass: !!pass, detail });
  const sg = v => (Math.abs(v) < 1e-6 ? 0 : Math.sign(v));
  const mm = v => Math.round(v);

  // --- ヘルパ: インスタンス i の回転（オイラー）と位置を読む ---
  const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), p3 = new T.Vector3(), s3 = new T.Vector3();
  const inst = (mesh, i) => { mesh.getMatrixAt(i, m4); m4.decompose(p3, q, s3); e.setFromQuaternion(q);
    return { x: p3.x / sc, y: p3.y / sc, z: p3.z / sc, rx: e.x, ry: e.y, rz: e.z }; };
  // ジオメトリの «軸から外れた» 部分: axis まわりの最大半径 ÷ 公称半径（1 なら純粋な回転体）
  const offAxis = (geo, axis, r0) => {
    const pos = geo.attributes.position; let rMax = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) / sc, y = pos.getY(i) / sc, z = pos.getZ(i) / sc;
      const r = axis === 'x' ? Math.hypot(y, z) : axis === 'y' ? Math.hypot(x, z) : Math.hypot(x, y);
      rMax = Math.max(rMax, r);
    }
    return rMax / r0;
  };

  /* ================= 1. 装入（転倒機 → トランスファークレーン） ================= */
  const SV = W.supplyView, S = K.SUPPLY, F = K.FLIP, TR = K.TRANSFER, PL0 = K.MILL.PASS_LINE;
  R.supply = {};
  {
    // 転倒機ベッドと受取テーブルは «テーブルローラ» で構成されている
    const TG = TR.TONG, rr = K.TABLE.ROLL_D_END / 2, zOpen = TG.W_MAX / 2 - TG.JAW_T;
    ok('転倒機ベッドと受取テーブルがテーブルローラで構成されている',
       SV.bedRolls.xs.length >= 3 && SV.runoutRolls.xs.length >= 3,
       `ベッド ${SV.bedRolls.xs.length} 本 / 受取 ${SV.runoutRolls.xs.length} 本`);
    window.__startAuto(true);

    // --- 送り（FEED）: ローラが «転がり条件» どおりに回り、板が FEED_DX だけ進む ---
    const locX = () => F * (SV.slab.position.x / sc - S.TILTER_X);   // 転倒軸ローカルの板中心 X
    const rz = (rt) => inst(rt.inst.mesh, 0).rz;
    const wrap = (v) => ((v + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    window.__ff(Pp => Pp.supply.phase === 'FEED'); W.render(P, 1 / 60);
    const xF0 = locX(), aB0 = rz(SV.bedRolls);
    window.__ff(Pp => Pp.supply.phase !== 'FEED'); W.render(P, 1 / 60);
    const fed = locX() - xF0;
    // 板が +X へ進むとき上面も +X へ動く向き＝ −Z 回り。角度は 1 回転を超えるので位相で比べる
    const slipMm = Math.abs(wrap(rz(SV.bedRolls) - aB0 + fed / rr)) * rr;
    ok('テーブルローラの送り量が FEED_DX に一致する', Math.abs(fed - S.FEED_DX) < 5, `送り ${mm(fed)} / ${S.FEED_DX} mm`);
    ok('ローラの回転が送り量と一致する（転がり条件・すべりが無い）', slipMm < 20, `すべり ${slipMm.toFixed(1)} mm`);
    ok('受取テーブルのローラがベッドと同じだけ回る', Math.abs(wrap(rz(SV.runoutRolls) - rz(SV.bedRolls))) < 1e-6,
       `差 ${(rz(SV.runoutRolls) - rz(SV.bedRolls)).toExponential(1)} rad`);

    // 送り終わり: スラブは受取テーブル上（底面＝パスライン）、トングは開いている
    window.__ff(Pp => Pp.supply.phase === 'GRAB'); W.render(P, 1 / 60);
    const th = P.slab.thickness, w = P.slab.width;
    const bot0 = SV.slab.position.y / sc - th / 2, z0 = SV.slab.position.z / sc;
    // 爪の «内面下端» をアームのワールド行列で実測する（描かれている姿勢そのものを測る）
    const jv = new T.Vector3();
    const jaws = () => { const out = [];
      for (const tg of SV.tongs) for (const arm of tg.arms) {
        arm.updateWorldMatrix(true, false);
        jv.set(0, -TG.PIVOT_H * sc, zOpen * sc).applyMatrix4(arm.matrixWorld);
        out.push({ z: jv.z / sc, y: jv.y / sc });
      }
      return out; };
    const tongZ = () => Math.max(...jaws().map(j => Math.abs(j.z - SV.slab.position.z / sc)));
    const open0 = tongZ();
    ok('送ったスラブの底面が受取テーブル面（パスライン）にある', Math.abs(bot0 - PL0) < 5 && Math.abs(z0 - S.SIDE_Z) < 5, `底面 ${mm(bot0)} / Z ${mm(z0)}`);
    ok('トングが最大巾まで開いて板を跨いでいる', Math.abs(open0 - zOpen) < 5 && open0 > w / 2, `爪内面 ${mm(open0)} / 全開 ${mm(zOpen)} / 板半幅 ${w / 2}`);
    // 掴んだあと: 爪が板の側面に当たり、板が吊り上がる
    window.__ff(Pp => Pp.supply.phase === 'TRANSFER' && Pp.supply.p.transfer > 0.3); W.render(P, 1 / 60);
    const closed = tongZ(), lift = SV.slab.position.y / sc - th / 2 - PL0;
    ok('トングが閉じて板の側面に当たる（全開 → 幅/2）', open0 > closed && Math.abs(closed - w / 2) < 5, `開 ${mm(open0)} → 閉 ${mm(closed)} mm（幅/2 = ${w / 2}）`);
    // 爪先はローラ上面より上（テーブルローラの胴に当てず、板の側面だけを掴む）
    const jawBot = Math.min(...jaws().map(j => j.y));
    ok('爪先が板の底面より上にある（ローラの胴に当たらない）', jawBot > SV.slab.position.y / sc - th / 2 - 1,
       `爪先 ${mm(jawBot)} / 板底面 ${mm(SV.slab.position.y / sc - th / 2)}`);
    ok('横移動中のスラブ底面が転倒機の受け面（リップ）より上', lift > S.LIP_H, `底面 パスライン上 ${mm(lift)} mm > リップ ${S.LIP_H} mm`);
    // 吊り具（ビーム・クランプ）が板の位置に追従している
    const bx = SV.beamT.position.x / sc, sx = SV.slab.position.x / sc, bz = SV.beamT.position.z / sc, sz = SV.slab.position.z / sc;
    ok('吊りビームがスラブの真上にある', Math.abs(bx - sx) < 5 && Math.abs(bz - sz) < 5, `ビーム (${mm(bx)}, ${mm(bz)}) / スラブ (${mm(sx)}, ${mm(sz)})`);
    // 降ろしたあと: スラブは A-9 テーブルの上、Z = 0、底面＝パスライン。クランプは開いて上昇
    window.__ff(Pp => !Pp.supply.active); W.render(P, 1 / 60);
    const xs = P.slab.xMin, xe = P.slab.xMax;
    const a9 = K.TABLE.SECTIONS.find(q => q.name === 'A-9'), lo = Math.min(a9.side * a9.x0, a9.side * a9.x1), hi = Math.max(a9.side * a9.x0, a9.side * a9.x1);
    ok('降ろしたスラブが A-9 テーブルの上に載る（ライン上に移った）', xs >= lo && xe <= hi && P.slab.onLine && W.slabView.mesh.visible,
       `スラブ ${mm(xs)}〜${mm(xe)} / A-9 ${lo}〜${hi}`);
    const tongBot = Math.min(...jaws().map(j => j.y));
    ok('降ろしたあとトングが板より上へ退避している', tongBot > PL0 + th + 100, `爪先 ${mm(tongBot)} / 板上面 ${mm(PL0 + th)}`);
    R.supply = { bot0: mm(bot0), open0: mm(open0), closed: mm(closed), lift: mm(lift), slab: [mm(xs), mm(xe)] };
  }

  /* ================= 5. テーブル配置 ================= */
  R.table = {};
  {
    const xs = W.tableView.zones.flatMap(z => z.xs).sort((a, b) => a - b);
    const pitches = []; for (let i = 1; i < xs.length; i++) pitches.push(xs[i] - xs[i - 1]);
    const sx = K.CROP_SHEAR.X;
    // 設備（ミル・トリマー・3ロール・シャー）をまたぐ欠けは除いて、ローラ同士のピッチだけを見る
    const equip = [0, K.TRIMMER.X, K.COILER.DEFLECTOR_X, sx];
    const straddles = (i) => equip.some(e => (xs[i - 1] - e) * (xs[i] - e) < 0);
    const plain = [], nearP = [];
    for (let i = 1; i < xs.length; i++) { if (straddles(i)) continue; plain.push(xs[i] - xs[i - 1]); if (Math.abs(xs[i] - sx) < 8000) nearP.push(xs[i] - xs[i - 1]); }
    R.table.count = xs.length; R.table.maxPitch = Math.max(...plain);
    R.table.shearZoneMaxPitch = Math.max(...nearP);
    R.table.shearGap = Math.min(...xs.filter(x => (x - sx) * K.FLIP > 0).map(x => Math.abs(x - sx))) + Math.min(...xs.filter(x => (x - sx) * K.FLIP < 0).map(x => Math.abs(x - sx)));
    ok('75 mm シャー周辺（±8 m）のローラピッチが 800 mm 以下（シャー区間の欠けを除く）', R.table.shearZoneMaxPitch <= 800,
       `最大ピッチ ${R.table.shearZoneMaxPitch.toFixed(0)} mm / シャー区間の欠け ${R.table.shearGap.toFixed(0)} mm（図面 1,600）`);
    ok('テーブル全域でローラピッチが 800 mm 以下（設備をまたぐ欠けを除く）', plain.every(p => p <= 800), `最大 ${R.table.maxPitch.toFixed(0)} mm`);
    const SEC = K.TABLE.SECTIONS;
    if (SEC) {
      const bad = [];
      for (const s of SEC) {
        const lo = Math.min(s.side * s.x0, s.side * s.x1), hi = Math.max(s.side * s.x0, s.side * s.x1);
        const inSec = xs.filter(x => x >= lo - 1 && x <= hi + 1);
        if (inSec.length !== s.n) bad.push(`${s.name}: ${inSec.length}/${s.n}`);
      }
      R.table.sections = SEC.map(s => s.name + ':' + s.n);
      ok('図面の区分ごとのローラ本数が一致', bad.length === 0, bad.join(' ') || `${SEC.length} 区分すべて一致`);
      const total = SEC.reduce((a, s) => a + s.n, 0);
      ok('図面のローラ総数と一致', xs.length === total, `${xs.length} / 図面 ${total} 本`);
    } else ok('図面のテーブル区分（CONFIG.TABLE.SECTIONS）が定義されている', false, '未定義');
    ok('テーブル全長が図面（121.8 + 80.1 = 201.9 m）', Math.abs(Math.abs(K.TABLE.X_MIN) + Math.abs(K.TABLE.X_MAX) - 201900) < 1,
       `${(Math.abs(K.TABLE.X_MIN) + Math.abs(K.TABLE.X_MAX)) / 1000} m`);
    ok('30 mm シャーとパイラーが J-3 の先にある', !!K.SHEAR30 && !!K.PILER && Math.abs(K.SHEAR30.X) > 80100 && Math.min(Math.abs(K.PILER.X0 ?? 0), Math.abs(K.PILER.X1 ?? 0)) > Math.abs(K.SHEAR30.X),
       K.SHEAR30 ? `30 mm シャー ${Math.abs(K.SHEAR30.X)} / パイラー ${Math.abs(K.PILER.X0 ?? 0)}〜${Math.abs(K.PILER.X1 ?? 0)}` : '30 mm シャー未定義');
  }

  /* ================= 2. 板面クーラント ================= */
  {
    const gv = W.guideView;
    const has = !!gv.headers;
    ok('サイドガイド上に板面クーラントヘッダがある', has, has ? `ヘッダ ${gv.headers.count ?? gv.headers.mesh?.count} 本` : '無し');
    ok('熱モデルに板面冷却域（ガイド上ヘッダ）がある', !!K.MATERIAL.GUIDE_COOL, K.MATERIAL.GUIDE_COOL ? JSON.stringify(K.MATERIAL.GUIDE_COOL) : '無し');
  }

  /* ================= 3. 断面表示（シャー） ================= */
  {
    A.ui.setCutaway('half'); W.render(P, 1 / 60);
    const FV = W.finishView, top = K.MILL.PASS_LINE + K.CROP_SHEAR.UPPER_CLR + K.CROP_SHEAR.BLADE_H;
    let opaqueTop = 0, opaqueNear = 0, ghostTop = 0, ghostNear = 0;
    FV.cropShear.traverse(o => {
      if (!o.isMesh) return;
      o.updateWorldMatrix(true, false);
      const b = new T.Box3().setFromObject(o);
      const ghost = !!(o.material && o.material.transparent);
      if (b.min.y / sc >= top - 1) { if (ghost) ghostTop++; else opaqueTop++; }                // 天面（上刃ホルダより上）
      if (b.min.z / sc > 600 && b.max.y / sc > K.MILL.PASS_LINE + 100) { if (ghost) ghostNear++; else opaqueNear++; }   // 手前側（OS）で板より上
    });
    R.cutaway = { opaqueTop, ghostTop, opaqueNear, ghostNear };
    ok('半断面で 75 mm シャーの天面（クロスヘッド・ホルダ）が透過する', opaqueTop === 0 && ghostTop > 0, `天面 実体 ${opaqueTop} / 透過 ${ghostTop}`);
    ok('半断面で 75 mm シャーの手前側（OS）が透過する', opaqueNear === 0 && ghostNear > 0, `手前 実体 ${opaqueNear} / 透過 ${ghostNear}`);
  }

  /* ================= 4. 端材の形状と行き先 ================= */
  {
    window.__startAuto(false);
    window.__ff(Pp => Pp.finish.cropStage === 'ALIGN');
    W.render(P, 1 / 60);
    // 切断前の板端: 描画メッシュから «先端の X の広がり»（舌・ワニ口の出っ張り）を読む
    const SVw = W.slabView, pos = SVw.geo.attributes.position;
    const headEnd = F > 0 ? 1 : -1;
    let xs = [];
    for (let i = 0; i < pos.count; i++) { const bx = SVw.base.getX(i) + 0.5; if ((headEnd > 0 && bx > 0.999) || (headEnd < 0 && bx < 0.001)) xs.push(pos.getX(i) / sc); }
    const spreadBefore = Math.max(...xs) - Math.min(...xs);
    window.__ff(Pp => Pp.finish.cropVisible || Pp.finish.cropStage === 'RETURN');
    W.render(P, 1 / 60);
    const FV = W.finishView;
    const piece = FV.scraps instanceof Map ? [...FV.scraps.values()][0] : FV.cropPiece;
    let spreadPiece = 0;
    if (piece) {
      piece.updateWorldMatrix(true, false);
      const g = piece.geometry, pp = g.attributes.position; const px = [];
      const bx = g.attributes.position; const base = piece.userData.base;
      // 端面（切断面の反対側＝元の先端）の頂点だけを集める。base が無ければ全頂点で判定する
      for (let i = 0; i < pp.count; i++) {
        const v = new T.Vector3().fromBufferAttribute(pp, i).applyMatrix4(piece.matrixWorld);
        if (base && Math.abs((base.getX(i) + 0.5) - (headEnd > 0 ? 1 : 0)) < 1e-3) px.push(v.x / sc);   // 板端側の端面
      }
      spreadPiece = px.length ? Math.max(...px) - Math.min(...px) : 0;
    }
    R.scrap = { spreadBefore: mm(spreadBefore), spreadPiece: mm(spreadPiece) };
    ok('端材が板端の変形（舌・ワニ口）を保っている', spreadPiece > 0.5 * spreadBefore && spreadBefore > 20, `切断前の先端の広がり ${mm(spreadBefore)} mm / 端材 ${mm(spreadPiece)} mm`);
    // 端材の行き先: すべてのカットが終わって静止したとき、パレット上に載っているか
    window.__ff(Pp => Pp.finish.cropDone);
    window.__ff((Pp, n) => n > 120 * 25);
    W.render(P, 1 / 60);
    const pieces = (FV.scraps instanceof Map ? [...FV.scraps.values()] : [FV.cropPiece]).filter(m => m && m.visible);
    const PAL = K.CROP_SHEAR.PALLET;
    const onPallet = pieces.filter(m => { const b = new T.Box3().setFromObject(m); return PAL && b.min.y / sc >= PAL.H - 5 && b.min.y / sc < PAL.H + 2000 && Math.abs(b.getCenter(new T.Vector3()).z / sc - PAL.Z) < PAL.L / 2; });
    R.scrap.pieces = pieces.length; R.scrap.onPallet = onPallet.length;
    R.scrap.rest = pieces.map(m => { const b = new T.Box3().setFromObject(m); return { y: mm(b.min.y / sc), z: mm(b.getCenter(new T.Vector3()).z / sc) }; });
    ok('端材はすべて可視のままパレットの上に載る', pieces.length > 0 && onPallet.length === pieces.length && onPallet.length === P.finish.cropCuts,
       `可視 ${pieces.length} / パレット上 ${onPallet.length} / カット数 ${P.finish.cropCuts}${PAL ? '' : '（パレット未定義）'}`);
  }

  R.failed = R.checks.filter(c => !c.pass).length;
  return R;
});
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log('\nsupply:', JSON.stringify(out.supply));
console.log('table :', JSON.stringify(out.table));
console.log('cut   :', JSON.stringify(out.cutaway));
console.log('scrap :', JSON.stringify(out.scrap));
console.log(`\nRESULT: ${out.failed === 0 ? 'PASS' : 'FAIL'} (${out.checks.length - out.failed}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
