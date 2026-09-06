// トング（可動部）が装入設備の各部と食い込まないかを全工程にわたって見る評価器。
//
// なぜ要るか: 既存の検査には «動く設備どうし／動く設備と固定設備» の当たりを見るものが無い。
//   - structure.mjs は可動部を除外した «静的部材どうし» だけ
//   - supplytrace.mjs / interfere.mjs は «スラブと設備» だけ
// トングは転倒機ベッド・受取テーブル・転倒アームの間へ爪を下ろすので、この穴を塞がないと
// «降ろした爪がローラや側枠を突き抜ける» 種類の誤りが検査を素通りしてしまう。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const EPS = +(process.argv[2] ?? 20);              // 食い込みと見なす最小重なり [mm]
const TARGET = process.argv[3] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate((EPS) => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, sc = K.SCALE, T = window.__T;
  const SV = W.supplyView;

  const v = new T.Vector3();
  // メッシュ群のワールド三角形 AABB を集める
  const tris = (root, list = []) => {
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh) || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : pos.count, inst = o.isInstancedMesh ? o.count : 1;
      const m4 = new T.Matrix4();
      for (let ii = 0; ii < inst; ii++) {
        if (o.isInstancedMesh) { o.getMatrixAt(ii, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
        for (let i = 0; i < n; i += 3) {
          let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
          for (let k = 0; k < 3; k++) {
            const j = idx ? idx.getX(i + k) : i + k;
            v.fromBufferAttribute(pos, j).applyMatrix4(m4);
            const x = v.x / sc, y = v.y / sc, z = v.z / sc;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
          }
          list.push([x0, y0, z0, x1, y1, z1, o.name || root.name]);
        }
      }
    });
    return list;
  };
  // 2 群の «食い込み量» の最大（各軸の重なりの最小値）。接触（0 近傍）は拾わない
  const dig = (L, R) => {
    let best = 0, at = null, who = null;
    for (const a of L) for (const b of R) {
      const ox = Math.min(a[3], b[3]) - Math.max(a[0], b[0]); if (ox <= best) continue;
      const oy = Math.min(a[4], b[4]) - Math.max(a[1], b[1]); if (oy <= best) continue;
      const oz = Math.min(a[5], b[5]) - Math.max(a[2], b[2]); if (oz <= best) continue;
      const d = Math.min(ox, oy, oz);
      if (d > best) { best = d; who = [a[6], b[6]];
        at = [(Math.max(a[0], b[0]) + Math.min(a[3], b[3])) / 2, (Math.max(a[1], b[1]) + Math.min(a[4], b[4])) / 2,
              (Math.max(a[2], b[2]) + Math.min(a[5], b[5])) / 2].map(Math.round); }
    }
    return { best, at, who };
  };

  // 相手側: 転倒アーム（ベッドローラ込み）／受取テーブル（架構＋ローラ）／転倒装置基部。
  // スラブは «掴む» ので当然当たる。ロープ・吊りビームはトングを吊る相手なので除く。
  const others = () => [
    ['転倒アーム', tris(SV.tilterArm)],
    ['受取テーブル', tris(SV.runoutRolls.inst.mesh, tris(SV.tilterPivot.children.find(o => o.name === '受取テーブル架構')))],
  ];

  window.__startAuto(true);
  const worst = {};
  let n = 0;
  while (n++ < 120 * 90 && P.supply.active) {
    P.step(1 / 120);
    if (n % 6) continue;                                  // 0.05 s ごと（姿勢の更新は render で起きる）
    W.render(P, 0.05);
    const tg = SV.tongs.map((t) => tris(t.g));
    for (const [name, o] of others()) for (const g of tg) {
      const d = dig(g, o);
      if (d.best > (worst[name]?.pen ?? 0))
        worst[name] = { pen: +d.best.toFixed(0), at: d.at, who: d.who, phase: P.supply.phase };
    }
  }
  // 検査が «空振り» でないことを示すため、突き合わせた三角形数も返す
  const dbg = { tong: SV.tongs.map(t => tris(t.g).length), others: others().map(([k, o]) => [k, o.length]) };
  return { dbg, hits: Object.entries(worst).filter(([, w]) => w.pen > EPS).map(([k, w]) => ({ 相手: k, ...w })),
           worst, finished: !P.supply.active };
}, EPS);

console.log('対象三角形数:', JSON.stringify(out.dbg));
console.log(`\nトングと装入設備の食い込み（> ${EPS} mm）: ${out.hits.length} 件`);
for (const h of out.hits) console.log(' ', JSON.stringify(h));
console.log('\n最大値:', JSON.stringify(out.worst));
console.log('\nRESULT:', out.hits.length === 0 && out.finished ? 'PASS' : 'FAIL');
await browser.close();
process.exit(out.hits.length === 0 && out.finished ? 0 : 1);
