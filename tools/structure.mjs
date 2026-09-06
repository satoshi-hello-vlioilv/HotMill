// 静的構造物の «物理的成立» を判定する評価器。
//  A. 接地: 可動部以外のすべての部材について、最下面が床（y=0）か他の部材に載っているか
//  B. ピット上の浮き: 床面高さに接地している部材の底面が、ピット/炉の開口の真上に無いか
//  C. 静的部材どうしの食い込み: 別メッシュ間で三角形 AABB が eps を超えて重なっていないか
//     （同一メッシュ内の結合は設計上の一体なので対象外。伸縮する部材は userData.telescoping で除外）
// 目視では追いきれない «見えない支柱» や «床下に潜る基礎» を機械的に拾うのが目的。
import { openApp, installHelpers } from './harness.mjs';

const EPS = +(process.argv[2] ?? 20);        // 食い込みと見なす最小重なり [mm]
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate((EPS) => {
  const A = window.__app, W = A.world, K = window.__CFG, sc = K.SCALE, T = window.__T;
  W.render(A.physics, 1 / 60);

  // --- 可動部（姿勢が状態で変わる部材）を参照で集める。構造判定の対象から外す ---
  const moving = new Set();
  const add = (o) => { if (!o) return; if (Array.isArray(o)) return o.forEach(add);
                       if (o.mesh) return add(o.mesh); o.traverse ? o.traverse(x => moving.add(x)) : moving.add(o); };
  add(W.slabView.mesh); add(W.supplyView.slab);
  add(Object.values(W.millView.rolls));
  for (const k of ['chockWR', 'chockBR', 'capRod', 'capBody', 'wedge', 'bender', 'headers'])
    { const v = W.millView[k]; if (v) { add(v.near); add(v.far); add(v); } }
  add(W.driveView.spindles); add(W.driveView.pinions); add(W.driveView.heads);
  for (const z of W.tableView.zones) add(z.rolls);
  add(W.tableView.eRolls);                                 // E-1 / E-2 のローラ（回る）
  for (const st of W.guideView.stations) for (const g of st.sides) add(g);
  const F = W.finishView;
  for (const k of ['knives', 'lowerRolls', 'upperRoll', 'mandrel', 'coil', 'bridge', 'cropRam', 'cropBed', 'cropPiece', 'cropKnife',
                   'car', 'belt',
                   'holdRoll', 'holdArm', 'holdCyl', 'knifeShafts', 'cropHold', 'cropPusher', 'segments', 'strip', 'plate',
                   'convFlights', 'pieceHost', 's30Ram', 's30Hold', 'pilerLift', 'pilerCol'])
    add(F[k]);
  for (const side of (F.pilerSides ?? [])) add(side.grp);
  for (const w of (F.wrapRolls ?? [])) { add(w.roll); add(w.arms); }   // ベルトラッパー（揺動する）
  add(F.cradle);                                                       // ラッパーキャリッジ（振れる）
  const S = W.supplyView;
  for (const k of ['tilterArm', 'trolley', 'hookBeam', 'ropes', 'lid', 'girderT', 'trolleyT', 'beamT', 'ropesT'])
    add(S[k]);
  for (const t of S.tongs) add(t.g);                       // トングはマスト・アーム・ロッドの入れ子
  add(S.bedRolls.inst.mesh); add(S.runoutRolls.inst.mesh); // 転倒機ベッド／受取テーブルのローラ（回る）
  W.scene.traverse(o => { if (o.isPoints || o.userData.telescoping) moving.add(o); });

  const name = (o) => {
    let s = o.name || '', q = o;
    while (!s && q.parent) { q = q.parent; s = q.name || ''; }
    return s || (o.isInstancedMesh ? 'instanced' : 'mesh');
  };
  const statics = [];
  W.scene.traverse(o => {
    if (!(o.isMesh || o.isInstancedMesh) || moving.has(o) || !o.visible) return;
    const g = o.geometry; if (!g || !g.attributes.position) return;
    statics.push(o);
  });

  // --- ワールド座標の三角形 AABB（インスタンスごと）---
  const v = new T.Vector3(), m4 = new T.Matrix4();
  const tris = (o) => {
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count, list = [];
    const inst = o.isInstancedMesh ? o.count : 1;
    for (let ii = 0; ii < inst; ii++) {
      if (o.isInstancedMesh) { o.getMatrixAt(ii, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
      for (let i = 0; i < n; i += 3) {
        let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k;
          v.fromBufferAttribute(pos, j).applyMatrix4(m4);
          const x = v.x / sc, y = v.y / sc, z = v.z / sc;
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
          if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
        }
        list.push([x0, y0, z0, x1, y1, z1]);
      }
    }
    return list;
  };
  const items = statics.map((o, i) => {
    const t = tris(o);
    let b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (const q of t) { for (let k = 0; k < 3; k++) { if (q[k] < b[k]) b[k] = q[k]; if (q[k + 3] > b[k + 3]) b[k + 3] = q[k + 3]; } }
    return { o, i, id: name(o) + '#' + i, t, b, floor: /床|floor/.test(o.name), pit: /ピット|pit/.test(o.name) };
  });
  const ground = items.filter(x => x.floor);

  // --- A. 接地判定 ---
  // 床（y=0）かピット床（y=−DEPTH、ピット内）に底面が着いている部材を «接地» とし、
  // 接地している部材に触れている（10 mm 以内で接する）部材を順に «支持されている» とする。
  // 梁の上のブラケットのように最下点が宙にあっても、どこかで支持部材に結ばれていれば成立。
  const PITD = K.BUILDING.PIT.DEPTH, PITX = K.BUILDING.PIT.X, PITZ = K.BUILDING.PIT.Z;
  // パイラーのピット（リフトテーブルが下がる）。この中では −DEPTH が床
  const PP = K.PILER, PPX0 = Math.min(PP.X0, PP.X1) + PP.PIT.MARGIN, PPX1 = Math.max(PP.X0, PP.X1) - PP.PIT.MARGIN, PPZ = PP.PIT.DZ, PPD = PP.PIT.DEPTH;
  const inPilerPit = (b) => b[0] > PPX0 - 1 && b[3] < PPX1 + 1 && b[2] > -PPZ - 1 && b[5] < PPZ + 1;
  // クロップ屑の受け（ピット兼トレンチ、傾斜コンベアが入る）。中の部材は壁・底との連鎖で判定する
  const TP = K.CROP_SHEAR.SCRAP.PIT, TF = K.FLIP, TCS = K.CROP_SHEAR.X;
  const twx = (cx) => TCS + TF * cx;
  const TPX0 = Math.min(twx(TP.X0), twx(TP.X1)), TPX1 = Math.max(twx(TP.X0), twx(TP.X1));
  const TPZ0 = Math.min(TP.Z0, TP.Z_OUT), TPZ1 = Math.max(TP.Z0, TP.Z_OUT);
  const inTailPit = (b) => b[3] > TPX0 && b[0] < TPX1 && b[5] > TPZ0 && b[2] < TPZ1;
  const touch = (a, b, tol) => {
    if (a.b[3] < b.b[0] - tol || b.b[3] < a.b[0] - tol || a.b[4] < b.b[1] - tol || b.b[4] < a.b[1] - tol ||
        a.b[5] < b.b[2] - tol || b.b[5] < a.b[2] - tol) return false;
    for (const q of a.t) {
      if (q[3] < b.b[0] - tol || q[0] > b.b[3] + tol || q[4] < b.b[1] - tol || q[1] > b.b[4] + tol || q[5] < b.b[2] - tol || q[2] > b.b[5] + tol) continue;
      for (const p of b.t)
        if (q[3] >= p[0] - tol && p[3] >= q[0] - tol && q[4] >= p[1] - tol && p[4] >= q[1] - tol && q[5] >= p[2] - tol && p[5] >= q[2] - tol) return true;
    }
    return false;
  };
  const grounded = new Map();
  for (const it of items) {
    if (it.floor || it.pit) { grounded.set(it.id, 'ground'); continue; }
    const y0 = it.b[1];
    const inPit = Math.abs(it.b[0]) < PITX && Math.abs(it.b[3]) < PITX && Math.abs(it.b[2]) < PITZ && Math.abs(it.b[5]) < PITZ;
    if (Math.abs(y0) <= 30) grounded.set(it.id, 'floor');
    else if (Math.abs(y0 + PITD) <= 30 && inPit) grounded.set(it.id, 'pit-floor');
    else if (Math.abs(y0 + PPD) <= 30 && inPilerPit(it.b)) grounded.set(it.id, 'piler-pit-floor');
    else if (y0 < -30 && (inPilerPit(it.b) || inTailPit(it.b))) { /* ピット内の部材は連鎖で判定 */ }
    else if (y0 < -30 && !inPit) grounded.set(it.id, 'BELOW-FLOOR');   // 床版を貫いている（ピット外）
  }
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const it of items) {
      if (grounded.has(it.id)) continue;
      for (const other of items) {
        if (other === it) continue;
        const g = grounded.get(other.id);
        if (!g || g === 'BELOW-FLOOR') continue;
        if (touch(it, other, 10)) { grounded.set(it.id, other.id); changed = true; break; }
      }
    }
    if (!changed) break;
  }
  // 床下に潜っていて、かつ何にも支持されていない部材は «床下» として別に報告する
  const support = items.filter(it => !it.floor && !it.pit)
    .map(it => ({ id: it.id, minY: +it.b[1].toFixed(0), on: grounded.get(it.id) ?? (it.b[1] < -30 ? 'BELOW-FLOOR' : 'FLOATING') }));

  // --- B. ピット/炉の開口の真上に接地面が来ていないか ---
  const PIT = K.BUILDING.PIT, FU = K.FURNACE, SU = K.SUPPLY;
  const inTailHole = (x, z) => x > TPX0 && x < TPX1 &&
    ((z > TPZ0 && z < TP.BRIDGE[0]) || (z > TP.BRIDGE[1] && z < TPZ1));
  const inPit = (x, z) => (Math.abs(x) < PIT.X && Math.abs(z) < PIT.Z) ||
                          (x > PPX0 && x < PPX1 && Math.abs(z) < PPZ) || inTailHole(x, z);
  const inFurnace = (x, z) => Math.abs(x - SU.TILTER_X) < FU.L / 2 + FU.WALL && Math.abs(z - FU.Z) < FU.W / 2 + FU.WALL;
  const hover = [];
  for (const it of items) {
    if (it.floor || it.pit) continue;
    if (it.b[1] > 30 || it.b[1] < -30) continue;
    const band = it.t.filter(q => q[1] < it.b[1] + 40);
    let over = 0;
    for (const q of band) { const cx = (q[0] + q[3]) / 2, cz = (q[2] + q[5]) / 2; if (inPit(cx, cz) || inFurnace(cx, cz)) over++; }
    if (over) hover.push({ id: it.id, overHole: over, of: band.length, ok: false });
  }

  // --- C. 静的部材どうしの食い込み ---
  const pen = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.b[3] < b.b[0] + EPS || b.b[3] < a.b[0] + EPS || a.b[4] < b.b[1] + EPS || b.b[4] < a.b[1] + EPS ||
        a.b[5] < b.b[2] + EPS || b.b[5] < a.b[2] + EPS) continue;
    let worst = 0, at = null;
    for (const q of a.t) {
      if (q[3] < b.b[0] + EPS || q[0] > b.b[3] - EPS || q[4] < b.b[1] + EPS || q[1] > b.b[4] - EPS || q[5] < b.b[2] + EPS || q[2] > b.b[5] - EPS) continue;
      for (const p of b.t) {
        const dx = Math.min(q[3], p[3]) - Math.max(q[0], p[0]); if (dx < EPS) continue;
        const dy = Math.min(q[4], p[4]) - Math.max(q[1], p[1]); if (dy < EPS) continue;
        const dz = Math.min(q[5], p[5]) - Math.max(q[2], p[2]); if (dz < EPS) continue;
        const d = Math.min(dx, dy, dz);
        if (d > worst) { worst = d; at = [Math.round((Math.max(q[0], p[0]) + Math.min(q[3], p[3])) / 2), Math.round((Math.max(q[1], p[1]) + Math.min(q[4], p[4])) / 2), Math.round((Math.max(q[2], p[2]) + Math.min(q[5], p[5])) / 2)]; }
      }
    }
    if (worst > 0) pen.push({ a: a.id, b: b.id, pen: +worst.toFixed(0), at });
  }
  pen.sort((x, y) => y.pen - x.pen);

  // --- D. 体積の食い込み（レイキャスト）---
  // C の三角形 AABB 判定は、軸に平行な面どうし（箱と箱）の重なりを拾えない（平らな三角形は
  // その軸方向の厚みが 0 なので重なり量が 0 になる）。そこで部材 A の頂点・三角形重心が
  // 部材 B の «中» にあるかを +X 方向のレイの交差回数（偶奇）で判定し、中にある点から 6 軸方向に
  // レイを飛ばして最も近い面までの距離を食い込み深さとする（面の上に載っている点は深さ 0）。
  const ray = new T.Raycaster(), dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(d => new T.Vector3(...d));
  const px = new T.Vector3(1, 0, 0);
  const samplePoints = (o, limit) => {
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
    const inst = o.isInstancedMesh ? o.count : 1, pts = [], a = new T.Vector3(), b = new T.Vector3(), c = new T.Vector3();
    const step = Math.max(1, Math.floor((n / 3) * inst / limit));
    let k = 0;
    for (let ii = 0; ii < inst; ii++) {
      if (o.isInstancedMesh) { o.getMatrixAt(ii, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
      for (let i = 0; i < n; i += 3) {
        if (k++ % step) continue;
        a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m4);
        b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(m4);
        c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(m4);
        pts.push(a.clone(), new T.Vector3().addVectors(a, b).add(c).multiplyScalar(1 / 3));
      }
    }
    return pts;
  };
  const depthInside = (pt, B) => {
    ray.set(pt, px); ray.far = Infinity;
    const hits = ray.intersectObject(B, false);
    if (hits.length % 2 === 0) return 0;                       // 外
    let d = Infinity;
    for (const dir of dirs) { ray.set(pt, dir); const h = ray.intersectObject(B, false); if (h.length) d = Math.min(d, h[0].distance); }
    return d === Infinity ? 0 : d / sc;
  };
  const vol = [];
  const sides = new Map();
  for (const it of items) { const m = it.o.material; if (m && !Array.isArray(m)) { sides.set(it.o, m.side); m.side = T.DoubleSide; } }
  for (let i = 0; i < items.length; i++) for (let j = 0; j < items.length; j++) {
    if (i === j) continue;
    const a = items[i], b = items[j];
    if (a.floor || b.floor) continue;                          // 床版は他の部材が載る前提
    if (a.b[3] < b.b[0] + EPS || b.b[3] < a.b[0] + EPS || a.b[4] < b.b[1] + EPS || b.b[4] < a.b[1] + EPS ||
        a.b[5] < b.b[2] + EPS || b.b[5] < a.b[2] + EPS) continue;
    const pts = samplePoints(a.o, 600).filter(q => q.x / sc > b.b[0] + EPS && q.x / sc < b.b[3] - EPS && q.y / sc > b.b[1] + EPS &&
                                                  q.y / sc < b.b[4] - EPS && q.z / sc > b.b[2] + EPS && q.z / sc < b.b[5] - EPS);
    let worst = 0, at = null;
    for (const q of pts) { const d = depthInside(q, b.o); if (d > worst) { worst = d; at = [Math.round(q.x / sc), Math.round(q.y / sc), Math.round(q.z / sc)]; } }
    if (worst > EPS) vol.push({ a: a.id, b: b.id, pen: +worst.toFixed(0), at });
  }
  for (const [o, side] of sides) o.material.side = side;
  vol.sort((x, y) => y.pen - x.pen);
  return { statics: items.length, support, hover, pen, vol };
}, EPS);

const bad = { floating: out.support.filter(s => s.on === 'FLOATING' || s.on === 'BELOW-FLOOR'), hover: out.hover, pen: out.pen, vol: out.vol };
if (process.argv.includes('-v')) for (const s of out.support) console.log('  ', s.on.padEnd(22), s.id, 'minY=' + s.minY);
console.log(`static meshes: ${out.statics}`);
console.log(`\n[A] 接地: 不成立 ${bad.floating.length} 件`);
for (const s of bad.floating) console.log('  ', s.on.padEnd(12), s.id, 'minY=' + s.minY);
console.log(`\n[B] ピット/炉の開口上に接地面: ${bad.hover.length} 件`);
for (const h of bad.hover) console.log('  ', h.id, `${h.overHole}/${h.of} faces over hole`);
console.log(`\n[C] 静的部材の食い込み (> ${EPS} mm): ${bad.pen.length} 件`);
for (const p of bad.pen) console.log('  ', String(p.pen).padStart(5), 'mm', p.a, '×', p.b, '@', p.at.join(','));
console.log(`\n[D] 静的部材の体積の食い込み（レイキャスト、> ${EPS} mm）: ${bad.vol.length} 件`);
for (const p of bad.vol) console.log('  ', String(p.pen).padStart(5), 'mm', p.a, 'が', p.b, 'の中 @', p.at.join(','));
console.log(`\nRESULT: ${bad.floating.length + bad.hover.length + bad.pen.length + bad.vol.length === 0 ? 'PASS' : 'FAIL'}`);
await browser.close();
