// 転倒中の板が転倒軸からどこまで張り出すかを実測する評価器。
// 立てた状態・寝た状態はどちらも板の断面（厚み/2）ぶんしか軸から出ないが、回転の
// «斜めの瞬間» は対角線ぶん出るため、直感的な見積りより大きくなる。押し出しプッシャの
// 退避位置（RETRACT）はこの実測値に安全率を足して決めている（README「2 台のクレーンの
// フレームを分離した理由」参照）。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, sc = K.SCALE, T = window.__T;
  const SV = A.world.supplyView;
  window.__startAuto(true);
  let maxX = -Infinity, atT = null;
  const v = new T.Vector3();
  let n = 0;
  while (n++ < 120 * 60 && P.supply.active) {
    P.step(1 / 120);
    if (P.supply.phase === 'TILT') {
      SV.slab.updateWorldMatrix(true, false);
      // 板（単位立方体をスケールした箱）の 8 頂点をワールドへ変換し、軸方向の最大値を追う
      for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [-0.5, 0.5]) {
        v.set(cx, cy, cz).applyMatrix4(SV.slab.matrixWorld);
        if (v.x / sc > maxX) { maxX = v.x / sc; atT = P.supply.p.tilt; }
      }
    }
  }
  // maxX − tilterX が転倒軸からの張り出し量 [mm]。プッシャは退避時にこれより外側にいること
  return { maxX: Math.round(maxX), atT: atT?.toFixed(3), tilterX: K.SUPPLY.TILTER_X,
           overhang: Math.round(maxX - K.SUPPLY.TILTER_X) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
