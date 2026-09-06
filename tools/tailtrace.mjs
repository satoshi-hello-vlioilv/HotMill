// 後端の端材の払い出し（固定ストリッパシュート → ライン下の端材ピット → 傾斜コンベア →
// 駆動側の端材箱）を、幾何と運動の両面から確かめる評価器。
//
// なぜ要るか: この払い出しは «固定部材が可動部材（下台）を貫いている» という、他のどの検査も
// 見ていない構成を持つ。溝の位置が 1 つずれるだけでシュートが下台を切り裂くが、
//   - structure.mjs は可動部を外すので下台とシュートの関係を見ない
//   - interfere.mjs / layouttrace.mjs は «結果として端材がどこへ行ったか» しか見ない
// ため、この穴を塞がないと «見た目は動くが機械としては成立しない» 構成が素通りする。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const EPS = +(process.argv[2] ?? 20);          // 食い込みと見なす最小重なり [mm]
const TARGET = process.argv[3] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate((EPS) => {
  const A = window.__app, P = A.physics, W = A.world, K = window.__CFG, sc = K.SCALE, T = window.__T, TL = window.__TAIL;
  const FV = W.finishView, CS = K.CROP_SHEAR, TC = CS.TAIL;
  const R = { checks: [] };
  const ok = (name, pass, detail = '') => R.checks.push({ name, pass: !!pass, detail });
  const mm = (v) => +(+v).toFixed(0);

  const v = new T.Vector3(), m4 = new T.Matrix4();
  // 三角形の AABB（mm）。ang を与えると «その角度だけ Y–Z 面を回した座標系» で取る。
  // 傾いた薄板どうしはワールド軸の AABB が太って偽陽性を出すので、コンベアの傾きに
  // 合わせた座標系でも見て、«どちらかの系で分離していれば当たっていない» と判定する。
  const tris = (root, ang = 0, axis = 'x') => {
    const ca = Math.cos(ang), sa = Math.sin(ang), list = [];
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh) || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position, idx = o.geometry.index;
      const n = idx ? idx.count : pos.count, inst = o.isInstancedMesh ? o.count : 1;
      for (let ii = 0; ii < inst; ii++) {
        if (o.isInstancedMesh) { o.getMatrixAt(ii, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
        for (let i = 0; i < n; i += 3) {
          let b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
          for (let k = 0; k < 3; k++) {
            const j = idx ? idx.getX(i + k) : i + k;
            v.fromBufferAttribute(pos, j).applyMatrix4(m4);
            const x = v.x / sc, y = v.y / sc, z = v.z / sc;
            const p = axis === 'z' ? [x * ca - y * sa, x * sa + y * ca, z]
                                   : [x, y * ca - z * sa, y * sa + z * ca];
            for (let a = 0; a < 3; a++) { if (p[a] < b[a]) b[a] = p[a]; if (p[a] > b[a + 3]) b[a + 3] = p[a]; }
          }
          list.push(b);
        }
      }
    });
    return list;
  };
  const dig = (L, Rr) => {                       // 2 群の «食い込み量» の最大（各軸の重なりの最小値）
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
  // 傾いた薄板どうしはワールド軸の AABB が太る。«どれか 1 つの系で分離していれば当たって
  // いない» という分離軸の考え方で、複数の系の最小値を食い込み量とする。
  const digN = (pairs) => pairs.map(([a, b]) => dig(a, b)).reduce((m, r) => r.best < m.best ? r : m);
  const chute = FV.cropShear.children.find(o => o.name === '端材ストリッパシュート');
  const pit   = FV.cropShear.children.find(o => o.name === '端材ピット');
  const conv  = FV.cropShear.children.find(o => o.name === '端材傾斜コンベア架構');
  const box   = FV.cropShear.children.find(o => o.name === '端材箱');
  ok('固定シュート・端材ピット・傾斜コンベア・端材箱がある', !!(chute && pit && conv && box),
     [chute, pit, conv, box].map(o => o ? o.name : '無し').join(' / '));

  /* --- 1. 下台の全ストロークでシュートが下台を貫かない（溝を通っている）--- */
  {
    const f = P.finish, blade0 = f.cropBlade, drop0 = f.bedDrop;
    let worst = { pen: 0, at: null, b: 0, d: 0 };
    const cg = tris(chute);
    for (let i = 0; i <= 20; i++) {
      const b = i / 20, d = 0;
      f.cropBlade = b; f.bedDrop = d; W.render(P, 1 / 60);
      const p = dig(cg, tris(FV.cropBed));
      if (p.best > worst.pen) worst = { pen: mm(p.best), at: p.at, b, d };
    }
    for (let i = 0; i <= 20; i++) {
      const b = 0, d = i / 20;
      f.cropBlade = b; f.bedDrop = d; W.render(P, 1 / 60);
      const p = dig(cg, tris(FV.cropBed));
      if (p.best > worst.pen) worst = { pen: mm(p.best), at: p.at, b, d };
    }
    f.cropBlade = blade0; f.bedDrop = drop0; W.render(P, 1 / 60);
    R.bed = worst;
    ok('下台の全ストロークで固定シュートが下台を貫かない（溝を通る）', worst.pen <= EPS,
       `最大の食い込み ${worst.pen} mm（上昇 ${worst.b}, 下降 ${worst.d}）`);
  }

  /* --- 2. 端材ピットの開口がテーブル架台の足元を掘っていない --- */
  {
    const wx = (cx) => K.CROP_SHEAR.X + K.FLIP * cx;
    const x0 = Math.min(wx(TC.PIT.X0), wx(TC.PIT.X1)), x1 = Math.max(wx(TC.PIT.X0), wx(TC.PIT.X1));
    const holes = [[TC.PIT.BRIDGE[1], TC.PIT.Z_IN], [TC.PIT.Z_OUT, TC.PIT.BRIDGE[0]]];
    let hit = [], feet = 0;
    W.scene.traverse(o => {
      if (!(o.isMesh || o.isInstancedMesh) || !/架台|脚|ベース|柱|据付/.test(o.name || '')) return;
      for (const b of tris(o)) {
        if (b[1] > 30) continue;                                  // 床に接している三角形だけ見る
        feet++;
        const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
        if (cx > x0 && cx < x1 && holes.some(h => cz > h[0] && cz < h[1])) hit.push([o.name, mm(cx), mm(cz)]);
      }
    });
    R.feet = { checked: feet, hit: hit.length, sample: hit.slice(0, 3) };
    ok('端材ピットの開口の真上に床置きの足が無い（架台の足元を掘っていない）', hit.length === 0,
       `床に接する三角形 ${feet} 個中 ${hit.length} 個が開口の上`);
  }

  /* --- 3. 運転: 後端の端材が シュート → ピット → 傾斜コンベア → 端材箱 と進む --- */
  {
    window.__startAuto(false);
    const seqs = new Map();                       // ピースごとの経過（混ぜると順序が読めない）
    let n = 0, minY = 1e9, maxCx = -1e9, minCx = 1e9, bedBack = false, sawDown = false;
    const cx = (x) => K.FLIP * (x - K.CROP_SHEAR.X);
    while (n++ < 120 * 420) {
      P.step(1 / 120);
      const f = P.finish;
      for (const s of f.scraps) {
        if (!/ONBED|CHUTE|PITFALL|TAILCONV|TAILDROP/.test(s.stage) && !(seqs.has(s.id) && s.stage === 'REST')) continue;
        const q = seqs.get(s.id) ?? (seqs.set(s.id, []), seqs.get(s.id));
        if (q[q.length - 1] !== s.stage) q.push(s.stage);
        if (s.stage !== 'REST') { minY = Math.min(minY, s.y); minCx = Math.min(minCx, cx(s.x)); maxCx = Math.max(maxCx, cx(s.x)); }
      }
      if (f.bedDrop >= 0.999) sawDown = true;                 // 下がり切ってから戻ることを見る
      if (sawDown && f.bedDrop <= 0.001) bedBack = true;
      if (f.cropDone && f.scrapRest >= f.cropCutsAll) break;
    }
    const f = P.finish, order = ['ONBED', 'CHUTE', 'PITFALL', 'TAILCONV', 'TAILDROP', 'REST'];
    const seq = [...seqs.values()];
    R.run = { seq: seq.map(q => q.join('>')), tailRest: f.tailRest, cuts: f.cropCutsAll,
              minY: mm(minY), cx: [mm(minCx), mm(maxCx)], t: mm(n / 120) };
    ok('後端の端材が ONBED → CHUTE → PITFALL → TAILCONV → TAILDROP → REST の順に進む',
       seq.length === f.tailRest && seq.length > 0 && seq.every(q => q.join('>') === order.join('>')),
       seq.map(q => q.join(' → ')).join(' ／ '));
    ok('後端の端材がパスラインより下（ピットの中）を通る', minY < -CS.TAIL.PIT.DEPTH / 2,
       `最深 ${mm(minY)} mm（パスライン基準）`);
    ok('後端の端材がピットの X 範囲から出ない', minCx > TC.PIT.X0 - 1 && maxCx < 1,
       `X ${mm(minCx)}〜${mm(maxCx)}（ピット ${TC.PIT.X0}〜${TC.PIT.X1}）`);
    ok('後端も複数カットでき、下台はカットのあいだにパスラインへ戻る',
       f.tailRest >= 2 && bedBack && f.bedDrop <= 0.001,
       `後端 ${f.tailRest} カット / 下台の戻り ${bedBack ? '有' : '無'} / 最終 bedDrop ${f.bedDrop.toFixed(3)}`);
    ok('端材はすべて静止する（搬送の途中で止まらない）', f.scrapRest === f.cropCutsAll,
       `静止 ${f.scrapRest} / 総カット ${f.cropCutsAll}`);
  }

  /* --- 4. 搬送中の端材が固定設備へ食い込まない --- */
  {
    A.reset ? null : null;
    R.dig = { pen: 0, at: null, stage: null };
    // すでに 3 で運転し終えているので、もう一度最初から «描画つきで» 追う
    A.bus.emit('CMD_RESET');
    window.__startAuto(false);
    const fixed = [chute, pit, box, FV.cropShear.children.find(o => o.name === '75mmシャー架構')].filter(Boolean);
    const ax = -TL.convRotX, az = -TL.chuteRotZ;  // コンベア／シュートの傾きを打ち消す座標系
    // 傾斜コンベアのデッキだけは «面» として厳密に見る。デッキも端材も傾いた薄板なので、
    // 三角形 AABB では（どの座標系で見ても）太りが残り、偽陽性と本物を分けられない。
    // デッキ面は式で書けるのだから、端材の頂点の «面からの符号付き距離» を直接測る。
    const V = TC.CONV, PLc = K.MILL.PASS_LINE, cxw = K.CROP_SHEAR.X + K.FLIP * TL.convCx;
    const ca = 1 / Math.hypot(1, TL.convGrad);
    const belowDeck = (m) => {
      m.updateWorldMatrix(true, false);
      const pos = m.geometry.attributes.position; let deep = 0, at = null;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const x = v.x / sc, y = v.y / sc, z = v.z / sc;
        if (z < Math.min(V.Z0, V.Z1) || z > Math.max(V.Z0, V.Z1)) continue;   // デッキの範囲外
        if (Math.abs(x - cxw) > V.W / 2) continue;
        const d = (PLc + TL.convY(z) - y) * ca;                               // + ならデッキより下
        if (d > deep) { deep = d; at = [x, y, z].map(Math.round); }
      }
      return { best: deep, at };
    };
    let n = 0;
    while (n++ < 120 * 420) {
      P.step(1 / 120);
      const f = P.finish;
      const moving = f.scraps.filter(s => /CHUTE|PITFALL|TAILCONV|TAILDROP/.test(s.stage));
      if (moving.length && n % 6 === 0) {
        W.render(P, 0.05);
        for (const s of moving) {
          const m = FV.scraps.get(s.id); if (!m) continue;
          const mt = [tris(m), tris(m, ax, 'x'), tris(m, az, 'z')];
          for (const o of fixed) {
            const ot = [tris(o), tris(o, ax, 'x'), tris(o, az, 'z')];
            const p = digN(mt.map((a, i) => [a, ot[i]]));
            if (p.best > R.dig.pen) R.dig = { pen: mm(p.best), at: p.at, stage: s.stage, with: o.name };
          }
          const d = belowDeck(m);
          if (d.best > R.dig.pen) R.dig = { pen: mm(d.best), at: d.at, stage: s.stage, with: '傾斜コンベアのデッキ面' };
        }
      }
      if (f.cropDone && f.scrapRest >= f.cropCutsAll) break;
    }
    ok('搬送中の後端の端材が固定設備へ食い込まない', R.dig.pen <= EPS,
       `最大の食い込み ${R.dig.pen} mm${R.dig.with ? `（${R.dig.with} / ${R.dig.stage}）` : ''}`);
  }

  R.failed = R.checks.filter(c => !c.pass).length;
  return R;
}, EPS);

for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log('\nbed  :', JSON.stringify(out.bed));
console.log('feet :', JSON.stringify(out.feet));
console.log('run  :', JSON.stringify(out.run));
console.log('dig  :', JSON.stringify(out.dig));
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
