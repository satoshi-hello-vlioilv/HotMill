// 75 mm シャーの «実測» トレース。推測せず、描画されている実体の座標を読む。
//  ・スラブの実描画範囲（SlabView のメッシュから）と論理 xMin/xMax
//  ・刃先・押えの実 Y、端材メッシュの実座標
//  ・切断イベント前後の板長・端材長
import fs from 'node:fs';
import { openApp, installHelpers } from './harness.mjs';
const { browser: b, page: p } = await openApp({ viewport: { width: 900, height: 520 }, quiet: false });
await installHelpers(p);

const out = await p.evaluate(() => {
  const A=window.__app, P=A.physics, W=A.world, K=window.__CFG, sc=K.SCALE, S=K.CROP_SHEAR, F=K.FLIP;
  window.__startAuto(false);

  const mm = v => Math.round(v);
  // 描画されている «実体» を読む
  const measure = (t) => {
    const sl=P.slab, f=P.finish, m=P.mill, FV=W.finishView, SV=W.slabView;
    SV.mesh.updateWorldMatrix(true,false);
    SV.mesh.geometry.computeBoundingBox();
    const bb = SV.mesh.geometry.boundingBox.clone().applyMatrix4(SV.mesh.matrixWorld);
    FV.cropBed.updateWorldMatrix(true,false);
    const sc0 = f.scraps[f.scraps.length - 1], pm = sc0 ? FV.scraps.get(sc0.id) : null;
    return { t:+t.toFixed(2), stage:f.cropStage, blade:+f.cropBlade.toFixed(3),
      spd:mm(m.currentSpeed), th:+sl.thickness.toFixed(1),
      logic:{ xMin:mm(sl.xMin), xMax:mm(sl.xMax), len:mm(sl.length) },
      drawn:{ x0:mm(bb.min.x/sc), x1:mm(bb.max.x/sc), y0:mm(bb.min.y/sc), y1:mm(bb.max.y/sc) },
      bed:{ x:mm(FV.cropBed.position.x/sc + FV.cropShear.position.x/sc), lift:mm(FV.cropBed.position.y/sc - K.MILL.PASS_LINE) },
      cut:{ i:f.cropIndex, n:f.cropCuts, each:f.cropEach, total:f.cropTotal, need:mm(f.cropNeed) },
      piece:{ n:f.scraps.length, stage:sc0?.stage, x:pm?mm(pm.position.x/sc):null, y:pm?mm(pm.position.y/sc):null,
              z:pm?mm(pm.position.z/sc):null, len:mm(f.cropLen), rest:f.scrapRest,
              push:+f.cropPush.toFixed(2), face:mm(FV.cropPusher.position.z/sc) },
      shearX:mm(S.X) };
  };

  const log=[]; let t=0, armed=false, endAt=null;
  for (let n=0;n<120*1500;n++){
    P.step(1/120); t+=1/120;
    const f=P.finish;
    const active = f.cropStage!=='IDLE' && f.cropStage!=='DONE';
    if (active && !armed){ armed=true; W.render(P,1/60); log.push({ mark:'ARM', ...measure(t) }); }
    if (armed && n%20===0 && log.length<200){ W.render(P,1/60); log.push(measure(t)); }
    if (f.cropDone && endAt===null) endAt = t + 2.0;
    if (endAt!==null && t>endAt) break;
  }
  // シャー位置とコイル長の整合を見るための追加情報
  const sch = K.SCHEDULE.map(q=>({pass:q.pass, gap:q.gap, dir:q.dir}));
  return { log, sched:sch, cfg:{ SHEAR_X:S.X, CUT:[S.CUT_MIN,S.CUT_MAX], MAX_TH:S.MAX_TH,
            TABLE:{min:K.TABLE.X_MIN, max:K.TABLE.X_MAX}, FLIP:F } };
});
fs.writeFileSync('croptrace.json', JSON.stringify(out,null,1));
console.log('cfg', JSON.stringify(out.cfg));
for (const r of out.log) console.log(JSON.stringify(r));
await b.close();
