// 蛇行（キャンバーと横行）の «実測» トレース。
//   node cambertrace.mjs
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  const M = K.MILL, w = 1500;

  // 1) くさび: 中心なら «ゼロ点誤差» だけ、横へずれるほど大きくなる
  const w0 = R.gapWedge(2500, w, 0), wp = R.gapWedge(2500, w, 100), wm = R.gapWedge(2500, w, -100);
  ok('板が中心にあればくさびはゼロ点誤差だけ', Math.abs(w0 - M.LEVEL_ERR) < 1e-9,
     `${w0.toFixed(4)} mm（ゼロ点誤差 ${M.LEVEL_ERR}）`);
  ok('横へずれるとくさびが増える（正の帰還の種）', wp > w0 && wm < w0,
     `−100 mm: ${wm.toFixed(4)} ／ 0: ${w0.toFixed(4)} ／ +100 mm: ${wp.toFixed(4)} mm`);
  ok('ずれの向きでくさびの向きが変わる（中心対称）', Math.abs((wp - w0) + (wm - w0)) < 1e-9,
     `±100 mm で ${(wp - w0).toFixed(5)} / ${(wm - w0).toFixed(5)} mm`);
  ok('荷重が高いほどくさびが大きい', R.gapWedge(3500, w, 100) - M.LEVEL_ERR > wp - M.LEVEL_ERR,
     `2500 t: ${(wp - M.LEVEL_ERR).toFixed(5)} → 3500 t: ${(R.gapWedge(3500, w, 100) - M.LEVEL_ERR).toFixed(5)} mm`);

  // 2) キャンバー: くさびが 0 なら曲がらない／薄い側が外を向く
  ok('くさびが無ければ曲がらない', R.camber(60, 45, 0, w) === 0, '0 1/mm');
  const kc = R.camber(60, 45, 0.05, w);
  ok('くさびがあると平面内に曲率がつく', Math.abs(kc) > 0, `${kc.toExponential(3)} 1/mm（半径 ${(1 / Math.abs(kc) / 1000).toFixed(1)} m）`);
  ok('くさびの向きで曲がる向きが変わる', Math.sign(R.camber(60, 45, -0.05, w)) === -Math.sign(kc), '正負で対称');
  ok('くさびが大きいほど強く曲がる', Math.abs(R.camber(60, 45, 0.1, w)) > Math.abs(kc),
     `0.05 mm: ${Math.abs(kc).toExponential(2)} → 0.1 mm: ${Math.abs(R.camber(60, 45, 0.1, w)).toExponential(2)}`);
  ok('圧下が大きいほど（同じくさびでも）曲がりが強い',
     Math.abs(R.camber(60, 30, 0.05, w)) > Math.abs(kc),
     `45 mm: ${Math.abs(kc).toExponential(2)} → 30 mm: ${Math.abs(R.camber(60, 30, 0.05, w)).toExponential(2)}`);

  /* 3) 通しで走らせる。差荷重制御（自動レベリング）を «入れた／切った» で比べ、
   *    制御が蛇行をどれだけ抑えているかを実測する。 */
  const run = (kp) => new Promise(r => {
    CONFIG_KP(kp); A.bus.emit('CMD_RESET');
    setTimeout(() => {
      window.__startAuto(false);
      let zMax = 0, roomMin = 1e9, over = 0, camMax = 0, hit = 0, camSum = 0, camN = 0, tiltMax = 0;
      window.__ff((p) => {
        const s = p.slab, m = p.mill;
        if (s.onLine) {
          const room = Math.max(m.guideGap / 2 - s.width / 2, 0);
          zMax = Math.max(zMax, Math.abs(s.zOff)); roomMin = Math.min(roomMin, room);
          camMax = Math.max(camMax, Math.abs(s.camber));
          tiltMax = Math.max(tiltMax, Math.abs(m.tilt));
          if (s.rollingActive && s.biteFill > 0.99) { camSum += Math.abs(s.camber); camN++; }
          if (Math.abs(s.zOff) > room + 1e-6) over++;
          if (s.guideHit > 0) hit = s.guideHit;
        }
        return p.finish.done || !!p.tripped;
      }, 120 * 3000, 0);
      r({ zMax, roomMin, over, camMax, camAvg: camN ? camSum / camN : 0, hit, tiltMax,
          done: P.finish.done, tripped: P.tripped });
    }, 400);
  });
  const CONFIG_KP = (kp) => { K.MILL.LEVEL.KP = kp; };
  const kp0 = K.MILL.LEVEL.KP;
  return (async () => {
    const off = await run(0), on = await run(kp0);
    ok('横行がサイドガイドの開口を超えない', on.over === 0, `はみ出し ${on.over} フレーム／最大 ${on.zMax.toFixed(1)} mm`);
    ok('蛇行が実際に起きている（ゼロ点誤差から）', on.zMax > 0.5, `最大の横ずれ ${on.zMax.toFixed(1)} mm`);
    ok('キャンバーが実機の桁（半径 100 m 以上）', on.camMax > 0 && 1 / on.camMax > 1e5,
       `最大 ${on.camMax.toExponential(2)} 1/mm（半径 ${(1 / on.camMax / 1000).toFixed(0)} m）`);
    ok('差荷重制御が蛇行を抑える（平均キャンバーが小さくなる）', on.camAvg < off.camAvg,
       `制御なし ${off.camAvg.toExponential(2)} → あり ${on.camAvg.toExponential(2)} 1/mm`);
    ok('差荷重制御でサイドガイドに当たっている時間が減る', on.hit < off.hit,
       `制御なし ${off.hit.toFixed(1)} s → あり ${on.hit.toFixed(1)} s`);
    ok('圧下の傾きが可動範囲に収まる', on.tiltMax <= K.MILL.LEVEL.MAX + 1e-9,
       `最大 ${on.tiltMax.toFixed(3)} mm（範囲 ±${K.MILL.LEVEL.MAX}）`);
    ok('ロットを通し切る（蛇行で止まらない）', on.done && !on.tripped, `done ${on.done}`);
    return { checks, zMax: +on.zMax.toFixed(1), roomMin: +on.roomMin.toFixed(0),
             hit: +on.hit.toFixed(1), hitOff: +off.hit.toFixed(1), camMax: on.camMax,
             camAvg: on.camAvg, camAvgOff: off.camAvg, tiltMax: +on.tiltMax.toFixed(3) };
  })();
});
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`最大の横ずれ ${out.zMax} mm ／ ガイドの余裕 ${out.roomMin} mm ／ 圧下の傾き 最大 ${out.tiltMax} mm`);
console.log(`ガイド接触: 制御なし ${out.hitOff} s → あり ${out.hit} s ／ 平均キャンバー: ${out.camAvgOff.toExponential(2)} → ${out.camAvg.toExponential(2)} 1/mm`);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
