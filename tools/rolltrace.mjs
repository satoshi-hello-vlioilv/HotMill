// ロール（WR / BUR）とチョック、そしてスピンドル継手の «組み立てとして成立しているか» を
// ギャップ全域にわたって確かめる評価器。
//
// なぜ要るか: チョックは可動部なので structure.mjs の対象外で、interfere.mjs / supplytrace.mjs は
// «材料と設備» しか見ない。つまり «圧下でチョックどうしがぶつかる»「窓からはみ出す」
// 「圧下ロッドが宙に浮く」「スピンドルの平頭がロール軸端の二又を突き破る」といった、
// 図面どおりに組めているかを問う検査がどこにも無かった。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const EPS = +(process.argv[2] ?? 20);          // 食い込みと見なす最小重なり [mm]
const TARGET = process.argv[3] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate((EPS) => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, sc = K.SCALE, T = window.__T;
  const MV = W.millView, DV = W.driveView, M = K.MILL, H = M.HOUSING, CH = M.CHOCK, N = M.NECK;
  const R = { checks: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: d });
  const mm = (v) => +(+v).toFixed(0);

  const v = new T.Vector3(), m4 = new T.Matrix4();
  // メッシュ（またはインスタンス 1 個）のワールド三角形 AABB
  const tris = (o, inst = null) => {
    o.updateWorldMatrix(true, false);
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count, list = [];
    const range = inst === null ? (o.isInstancedMesh ? [...Array(o.count).keys()] : [0]) : [inst];
    for (const ii of range) {
      if (o.isInstancedMesh) { o.getMatrixAt(ii, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
      for (let i = 0; i < n; i += 3) {
        let b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k;
          v.fromBufferAttribute(pos, j).applyMatrix4(m4);
          const p = [v.x / sc, v.y / sc, v.z / sc];
          for (let a = 0; a < 3; a++) { if (p[a] < b[a]) b[a] = p[a]; if (p[a] > b[a + 3]) b[a + 3] = p[a]; }
        }
        list.push(b);
      }
    }
    return list;
  };
  const bboxOf = (list) => list.reduce((b, q) => [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.min(b[2], q[2]),
                                                  Math.max(b[3], q[3]), Math.max(b[4], q[4]), Math.max(b[5], q[5])],
                                       [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]);
  // 2 群の «食い込み量» の最大（各軸の重なりの最小値）。接触（0 近傍）は拾わない
  const dig = (L, Rr) => {
    let best = 0, at = null;
    for (const a of L) for (const b of Rr) {
      const ox = Math.min(a[3], b[3]) - Math.max(a[0], b[0]); if (ox <= best) continue;
      const oy = Math.min(a[4], b[4]) - Math.max(a[1], b[1]); if (oy <= best) continue;
      const oz = Math.min(a[5], b[5]) - Math.max(a[2], b[2]); if (oz <= best) continue;
      const d = Math.min(ox, oy, oz);
      if (d > best) { best = d; at = [(Math.max(a[0], b[0]) + Math.min(a[3], b[3])) / 2,
                                     (Math.max(a[1], b[1]) + Math.min(a[4], b[4])) / 2,
                                     (Math.max(a[2], b[2]) + Math.min(a[5], b[5])) / 2].map(Math.round); }
    }
    return { best, at };
  };
  const gapOf = (a, b, axis) => Math.max(a[axis] - b[axis + 3], b[axis] - a[axis + 3]);   // 分離距離（負なら重なり）

  const gaps = [M.GAP_MIN, 50, 200, M.GAP_DEFAULT ?? 382, M.GAP_MAX];
  const worst = { chock: { pen: 0 }, fork: { pen: 0 }, win: { over: -1e9 }, rod: { gap: -1e9 }, wedge: { gap: -1e9 },
                  blade: { h: 0, tip: -1e9 } };
  R.samples = [];
  for (const g of gaps) {
    P.mill.gap = P.mill.targetGap = g;
    W.render(P, 1 / 60);
    // チョック 8 個（WR/BR × 上下 × OS/DS）を個別に取る
    const chocks = [];
    for (const [kind, pair] of [['WR', MV.chockWR], ['BR', MV.chockBR]])
      for (const side of ['near', 'far'])
        for (let i = 0; i < pair[side].mesh.count; i++)
          chocks.push({ kind, side, i, t: tris(pair[side].mesh, i) });
    // 1) チョックどうしが食い込まない
    for (let a = 0; a < chocks.length; a++) for (let b = a + 1; b < chocks.length; b++) {
      if (chocks[a].side !== chocks[b].side) continue;                       // OS と DS は Z が離れている
      const d = dig(chocks[a].t, chocks[b].t);
      if (d.best > worst.chock.pen) worst.chock = { pen: mm(d.best), at: d.at, gap: g,
        who: `${chocks[a].kind}${chocks[a].i}-${chocks[b].kind}${chocks[b].i}` };
    }
    // 2) チョックがハウジングの窓（±WIN_X/2）に収まる
    for (const c of chocks) {
      const b = bboxOf(c.t), over = Math.max(b[3] - H.WIN_X / 2, -H.WIN_X / 2 - b[0]);
      if (over > worst.win.over) worst.win = { over: mm(over), gap: g, who: c.kind + c.i };
    }
    // 3) 圧下ロッドが上 BUR チョックの受けに接する／4) ウェッジが下 BUR チョックの受けに接する
    const brTop = chocks.find(c => c.kind === 'BR' && c.side === 'near' && c.i === 0);
    const brBot = chocks.find(c => c.kind === 'BR' && c.side === 'near' && c.i === 1);
    const rod = bboxOf(tris(MV.capRod.near.mesh)), wedge = bboxOf(tris(MV.wedge.mesh, 0));
    const rg = gapOf(rod, bboxOf(brTop.t), 1), wg = gapOf(bboxOf(brBot.t), wedge, 1);
    if (rg > worst.rod.gap) worst.rod = { gap: mm(rg), at: g };
    if (wg > worst.wedge.gap) worst.wedge = { gap: mm(wg), at: g };
    // 5) スピンドルの平頭がロール軸端の二又へ食い込まない
    for (let i = 0; i < DV.heads.length; i++) {
      const nk = i === 0 ? MV.rolls.workTop : MV.rolls.workBot;
      const neck = nk.children.find(o => o.isMesh && o.geometry.attributes.position.count > 100 && o !== nk.children[0]);
      const ht = tris(DV.heads[i]), nt = tris(neck ?? nk.children[1]);
      const d = dig(ht, nt);
      if (d.best > worst.fork.pen) worst.fork = { pen: mm(d.best), at: d.at, gap: g };
      // 自在継手の首振り角はギャップで変わる。平頭は首を振るぶんだけ «見かけの高さ» が
      // 増えるので、又のすき間に収まるかは全域で見る（面の三角形では «中に入った» 状態を
      // 捕まえられないため、形の式から直に測る）
      const bl = bboxOf(ht.filter(q => q[5] > K.DRIVE.COUPLING_Z + 50));
      if (bl[4] - bl[1] > worst.blade.h) worst.blade = { h: mm(bl[4] - bl[1]), gap: g, tip: mm(bl[5]) };
      if (bl[5] > worst.blade.tip) worst.blade.tip = mm(bl[5]);
    }
    R.samples.push({ gap: g, rod: mm(rg), wedge: mm(wg) });
  }
  P.mill.gap = P.mill.targetGap = M.GAP_MAX; W.render(P, 1 / 60);

  ok('圧下の全域でチョックどうしが食い込まない', worst.chock.pen <= EPS,
     `最大の食い込み ${worst.chock.pen} mm${worst.chock.who ? `（${worst.chock.who} / ギャップ ${worst.chock.gap}）` : ''}`);
  ok('チョックがハウジングの窓（±' + H.WIN_X / 2 + '）からはみ出さない', worst.win.over <= 0,
     `最大のはみ出し ${worst.win.over} mm（${worst.win.who}）`);
  ok('圧下ロッドが上 BUR チョックの受けに接する（浮かない・めり込まない）', Math.abs(worst.rod.gap) <= 5,
     `最大の隙間 ${worst.rod.gap} mm（ギャップ ${worst.rod.at}）`);
  ok('パスラインウェッジが下 BUR チョックの受けに接する', Math.abs(worst.wedge.gap) <= 5,
     `最大の隙間 ${worst.wedge.gap} mm`);
  ok('スピンドルの平頭がロール軸端の二又の爪へ食い込まない', worst.fork.pen <= EPS,
     `最大の食い込み ${worst.fork.pen} mm（ギャップ ${worst.fork.gap}）`);

  // --- 図面どおりの «段付きの首» と «二又» になっているか（形の検査）---
  {
    const zOut = H.INNER_Z + H.THICK_Z + CH.DETAIL.CAP_L;
    const wt = MV.rolls.workTop, neck = wt.children[1];
    const b = bboxOf(tris(neck));
    R.neck = { x: [mm(b[0]), mm(b[3])], y: [mm(b[1]), mm(b[4])], z: [mm(b[2]), mm(b[5])] };
    const forkEnd = -(zOut + N.END_L_DRIVE + N.FORK_BACK + N.FORK_PRONG);
    ok('駆動側の軸端が二又（フォーク）で終わる', Math.abs(b[2] - forkEnd) < 2,
       `駆動側の端 ${mm(b[2])} mm（図面どおりなら ${mm(forkEnd)}）`);
    ok('操作側の軸端は円筒（フォークは駆動側だけ）', Math.abs(b[5] - (zOut + N.END_L)) < 2,
       `操作側の端 ${mm(b[5])} mm`);
    // 二又の «すき間» にスピンドルの平頭が入っているか。
    // 面の三角形 AABB では «小さい箱が大きい箱の中へ入った» 状態を捕まえられないので、
    // ここは形の式から直に測る（板の先端が又の底を突いていないか、爪の間に届いているか）。
    const slot = M.WR_NECK_D * N.FORK_SLOT, t = M.WR_NECK_D * N.FORK_T;
    const z0 = -(zOut + N.END_L_DRIVE);                       // 又の根元
    const slotBack = z0 - N.FORK_BACK, forkTip = slotBack - N.FORK_PRONG;
    const blade = bboxOf(tris(DV.heads[0]).filter(q => q[5] > K.DRIVE.COUPLING_Z + 50));
    R.fork = { slot: mm(slot), thick: mm(t), slotBack: mm(slotBack), forkTip: mm(forkTip),
               tip: worst.blade.tip, maxH: worst.blade.h, bladeX: mm(blade[3] - blade[0]) };
    ok('スピンドルの平頭が又の底を突かない', worst.blade.tip < slotBack - 20,
       `板の先端 ${worst.blade.tip} mm / 又の底 ${mm(slotBack)} mm`);
    ok('スピンドルの平頭が爪の間へ十分入っている', worst.blade.tip > forkTip + N.FORK_PRONG * 0.5,
       `噛み合い ${worst.blade.tip - mm(forkTip)} mm / 爪の長さ ${N.FORK_PRONG} mm`);
    ok('圧下の全域で平頭が二又のすき間に収まる（首を振っても爪に当たらない）',
       worst.blade.h < slot && (blade[3] - blade[0]) < t,
       `すき間 ${mm(slot)} mm / 板の高さ 最大 ${worst.blade.h} mm（ギャップ ${worst.blade.gap}）・厚み ${mm(blade[3] - blade[0])} mm`);
    // 軸受カバーがハウジング外面より外に出ている（図面どおり外から見える）
    const cb = bboxOf(tris(MV.chockWR.near.mesh, 0));
    ok('軸受カバーがハウジング外面より外に出る', cb[5] > H.INNER_Z + H.THICK_Z + 10,
       `チョックの外端 ${mm(cb[5])} mm / ハウジング外面 ${H.INNER_Z + H.THICK_Z} mm`);
  }
  R.failed = R.checks.filter(c => !c.pass).length;
  return R;
}, EPS);

for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log('\nneck :', JSON.stringify(out.neck));
console.log('fork :', JSON.stringify(out.fork));
console.log('gaps :', JSON.stringify(out.samples));
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
