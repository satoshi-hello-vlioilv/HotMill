// ピット炉バンク・スラブヤードの配置と、ピットクレーンのトングの «掴み方» を検査する。
//
// 見たいのは 3 つ。
//   ① ヤードが «3 m 幅の 1 列» でラインのすぐ脇に居るか、炉がその外に詰めて並ぶか
//   ② 炉の内法が «立てたスラブ 10 本» を呑めるか（板厚の面を突き合わせて並ぶ向き）
//   ③ トングがスラブの «長手側面» を掴み、ボディが板の頭より上に収まっているか
//      —— 板厚の面を掴むと転倒機の受け面と爪が同じ場所を取り合う。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, L = window.__LAYOUT, T = window.__T, S = K.SCALE;
  const SV = W.supplyView, FU = K.FURNACE, Y = K.SLAB_YARD, TG = K.CRANE.TONG;

  const bb = new T.Box3(), box = (o) => { const b = new T.Box3(); b.setFromObject(o); return {
    x0: b.min.x / S, x1: b.max.x / S, y0: b.min.y / S, y1: b.max.y / S, z0: b.min.z / S, z1: b.max.z / S }; };

  // --- 配置（設定値と実物の両方から） ---
  const slab = P.slab, wid = slab.width, len = slab.length;
  const plate = L.yardPlate(len, wid);
  const pitHalfZ = FU.W / 2 + FU.WALL;
  const pitZ0 = Math.abs(FU.Z) - pitHalfZ, pitZ1 = Math.abs(FU.Z) + pitHalfZ;
  const yz0 = Math.min(Math.abs(plate.z0), Math.abs(plate.z1)), yz1 = Math.max(Math.abs(plate.z0), Math.abs(plate.z1));

  /* --- 運転前（待機）の姿勢。吊具が炉の中へ刺さっていないこと ---
   * 蓋を開ける工程の間は «スラブは炉の中で動かず、吊具は炉口の上で待つ» のが正しい。 */
  SV.update(P.supply, slab, P.mill, 1 / 60);
  W.scene.updateMatrixWorld(true);
  const idleBox = (() => { const b = new T.Box3(); b.setFromObject(SV.pitTong.g); return b; })();
  const rim = 240;                                          // 炉口の縁の天端（Parts.furnacePit）
  const idle = { tongY0: idleBox.min.y / S, phase: P.supply.phase, rim,
                 blockY0: (() => { const b = new T.Box3(); b.setFromObject(SV.ropeBlock); return b; })().min.y / S };

  // --- トング: 吊り上げ切った瞬間の姿勢で測る ---
  A.bus.emit('CMD_START_SUPPLY');
  let g = 0;
  while (P.supply.phase !== 'TRAVEL' && g++ < 400000) P.step(1 / 120);
  P.step(1 / 120);
  SV.update(P.supply, slab, P.mill, 1 / 60);
  W.scene.updateMatrixWorld(true);                      // 位置を入れた «あと» の行列で測る
  const pose = SV._pose(P.supply, slab, P.mill.passLine);
  const slabTop = pose.y + len / 2, slabBot = pose.y - len / 2;

  // g の直下: [0]=ヘッド [1]=ボディ [2]=受け梁 がトングの «動かない側»、その後ろが左右のアーム
  // トングの中心（＝クレーンの居る Z）を原点にして測る
  const tc = new T.Vector3(); SV.pitTong.g.getWorldPosition(tc);
  const cz = tc.z / S;
  const fixed = SV.pitTong.g.children.filter(o => o.isMesh).map(box);
  const arms_g = SV.pitTong.arms, arms = arms_g.map(box);
  const fixedY0 = Math.min(...fixed.map(b => b.y0));
  const armY0 = Math.min(...arms.map(b => b.y0));
  /* 爪の «内面» は、アームの箱ではなく «爪の高さにある頂点» で測る
   * —— アームの箱にはピンのボス（トング中心の近く）も入ってしまうため。 */
  const innerAt = (grp, side) => {
    let best = null; const v = new T.Vector3();
    grp.updateWorldMatrix(true, true);
    grp.traverse(o => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const y = v.y / S, z = v.z / S - cz;
        if (y > armY0 + TG.JAW_H) continue;               // 爪の高さだけを見る
        if (side * z <= 0) continue;
        if (best === null || side * z < side * best) best = z;
      }
    });
    return best;
  };
  const armInnerZ = arms.map((_, i) => innerAt(arms_g[i], i === 0 ? -1 : 1));

  return {
    yard: { rows: Y.ROWS, stack: Y.STACK, band: yz1 - yz0, near: yz0, far: yz1,
            slots: L.yardSlots().length, cap: L.yardSlots().reduce((a, q) => a + q.stack, 0) },
    pit: { L: FU.L, W: FU.W, depth: FU.DEPTH, z0: pitZ0, z1: pitZ1,
           perPit: FU.PER_PIT, cast: K.SLAB.CAST_MAX ?? 560, widMax: K.SLAB.WID_MAX, lenMax: K.SLAB.LEN_MAX,
           n: FU.N, smallL: FU.SMALL_L, groups: FU.GROUPS, gaps: FU.GAPS, inGap: FU.IN_GAP,
           lens: Array.from({ length: FU.N }, (_, i) => L.pitLen(i)),
           xs: Array.from({ length: FU.N }, (_, i) => Math.abs(L.pitX(i))),
           ends: { far: Math.abs(L.pitBankEnds().far), near: Math.abs(L.pitBankEnds().near) },
           entryEnd: Math.max(...K.TABLE.SECTIONS.filter(q => q.name.startsWith('A-')).map(q => Math.abs(q.x1))),
           bankEnd: Math.abs(L.pitX(FU.N - 1)) + L.pitLen(FU.N - 1) / 2 + FU.WALL },
    gapYardPit: pitZ0 - yz1,
    building: Math.max(Math.abs(K.BUILDING.X0), Math.abs(K.BUILDING.X1)),
    runway: Math.abs(K.CRANE.RUN_X0) + Math.abs(K.SUPPLY.TILTER_X),
    girderZ1: K.CRANE.GIRDER_Z1,
    tong: { yaw: SV.pitTong.g.rotation.y, pz: SV.pitTong.pz, gripHalf: wid / 2,
            armInnerZ, fixedY0, armY0, slabTop, slabBot, gripDown: TG.GRIP_DOWN,
            jawT: TG.JAW_T, jawPad: TG.JAW_PAD, th: slab.thickness, wMax: TG.W_MAX, wMin: TG.W_MIN,
            ratedT: K.CRANE.RATED_T, liftSpec: K.CRANE.LIFT,
            lift: L.supplyPath(slab, P.mill.passLine).move.hoist,
            span: K.CRANE.GIRDER_Z1 - K.CRANE.GIRDER_Z0,
            wire: { ropes: SV.ropesP?.length ?? 0, noMast: !SV.mastCol && !SV.mastSleeve } },
    idle,
    seq: K.SEQUENCE.map(q => q[0]),
  };
});
await browser.close();

const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
const y = out.yard, p = out.pit, t = out.tong;

// ① ヤード
ok(`ヤードは 1 列（${y.rows} 列）`, y.rows === 1, y.rows);
ok(`ヤードの幅が 3 m 前後（${(y.band / 1000).toFixed(2)} m）`, y.band >= 2400 && y.band <= 3600, y.band);
ok(`ヤードがラインのすぐ脇（内側の縁 ${(y.near / 1000).toFixed(2)} m ≤ 3.5 m）`, y.near <= 3500, y.near);
ok(`置ける枚数が減っていない（${y.cap} 枚 ≥ 16）`, y.cap >= 16, y.cap);

// ② ピット炉
ok(`炉の内法 L が立てたスラブ ${p.perPit} 本ぶん（${p.L} ≥ ${p.perPit * p.cast}）`, p.L >= p.perPit * p.cast, p.L);
ok(`炉の内法 W が板幅の最大を呑む（${p.W} ≥ ${p.widMax}）`, p.W >= p.widMax, p.W);
ok(`炉の深さが板長の最大より深い（${p.depth} ≥ ${p.lenMax}）`, p.depth >= p.lenMax, p.depth);
// 図面の並び: A-1 側の端が PIT9（極小）、そこからミル側へ 3-3-2 の群
ok(`バンクの端が入側テーブル A-1 の端と一致（炉 ${p.ends.far} / テーブル ${p.entryEnd}）`,
   Math.abs(p.ends.far - p.entryEnd) <= 1, p.ends.far);
ok(`A-1 側の端が PIT${p.n}（いちばん外の炉が最後の番号）`,
   p.xs[p.n - 1] === Math.max(...p.xs), p.xs[p.n - 1]);
ok(`PIT${p.n} が極小（内法 ${p.smallL} ≤ 通常の炉 ${p.L} の 1/3）`, p.smallL <= p.L / 3, p.smallL);
ok(`炉の並びが群 ${p.groups.join('-')} になっている（群の中は炉口の縁ぶんだけ空く）`, (() => {
     let n = 0; const bnd = new Set();
     for (let k = 0; k < p.groups.length - 1; k++) { n += p.groups[k]; bnd.add(n); }
     for (let i = 1; i < p.n; i++) {
       const d = Math.abs(p.xs[i] - p.xs[i - 1]);
       const gap = bnd.has(i) ? p.gaps[[...bnd].indexOf(i)] : p.inGap;
       const want = (p.lens[i] + p.lens[i - 1]) / 2 + 2 * 500 + gap;
       if (Math.abs(d - want) > 1) return false;
     }
     return true;
   })(), p.xs.map(x => Math.round(x)).join(','));
ok(`群の中の炉が炉口の縁（±350 mm）ぶん離れている（${p.inGap} mm ≥ 700）`, p.inGap >= 700, p.inGap);
ok(`バンク全体が入側テーブルの内側に収まる（ミル側の端 ${Math.round(p.ends.near)} > 0）`, p.ends.near > 0 && p.ends.near < p.entryEnd, Math.round(p.ends.near));
ok(`炉がヤードの外に 1〜4 m の間隔で並ぶ（${(out.gapYardPit / 1000).toFixed(2)} m）`,
   out.gapYardPit >= 1000 && out.gapYardPit <= 4000, out.gapYardPit);
ok(`炉バンクが建屋に収まる（端 ${(p.bankEnd / 1000).toFixed(1)} m ≤ ${(out.building / 1000).toFixed(0)} m）`,
   p.bankEnd <= out.building, p.bankEnd);
ok(`クレーン走行路が炉バンクを覆う（${(out.runway / 1000).toFixed(1)} m ≥ ${(p.bankEnd / 1000).toFixed(1)} m）`,
   out.runway >= p.bankEnd, out.runway);
ok(`走行桁の外端が炉の外に出ている（${out.girderZ1} ≥ ${Math.round(p.z1)}）`, out.girderZ1 >= p.z1, out.girderZ1);

// ③ トング
// 運転前の待機姿勢（画面を開いた瞬間の見え方）
ok(`運転前の工程が «蓋開け» から始まる（${out.idle.phase}）`, out.idle.phase === 'IDLE' || out.idle.phase === 'LID', out.idle.phase);
ok('蓋を開けてから取りに行く工程がある（降下・掴むが独立している）',
   out.seq.includes('DIVE') && out.seq.includes('GRIP'), out.seq.join('→'));
ok(`運転前の吊具が炉口の縁より上に居る（トング下端 ${out.idle.tongY0.toFixed(0)} > ${out.idle.rim}）`,
   out.idle.tongY0 > out.idle.rim, out.idle.tongY0.toFixed(0));
ok(`運転前のシーブブロックも炉の外（下端 ${out.idle.blockY0.toFixed(0)}）`,
   out.idle.blockY0 > out.idle.rim, out.idle.blockY0.toFixed(0));
ok('爪は板幅の方向（世界 Z）に開閉する（yaw = 0）', Math.abs(t.yaw) < 1e-6, t.yaw);
// 図面の «トング最大開き 1,900 / 最小 250»。掴める板幅は 1,900 − 爪厚 2 枚。
ok(`爪の全開が図面どおり（外側 ${t.wMax} mm ＝ トング最大開き）`, t.wMax === 1900, t.wMax);
ok(`爪の最小開きが図面どおり（${t.wMin} mm）`, t.wMin === 250, t.wMin);
ok(`既定ロットの板幅を掴める（掴める最大 ${t.wMax - 2 * t.jawT} ≥ ${t.gripHalf * 2}）`,
   t.wMax - 2 * t.jawT >= t.gripHalf * 2, t.wMax - 2 * t.jawT);
ok(`定格荷重 ${t.ratedT} t が仕様どおり`, t.ratedT === 10, t.ratedT);
ok(`揚程が仕様どおり（巻上距離 ${(t.lift / 1000).toFixed(2)} m ＝ ${(t.liftSpec / 1000).toFixed(1)} m）`,
   Math.abs(t.lift - t.liftSpec) <= 50, Math.round(t.lift));
ok(`スパンが仕様どおり（${(t.span / 1000).toFixed(1)} m ＝ 21 m）`, Math.abs(t.span - 21000) <= 50, t.span);
ok('吊具がワイヤ吊り（剛体マストを持たない）', t.wire.ropes === 4 && t.wire.noMast, JSON.stringify(t.wire));
ok(`爪パッドが板厚に収まる（${t.jawPad} ≤ ${t.th}）`, t.jawPad <= t.th, t.jawPad);
const err = t.armInnerZ.map(z => Math.abs(Math.abs(z) - t.gripHalf));
ok(`左右の爪が板の長手側面を掴んでいる（±${t.gripHalf} mm に対し誤差 ${err.map(e => e.toFixed(0)).join(' / ')} mm）`,
   err.every(e => e <= 120), err.map(e => +e.toFixed(0)).join('/'));
ok(`左右の爪が対称（${t.armInnerZ.map(z => z.toFixed(0)).join(' / ')}）`,
   Math.abs(t.armInnerZ[0] + t.armInnerZ[1]) <= 60, t.armInnerZ.map(z => +z.toFixed(0)).join('/'));
ok(`ボディ・受け梁が板の頭より上（下端 ${t.fixedY0.toFixed(0)} ≥ 板頭 ${t.slabTop.toFixed(0)} − 100）`,
   t.fixedY0 >= t.slabTop - 100, (t.fixedY0 - t.slabTop).toFixed(0));
ok(`爪は板の上のほうを掴む（爪先 ${t.armY0.toFixed(0)} が板の中央より上）`,
   t.armY0 >= (t.slabTop + t.slabBot) / 2, (t.armY0 - t.slabBot).toFixed(0));

console.log(JSON.stringify({ yard: y, pit: p, gapYardPit: Math.round(out.gapYardPit), tong: {
  ...t, armInnerZ: t.armInnerZ.map(z => +z.toFixed(0)) } }, null, 1));
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} ${bad.length ? 'FAIL' : 'PASS'}`);
process.exit(bad.length ? 1 : 0);
