// 板面冷却ノズルの «狙いと着地» の実測。
//
// なぜ要るか: ノズルの向きは «ヘッダから狙い点へ引いた直線» で決めていたが、液は放物線を
// 描いて落ちるので、直線で狙うと重力ぶん外へ流れる。実測すると着地は板の «外»（幅 1,330 の
// 板に対して z = 829 mm、端は 665 mm）で、板には端しか掛かっていなかった。
// ここでは «向き» ではなく «着地点» を測る —— 解析（Layout.nozzleAim）と、実際に飛ぶ粒の
// 両方で。粒には空気抵抗も効くので、式どおりに落ちているかは粒で確かめないと分からない。
//   node tools/nozzletrace.mjs
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, L = window.__LAYOUT, W = window.__world;
  const R = { checks: [], aim: [], land: null }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: d });

  /* ---- 1) 解析: 狙った着地点に «届く角度» が解けているか ---- */
  for (const w of [900, 1330, 1500, 2200]) for (const h of [0, 8, 100, 530]) {
    const a = L.nozzleAim(w, h);
    R.aim.push({ w, h, aim: +a.aim.toFixed(1), land: +a.land.toFixed(1),
                 deg: +(a.tilt * 180 / Math.PI).toFixed(1), edge: w / 2 });
  }
  const worst = R.aim.reduce((m, q) => Math.max(m, Math.abs(q.land - q.aim)), 0);
  ok('狙った着地点へ届く角度が解けている（誤差 1 mm 未満）', worst < 1, `最大 ${worst.toFixed(2)} mm`);
  ok('着地点が板幅のクォーター（±W/4）', R.aim.every(q => Math.abs(q.aim - q.w * 0.25) < 1),
     R.aim.filter(q => q.h === 8).map(q => `${q.w}→±${q.aim}`).join(' '));
  ok('着地点が板の内側（エッジより中心寄り）', R.aim.every(q => q.land < q.edge - 50),
     R.aim.map(q => `${q.land}/${q.edge}`).slice(0, 4).join(' '));
  ok('板が薄いほど（落差が大きいほど）ノズルは立つ',
     R.aim.filter(q => q.w === 1330).every((q, i, a2) => i === 0 || q.deg >= a2[i - 1].deg - 1e-9),
     R.aim.filter(q => q.w === 1330).map(q => `h${q.h} ${q.deg}°`).join(' '));

  /* ---- 2) 実際に飛ぶ粒の着地点 ---- */
  // 供給アニメを飛ばして圧延を始め、出側ヘッダの下を板が通る状態にする
  const c = document.getElementById('chk-supply-anim'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); }
  document.getElementById('btn-start').click();
  const s = P.slab, m = P.mill;
  const zones = L.coolZones();
  const hits = [];
  let t = 0;
  const field = W.sprayView.strip, sc = K.SCALE;
  const prevY = new Float64Array(field.n);
  while (t < 400 && hits.length < 4000) {
    /* «上から降りてきて面に着いた» 粒だけを着地として数える。板の頭がヘッダの下へ入る
     * 瞬間は床（＝板の上面）が 500 mm 跳ね上がるので、それより下に居た粒まで
     * «着地» と数えると、遠くへ落ちた粒が混ざって平均が外へ寄る。 */
    for (let i = 0; i < field.n; i++) prevY[i] = field.pos[i * 3 + 1] / sc;
    P.step(1 / 120); t += 1 / 120;
    // 噴射の描画は render 経由。ここでは spray だけを進める（3D の描画は要らない）
    W.sprayView.update(1 / 120, P);
    if (!(s.onLine && Math.abs(m.currentSpeed) > 3)) continue;
    const onPlate = zones.some(([a2, b2]) => s.xMax > a2 && s.xMin < b2);
    if (!onPlate) continue;                       // 板がヘッダの下に無い間はテーブルへ落ちる
    const floor = K.MILL.PASS_LINE + (s.inBite ? m.gap : s.thickness);
    for (let i = 0; i < field.n; i++) {
      const p = field.p[i]; if (p.life <= 0) continue;
      const y = field.pos[i * 3 + 1] / sc, z = field.pos[i * 3 + 2] / sc, x = field.pos[i * 3] / sc;
      if (p.hit === 1 && Math.abs(y - floor) < 1 && prevY[i] > floor + 1
          && zones.some(([a2, b2]) => x > a2 && x < b2)) {
        hits.push({ z, w: s.width }); p.hit = 2;
      }
    }
  }
  const zs = hits.map(q => q.z), w0 = hits.length ? hits[0].w : s.width;
  const pos = zs.filter(z => z > 0), neg = zs.filter(z => z < 0);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const inside = zs.filter(z => Math.abs(z) < w0 / 2).length / Math.max(zs.length, 1);
  R.land = { n: zs.length, w: w0, edge: w0 / 2, quarter: w0 / 4,
             mean: +avg(pos).toFixed(0), meanNeg: +avg(neg).toFixed(0),
             min: Math.round(Math.min(...zs.map(Math.abs))), max: Math.round(Math.max(...zs.map(Math.abs))),
             inside: +(inside * 100).toFixed(1) };
  ok('噴射の粒が実際に着地している（標本が取れた）', zs.length > 200, `${zs.length} 標本`);
  ok('粒の 95 % 以上が板の上に落ちる', inside >= 0.95, `板の上 ${R.land.inside} %（エッジ ±${R.land.edge} mm）`);
  ok('着地の平均が板幅のクォーター付近（±30 mm）',
     Math.abs(R.land.mean - R.land.quarter) < 30 && Math.abs(-R.land.meanNeg - R.land.quarter) < 30,
     `OS +${R.land.mean} / DS ${R.land.meanNeg} mm（狙い ±${R.land.quarter}）`);
  ok('左右が均等（OS と DS の差が 30 mm 未満）', Math.abs(R.land.mean + R.land.meanNeg) < 30,
     `差 ${(R.land.mean + R.land.meanNeg).toFixed(0)} mm`);
  ok('エッジだけに偏っていない（着地がエッジより内側）', R.land.max < w0 / 2,
     `いちばん外 ${R.land.max} mm / エッジ ${R.land.edge} mm`);

  /* ノズルの «実物の向き»。噴射の粒は別に解いているので、粒が板に当たっていても
   * ノズルの首が外を向いていることがある（実際にそうなっていた: パイプ z 1,250 に対し
   * 先端 z 1,512 ＝ 262 mm 外向き）。実体の行列から先端の座標を読んで確かめる。 */
  {
    const T = window.__T, S = K.SCALE, W2 = A.world, GV = W2.guideView;
    const H = K.TABLE.GUIDE.HEADER, B = H.BOT;
    W2.render(A.physics, 0.1);
    const dirs = (inst, tipLocal) => {
      const m = new T.Matrix4(), v = new T.Vector3(), o = new T.Vector3(), out = [];
      for (let i = 0; i < inst.mesh.count; i++) {
        inst.mesh.getMatrixAt(i, m);
        o.set(0, 0, 0).applyMatrix4(m); v.copy(tipLocal).applyMatrix4(m);
        const pipeZ = o.z / S, tipZ = v.z / S;
        if (Math.abs(pipeZ) < 1) continue;
        out.push({ pipeZ: Math.round(pipeZ), tipZ: Math.round(tipZ), inward: Math.abs(tipZ) < Math.abs(pipeZ) - 20 });
      }
      return out;
    };
    const top = dirs(GV.nozzles, new T.Vector3(0, -(H.D / 2 + 150 - 10 + 75) * S, 0));
    const bot = dirs(GV.botNozzles, new T.Vector3(0, (B.D / 2 + 130 - 8 + 65) * S, 0));
    const one = (a) => a.length ? `${a[0].pipeZ} → ${a[0].tipZ} mm` : '標本なし';
    ok('上面ノズルの首がラインの内側を向いている', top.length > 0 && top.every(q => q.inward),
       `${top.filter(q => q.inward).length}/${top.length} 本（${one(top)}）`);
    ok('下面ノズルの首もラインの内側を向いている', bot.length > 0 && bot.every(q => q.inward),
       `${bot.filter(q => q.inward).length}/${bot.length} 本（${one(bot)}）`);
    // 首の向きと粒の着地が同じ側（首だけ反転していないこと）を «符号» で確かめる
    const sameSide = top.every(q => Math.sign(q.tipZ) === Math.sign(q.pipeZ));
    ok('首を倒しても反対側へ飛び出さない（倒しすぎていない）', sameSide,
       sameSide ? '上下とも自分の側に留まる' : '反対側へ回り込んでいる');
  }
  R.failed = R.checks.filter(q => !q.pass).length;
  return R;
});

console.log('狙いと着地（解析）:');
console.log('  板幅  板厚 | 狙い  着地  角度   エッジ');
for (const q of out.aim) console.log(`  ${String(q.w).padStart(4)} ${String(q.h).padStart(5)} | ${String(q.aim).padStart(5)} ${String(q.land).padStart(5)} ${String(q.deg).padStart(6)}° ${String(q.edge).padStart(6)}`);
console.log('\n粒の着地（実測）:', JSON.stringify(out.land));
console.log('');
for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - out.failed}/${out.checks.length})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
