// コイルカーの «足が付いているか» を実測する評価器。
//   node cartrace.mjs
// 以前は台車ごと持ち上げていたので、コイルを受けている間じゅう車輪が宙に浮いていた。
// ここでは「車輪はレールに載ったまま／デッキだけが上がる」ことを全ステージで確かめる。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, W = A.world;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  const V = W.finishView;                                   // 出側（巻取・コイルカー）のビュー
  const C = K.COILER, CR = C.CAR, s = 1 / K.SCALE;
  const railTop = 120;                                      // レール天端（Parts.coilCarRail）

  // --- 幾何: ケーブルベアの全長が台車の位置に依らないこと（実物は伸び縮みしない）---
  {
    const CH = window.__CHAIN;
    const lens = [0, 1500, 3000, 4500, 6000].map((z) => {
      // 経路を細かく刻んで «実際に» 長さを積む（式ではなく経路そのものを測る）
      let L = 0, prev = CH.at(0, z);
      for (let t = 1; t <= 2000; t++) {
        const q = CH.at(CH.length * t / 2000, z);
        L += Math.hypot(q.z - prev.z, q.y - prev.y); prev = q;
      }
      return L;
    });
    const spread = Math.max(...lens) - Math.min(...lens);
    ok('ケーブルベアの全長が台車の位置に依らない（±5 mm）', spread < 5,
       `${lens.map(v => v.toFixed(0)).join(' / ')} mm（差 ${spread.toFixed(2)}）`);
    ok('曲がりは必ず台車の «先» にある', [0, 3000, 6000].every(z => CH.bendZ(z) >= z + 10),
       [0, 3000, 6000].map(z => `${z}→${CH.bendZ(z).toFixed(0)}`).join(' '));
    ok('下段は床の上、上段は台枠の下に収まる',
       CH.cfg.Y0 > 0 && CH.cfg.Y0 + 2 * CH.cfg.R + CH.cfg.H / 2 < CR.REST_Y - CR.DECK_Y - 180,
       `下段 ${CH.cfg.Y0} / 上段の天 ${CH.cfg.Y0 + 2 * CH.cfg.R + CH.cfg.H / 2} / 台枠の下面 ${CR.REST_Y - CR.DECK_Y - 180}`);
  }

  // --- 通し運転: 各ステージで車輪の下端とデッキ上面を測る ---
  A.bus.emit('CMD_RESET');
  await new Promise(r => setTimeout(r, 300));
  window.__startAuto(false);
  const seen = new Map();
  const wheelBottom = () => {
    // 台車メッシュの «実際の» ワールド AABB の下端（＝車輪の下端）
    const m = V.carBogie; m.updateWorldMatrix(true, false);
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
    return bb.min.y * s;
  };
  window.__ff((p) => {
    const f = p.finish;
    if (f.carStage && !seen.has(f.carStage)) {
      W.render(p, 1 / 60);
      seen.set(f.carStage, { wheel: +wheelBottom().toFixed(1), deck: +(V.car.position.y * s).toFixed(1),
                             z: +f.carZ.toFixed(0), lift: +f.carLift.toFixed(2) });
    }
    return f.carStage === 'REST' && f.carLift <= 0 || p.tripped;
  }, 120 * 4000, 0);
  W.render(P, 1 / 60);
  if (!seen.has(P.finish.carStage)) seen.set(P.finish.carStage,
    { wheel: +wheelBottom().toFixed(1), deck: +(V.car.position.y * s).toFixed(1),
      z: +P.finish.carZ.toFixed(0), lift: +P.finish.carLift.toFixed(2) });

  const rows = [...seen.entries()].map(([k, v]) => ({ stage: k, ...v }));
  ok('どのステージでも車輪がレールに載っている（±20 mm）',
     rows.length > 0 && rows.every(r => Math.abs(r.wheel - railTop) <= 20),
     rows.map(r => `${r.stage} ${r.wheel}`).join(' / ') + ` （レール天端 ${railTop}）`);
  const lifted = rows.filter(r => r.lift > 0.5);
  ok('受けているときはデッキだけが上がっている', lifted.length > 0 && lifted.every(r => r.deck > CR.REST_Y + 100),
     lifted.map(r => `${r.stage} デッキ ${r.deck}（待機 ${CR.REST_Y}）`).join(' / ') || '（昇降した瞬間を捉えられず）');
  ok('全ステージを通る', ['APPROACH', 'LIFT', 'STRIP', 'CARRY', 'SET'].every(k => seen.has(k)),
     [...seen.keys()].join(' → '));
  return { checks, rows };
});
for (const r of out.rows) console.log(`${r.stage.padEnd(9)} 車輪下端 ${r.wheel} mm ／ デッキ上面 ${r.deck} mm ／ Z ${r.z} ／ 昇降 ${r.lift}`);
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
process.exit(out.checks.every(c => c.pass) ? 0 : 1);
