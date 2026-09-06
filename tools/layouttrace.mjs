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
    // E-1 / E-2 は 1 段を OS/DS の 2 本で持つので «段» の X で数える（tableView.xs が段の一覧）
    const xs = W.tableView.xs.slice().sort((a, b) => a - b);
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
      // 区分への割り当ては «その区分が生成した X と一致するか» で見る。区間の境界に
      // ローラが載る区分（H-1 は区間長 = ピッチの合計なので端が境界に一致する）があるため、
      // 範囲で数えると隣の区分と二重に数えてしまう。
      const Lay0 = window.__LAYOUT, bad = [];
      for (const s of SEC) {
        const gen = Lay0.section(s).xs, want = Lay0.stages(s);       // split は 1 段 2 本
        const inSec = xs.filter(x => gen.some(g => Math.abs(g - x) < 1));
        if (inSec.length !== want) bad.push(`${s.name}: ${inSec.length}/${want}`);
      }
      R.table.sections = SEC.map(s => s.name + ':' + s.n);
      ok('図面の区分ごとのローラ本数が一致', bad.length === 0, bad.join(' ') || `${SEC.length} 区分すべて一致`);
      // 図面の «本数» は E-1 / E-2 が 1 段 2 本なので、段数の合計とは一致しない。
      // 段数（配置）と本数（実際に置かれたローラ）の両方を突き合わせる。
      const stages = SEC.reduce((a, s) => a + window.__LAYOUT.stages(s), 0);
      const total = SEC.reduce((a, s) => a + s.n, 0);
      const placed = xs.length + (W.tableView.eXs ? W.tableView.eXs.length : 0);
      ok('図面のローラ段数と一致', xs.length === stages, `${xs.length} 段 / 図面 ${stages} 段`);
      ok('図面のローラ総数と一致（E-1 / E-2 は 1 段 OS/DS の 2 本）', placed === total,
         `${placed} / 図面 ${total} 本`);
      const eN = W.tableView.eRolls ? W.tableView.eRolls.mesh.count : 0;
      ok('E-1 / E-2 のローラが OS/DS の 2 本ずつ置かれている',
         eN === (W.tableView.eXs || []).length * 2 && eN === 16,
         `${eN} 本（段 ${(W.tableView.eXs || []).length}）`);
      // 短胴（857）なので、胴の外端が最大板巾の半分に届いていること
      const EE = K.TABLE.EROLL;
      ok('E テーブルのローラが図面どおり（Φ380 × 857L、胴の外端が最大板巾の半分）',
         EE && EE.D_END === 380 && EE.BARREL === 857 && EE.Z_OUT >= K.SLAB.WID_MAX / 2 - 10,
         EE ? `Φ${EE.D_END} × ${EE.BARREL}L / 胴外端 ${EE.Z_OUT}（最大板巾の半分 ${K.SLAB.WID_MAX / 2}）` : '未定義');
      // 図面のピッチ（"460 370×5 460" など）どおりに並んでいるか。区間長がピッチの合計と
      // ほぼ同じ区分（D / F / G-1 / H-1）は «等配» へ落ちやすく、落ちても本数は合うので
      // 本数の検査だけでは通ってしまう。ピッチ列そのものを突き合わせる。
      const Lay = window.__LAYOUT, uni = SEC.filter(s => Lay.section(s).uniform).map(s => s.name);
      R.table.uniform = uni;
      ok('全区分が図面のピッチどおりに並ぶ（等配へ落ちていない）', uni.length === 0,
         uni.length ? `等配になった区分: ${uni.join(', ')}` : `${SEC.length} 区分すべて図面どおり`);
      // リールの手前（ロール側）は F テーブル。図面どおり 8 本・370×5 / 460×2 で、
      // リール・3ロールの手前で終わっているか
      const fs = SEC.find(s => s.name === 'F'), fr = fs ? Lay.section(fs) : null;
      if (fr) {
        const fx = fr.xs.map(x => Math.abs(x)).sort((a, b) => a - b);
        const fp = []; for (let i = 1; i < fx.length; i++) fp.push(Math.round(fx[i] - fx[i - 1]));
        R.table.F = { n: fs.n, pitches: fp, x: [Math.round(fx[0]), Math.round(fx[fx.length - 1])] };
        const want = [460, 370, 370, 370, 370, 370, 460];
        ok('F テーブルが図面どおり（8 本・460 / 370×5 / 460）',
           fs.n === 8 && fp.length === want.length && fp.every((v, i) => Math.abs(v - want[i]) < 1),
           `${fs.n} 本 / ピッチ ${fp.join(' ')}`);
        ok('F テーブルがリール・3ロールの手前で終わる',
           fx[fx.length - 1] < Math.abs(K.COILER.DEFLECTOR_X) - 200 && fx[fx.length - 1] < Math.abs(K.COILER.X) - 200,
           `F 末端 ${fx[fx.length - 1]} / 3ロール ${Math.abs(K.COILER.DEFLECTOR_X)} / リール ${Math.abs(K.COILER.X)}`);
      }
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
    ok('熱モデルに板面冷却域（ガイド上ヘッダ）がある', !!K.MATERIAL.COOLANT && K.MATERIAL.COOLANT.GUIDE_TOP > 0,
       K.MATERIAL.COOLANT ? `上面 ${K.MATERIAL.COOLANT.GUIDE_TOP} / 膜沸騰 ${K.MATERIAL.COOLANT.H_FILM} W/m²K` : '無し');
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
    // 屑の行き先: 先端・後端とも «ラインの下の受け → 傾斜コンベア → 操作側の屑箱» の
    // 1 系統。搬送距離が長い（コンベアだけで十数秒）ので、そのぶん時間を進めて確かめる。
    const minYs = new Map();                                      // 屑が «床下を通った» ことの証拠
    for (let k = 0; k < 200; k++) {
      window.__ff((Pp, n) => n > 60);                             // 0.5 s ずつ
      W.render(P, 1 / 60);
      for (const [id, m] of (FV.scraps instanceof Map ? FV.scraps : new Map())) {
        const b = new T.Box3().setFromObject(m);
        minYs.set(id, Math.min(minYs.get(id) ?? 1e9, b.min.y / sc));
      }
      if (P.finish.cropDone && P.finish.scrapRest >= P.finish.cropCutsAll) break;
    }
    W.render(P, 1 / 60);
    const pieces = (FV.scraps instanceof Map ? [...FV.scraps.values()] : [FV.cropPiece]).filter(m => m && m.visible);
    const SC = K.CROP_SHEAR.SCRAP, BOX = SC.BOX;
    const box3 = (m) => new T.Box3().setFromObject(m);
    R.scrap.pieces = pieces.length;
    R.scrap.rest = pieces.map(m => { const b = box3(m), c = b.getCenter(new T.Vector3());
      return { y: mm(b.min.y / sc), z: mm(c.z / sc), x: mm(c.x / sc) }; });
    ok('先端と後端の両方をクロップする（そのまま板を送って後端も切る）',
       P.finish.cropEndsDone[1] && P.finish.cropEndsDone[-1] && P.finish.cropCutsAll >= 2,
       `先端 ${P.finish.cropEndsDone[-K.FLIP > 0 ? 1 : -1] ? '済' : '未'} / 後端 ${P.finish.cropEndsDone[K.FLIP > 0 ? 1 : -1] ? '済' : '未'} / 総カット ${P.finish.cropCutsAll}`);
    // 先端・後端とも同じ屑箱に収まる（OS 側の 1 か所）
    const inBox = pieces.filter(m => { const b = box3(m), c = b.getCenter(new T.Vector3());
      return b.min.y / sc >= BOX.H - 5 && b.min.y / sc < BOX.H + 1200
          && Math.abs(c.z / sc - BOX.Z) < BOX.L / 2 + 50; });
    R.scrap.inBox = inBox.length;
    ok('先端・後端の屑がどちらも操作側の屑箱 1 か所に収まる',
       pieces.length > 0 && inBox.length === pieces.length && inBox.length === P.finish.cropCutsAll,
       `屑箱 ${inBox.length} 個 / 総カット ${P.finish.cropCutsAll}`);
    ok('屑箱が操作側（+Z）にある', BOX.Z > 0, `屑箱 Z ${BOX.Z}`);
    // «テーブルロールの下へ落とす» ことの確認: どの屑もどこかで床面より下を通る
    const belowFloor = [...minYs.values()].filter(y => y < -50);
    R.scrap.belowFloor = belowFloor.length;
    ok('屑が先端・後端とも床面より下（ラインの下の受け）を通ってから排出される',
       belowFloor.length === P.finish.cropCutsAll && P.finish.cropCutsAll > 0,
       `床下を通った屑 ${belowFloor.length} / ${P.finish.cropCutsAll} 個 ／ 最深 ${mm(Math.min(...[...minYs.values()], 0))} mm`);
    ok('屑はすべて可視のまま屑箱に納まる（装置の中に隠れない）',
       pieces.length === P.finish.cropCutsAll, `可視 ${pieces.length} / 総カット ${P.finish.cropCutsAll}`);
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
