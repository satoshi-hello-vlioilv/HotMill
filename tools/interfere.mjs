// スラブと設備の «意図しない接触» を検出する評価器。
//  1. 圧延サイクルを回しながら一定間隔でサンプリングする
//  2. その時刻のスラブ占有ボックス（板厚・板幅・先尾端）を作る
//  3. シーン中の全メッシュを三角形単位の AABB に落とし、スラブボックスと重なるものを拾う
//  4. «当たってよい部材»（圧延ロール・テーブルロール・サイドガイドローラ・刃物など）を
//     除外し、残ったものを干渉として報告する
import { openApp, installHelpers } from './harness.mjs';
const { browser: b, page: p } = await openApp({ viewport: { width: 900, height: 520 }, quiet: false });
await installHelpers(p);

const out = await p.evaluate(async () => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, sc = K.SCALE;
  
  window.__startAuto(false);

  // --- 当たってよい部材（参照で照合する） ---
  const allow = new Set();
  const add = (o) => { if (!o) return; if (Array.isArray(o)) return o.forEach(add);
                       if (o.mesh) return add(o.mesh); o.traverse ? o.traverse(x => allow.add(x)) : allow.add(o); };
  add(W.slabView.mesh);
  add(Object.values(W.millView.rolls));            // ワーク/バックアップロール
  add(W.tableView.zones ?? []);                    // テーブルローラ
  W.tableView && Object.values(W.tableView).forEach(v => { if (v && v.mesh && v.mesh.isInstancedMesh) add(v.mesh); });
  for (const st of W.guideView.stations) for (const g of st.sides)
    g.children.forEach(c => { if (c.isInstancedMesh) allow.add(c); });   // サイドガイドローラ
  const F = W.finishView;
  add([F.knives, F.lowerRolls, F.upperRoll, F.mandrel, F.coil, F.bridge, F.cropBed, F.cropPiece, F.cropKnife, F.cropUpperKnife,
       F.holdRoll, F.holdArm, F.holdCyl, F.knifeShafts, F.segments, F.pallet, F.pieceHost, F.s30Lower, F.s30Upper, F.s30Hold, F.pilerLift]);
  for (const side of (F.pilerSides ?? [])) add(side.rolls);
  W.guideView.headers && add(W.guideView.headers);
  const S = W.supplyView;
  add([S.runIn, S.cross, S.armRolls, S.tilterArm]);

  // --- 全メッシュを «三角形 AABB のリスト» にする（静止・可動を問わず毎回作り直せる形） ---
  const meshes = [];
  W.scene.traverse(o => {
    if (!(o.isMesh || o.isInstancedMesh) || allow.has(o)) return;
    if (o.isPoints) return;
    const g = o.geometry; if (!g || !g.attributes.position) return;
    meshes.push(o);
  });

  const triBoxesOf = (o) => {
    // ローカル三角形 AABB を一度だけ作る（形状は変わらないので使い回せる）
    if (o.userData.__tri) return o.userData.__tri;
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count, list = [];
    for (let i = 0; i < n; i += 3) {
      const a = idx ? idx.getX(i) : i, b2 = idx ? idx.getX(i+1) : i+1, c = idx ? idx.getX(i+2) : i+2;
      let x0=1e9,y0=1e9,z0=1e9,x1=-1e9,y1=-1e9,z1=-1e9;
      for (const k of [a,b2,c]) {
        const x=pos.getX(k), y=pos.getY(k), z=pos.getZ(k);
        if(x<x0)x0=x; if(y<y0)y0=y; if(z<z0)z0=z;
        if(x>x1)x1=x; if(y>y1)y1=y; if(z>z1)z1=z;
      }
      list.push([x0,y0,z0,x1,y1,z1]);
    }
    o.userData.__tri = list; return list;
  };

  const name = (o) => {
    let s = o.name || '', q = o;
    while (!s && q.parent) { q = q.parent; s = q.name || ''; }
    return s || (o.isInstancedMesh ? 'instanced' : 'mesh');
  };

  // --- サンプリング ---
  const hits = new Map();     // mesh -> {maxPen, count, sample}
  const eps = 3;              // 3 mm 未満のかすりは «接触なし» とみなす
  const sample = () => {
    const sl = P.slab, m = P.mill;
    if (!sl.onLine || sl.length < 1) return;
    // 板材の払い出し中は横移送・降下のオフセットを含める（描画と同じ量）
    const fz = P.finish.plateZ || 0, fy = P.finish.plateY || 0;
    const y0 = m.passLine + fy, y1 = m.passLine + sl.thickness + fy;
    const box = { x0: Math.min(sl.xMin, sl.xMax), x1: Math.max(sl.xMin, sl.xMax),
                  y0, y1, z0: -sl.width/2 + fz, z1: sl.width/2 + fz };
    // 端の «かすり» を無視するため各方向に eps だけ縮める
    const bx0=box.x0+eps, bx1=box.x1-eps, by0=box.y0+eps, by1=box.y1-eps, bz0=box.z0+eps, bz1=box.z1-eps;
    if (bx1<=bx0 || by1<=by0 || bz1<=bz0) return;
    for (const o of meshes) {
      if (!o.visible) continue;
      o.updateWorldMatrix(true, false);
      const M = o.matrixWorld.elements;
      const inst = o.isInstancedMesh ? o.count : 1;
      const tris = triBoxesOf(o);
      for (let ii = 0; ii < inst; ii++) {
        // インスタンス行列 × ワールド行列（平行移動と軸スケールのみ想定：AABB 判定なので十分）
        let ox=0, oy=0, oz=0;
        if (o.isInstancedMesh) { const a=o.instanceMatrix.array; ox=a[ii*16+12]; oy=a[ii*16+13]; oz=a[ii*16+14]; }
        for (const t of tris) {
          // ワールド変換（回転は AABB を膨らませる方向にしか効かないので、
          // ここでは平行移動＋スケールだけを見る保守的な判定にする）
          const sx=M[0], sy=M[5], sz=M[10];
          const wx0=(Math.min(t[0]*sx,t[3]*sx)+ox*sx+M[12])/sc, wx1=(Math.max(t[0]*sx,t[3]*sx)+ox*sx+M[12])/sc;
          if (wx1 < bx0 || wx0 > bx1) continue;
          const wy0=(Math.min(t[1]*sy,t[4]*sy)+oy*sy+M[13])/sc, wy1=(Math.max(t[1]*sy,t[4]*sy)+oy*sy+M[13])/sc;
          if (wy1 < by0 || wy0 > by1) continue;
          const wz0=(Math.min(t[2]*sz,t[5]*sz)+oz*sz+M[14])/sc, wz1=(Math.max(t[2]*sz,t[5]*sz)+oz*sz+M[14])/sc;
          if (wz1 < bz0 || wz0 > bz1) continue;
          const pen = Math.min(wx1-bx0, bx1-wx0, wy1-by0, by1-wy0, wz1-bz0, bz1-wz0);
          const key = name(o) + '#' + meshes.indexOf(o);
          const cur = hits.get(key);
          if (!cur || pen > cur.maxPen)
            hits.set(key, { maxPen: pen, count: (cur?.count ?? 0) + 1, pass: P.mill.passIndex,
                            th: +P.slab.thickness.toFixed(1),
                            at: [Math.round((wx0+wx1)/2), Math.round((wy0+wy1)/2), Math.round((wz0+wz1)/2)] });
          else cur.count++;
          break;                                     // 1メッシュ1件で十分
        }
      }
    }
  };

  let n = 0, next = 0;
  while (n++ < 120 * 1500) {
    P.step(1/120);
    if (n % 30 === 0) { W.render(P, 1/60); }        // 可動部の位置を更新（描画も伴う）
    if (n >= next) { sample(); next = n + 60; }     // 0.5 s ごと
    if (P.finish.done && P.mill.passIndex < 0) break;
  }
  return { steps: n, finished: P.finish.done,
           hits: [...hits.entries()].map(([k, v]) => ({ mesh: k, ...v, maxPen: +v.maxPen.toFixed(1) }))
                  .sort((a, b) => b.maxPen - a.maxPen) };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
