// 装入工程（炉 → 吊上げ → 横行 → 立てかけ → 転倒 → 縦送り → 横送り）で
// スラブが装入設備に食い込んでいないかを、スラブの «実描画メッシュ» の姿勢で検査する。
// スラブは回転するので、装入設備の三角形をスラブのローカル座標（単位立方体）へ変換して
// 重なりを見る。可動の転倒アームも含めて毎サンプル作り直す。
import { openApp, installHelpers } from './harness.mjs';

const EPS = +(process.argv[2] ?? 3);
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate((EPS) => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, sc = K.SCALE, T = window.__T;
  const SV = W.supplyView;
  window.__startAuto(true);

  // 検査対象: 装入設備の全メッシュ（スラブ自身と搬送ローラは «当たってよい» ので除外）
  const allow = new Set();
  const add = (o) => { if (!o) return; if (Array.isArray(o)) return o.forEach(add);
                       if (o.mesh) return add(o.mesh); o.traverse ? o.traverse(x => allow.add(x)) : allow.add(o); };
  // 吊具のクランプは «板厚面を掴む» のが役目なので、当たってよい側に置く
  add(SV.slab); add(SV.ropes); add(SV.hookBeam); add(SV.clampArms); add(SV.ropesT); add(SV.beamT);
  for (const t of SV.tongs) add(t.g);
  add(SV.bedRolls.inst.mesh); add(SV.runoutRolls.inst.mesh);   // 板が載る側なので当たってよい
  const meshes = [];
  SV.group.traverse(o => { if ((o.isMesh || o.isInstancedMesh) && !allow.has(o)) meshes.push(o); });
  for (const z of W.tableView.zones) { meshes.push(z.peds.mesh); }
  W.scene.traverse(o => { if (o.name === '床' || o.name === 'floor') meshes.push(o); });
  const name = (o) => { let s = o.name || '', q = o; while (!s && q.parent) { q = q.parent; s = q.name || ''; } return s || 'mesh'; };

  // スラブは回転するので、装入設備の三角形をスラブのローカル系（回転・平行移動のみ、
  // スケール無し＝mm のまま）へ写し、AABB 対 三角形の分離軸判定（Akenine-Möller）で
  // 重なりを見る。三角形の AABB で判定すると回転した大きな三角形（床など）が
  // 誤検出になるため、分離軸で厳密に判定する。返す値は最小分離量（食い込みの上限）。
  const inv = new T.Matrix4(), m4 = new T.Matrix4(), v = new T.Vector3();
  const pp = new T.Vector3(), qq = new T.Quaternion(), ss = new T.Vector3();
  const tri = [new T.Vector3(), new T.Vector3(), new T.Vector3()];
  const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const triBox = (h, a, b, c) => {
    const e = [[b.x - a.x, b.y - a.y, b.z - a.z], [c.x - b.x, c.y - b.y, c.z - b.z], [a.x - c.x, a.y - c.y, a.z - c.z]];
    let minPen = Infinity;
    const test = (ax) => {
      const len = Math.hypot(ax[0], ax[1], ax[2]); if (len < 1e-9) return true;
      const x = ax[0] / len, y = ax[1] / len, z = ax[2] / len;
      const p0 = a.x * x + a.y * y + a.z * z, p1 = b.x * x + b.y * y + b.z * z, p2 = c.x * x + c.y * y + c.z * z;
      const r = h[0] * Math.abs(x) + h[1] * Math.abs(y) + h[2] * Math.abs(z);
      const pen = Math.min(Math.max(p0, p1, p2), r) - Math.max(Math.min(p0, p1, p2), -r);
      if (pen <= 0) return false;
      if (pen < minPen) minPen = pen; return true;
    };
    for (const ax of AX) if (!test(ax)) return 0;
    const n = [e[0][1] * e[1][2] - e[0][2] * e[1][1], e[0][2] * e[1][0] - e[0][0] * e[1][2], e[0][0] * e[1][1] - e[0][1] * e[1][0]];
    if (!test(n)) return 0;
    for (const ax of AX) for (const ed of e) {
      const cr = [ax[1] * ed[2] - ax[2] * ed[1], ax[2] * ed[0] - ax[0] * ed[2], ax[0] * ed[1] - ax[1] * ed[0]];
      if (!test(cr)) return 0;
    }
    return minPen;
  };
  const sample = (tag) => {
    SV.slab.updateWorldMatrix(true, false);
    SV.slab.matrixWorld.decompose(pp, qq, ss);
    inv.compose(pp, qq, new T.Vector3(1, 1, 1)).invert();
    const h = [ss.x / sc / 2 - EPS, ss.y / sc / 2 - EPS, ss.z / sc / 2 - EPS];   // 半寸法 [mm]
    const hits = [];
    for (const o of meshes) {
      o.updateWorldMatrix(true, false);
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : pos.count, inst = o.isInstancedMesh ? o.count : 1;
      let worst = 0;
      for (let ii = 0; ii < inst; ii++) {
        if (o.isInstancedMesh) { o.getMatrixAt(ii, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
        m4.premultiply(inv);                               // ワールド → スラブローカル（mm）
        for (let i = 0; i < n; i += 3) {
          for (let k = 0; k < 3; k++) tri[k].fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(m4).divideScalar(sc);
          const pen = triBox(h, tri[0], tri[1], tri[2]);
          if (pen > worst) worst = pen;
        }
      }
      if (worst > 0) hits.push({ mesh: name(o), pen: +worst.toFixed(0) });
    }
    return { tag, phase: P.supply.phase, p: +(P.supply.p[K.SEQUENCE[Math.max(P.supply.step, 0)][1]] ?? 0).toFixed(2), hits };
  };

  const log = [];
  let n = 0, last = '';
  while (n++ < 120 * 60 && P.supply.active) {
    P.step(1 / 120);
    if (n % 12 === 0) {                                     // 0.1 s ごと
      W.render(P, 0.1);
      const s = sample(n / 120);
      const key = s.phase + (s.hits.length ? JSON.stringify(s.hits) : '');
      if (s.hits.length || key !== last) log.push(s);
      last = key;
    }
  }
  return { log, done: !P.supply.active };
}, EPS);

const bad = out.log.filter(s => s.hits.length);
console.log(`supply sequence finished: ${out.done}`);
const worstByPhase = {};
for (const s of bad) for (const h of s.hits) {
  const k = s.phase + ' ' + h.mesh;
  worstByPhase[k] = Math.max(worstByPhase[k] ?? 0, h.pen);
}
console.log(`\n装入中のスラブ食い込み（> ${EPS} mm）: ${Object.keys(worstByPhase).length} 件`);
for (const [k, v] of Object.entries(worstByPhase).sort((a, b) => b[1] - a[1])) console.log('  ', String(v).padStart(5), 'mm', k);
console.log(`\nRESULT: ${Object.keys(worstByPhase).length === 0 ? 'PASS' : 'FAIL'}`);
await browser.close();
