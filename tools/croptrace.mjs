// 75 mm シャーの «実測» トレース。推測せず、描画されている実体の座標を読む。
//  ・スラブの実描画範囲（SlabView のメッシュから）と論理 xMin/xMax
//  ・刃先・押えの実 Y、端材メッシュの実座標
//  ・切断イベント前後の板長・端材長
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const T = path.resolve('node_modules/three');
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:900,height:520}});
p.setDefaultTimeout(600000);
p.on('pageerror', e=>console.log('[ERR]', e.message));
p.on('console', m=>{ if(m.type()==='error' && !m.text().includes('ERR_CONNECTION')) console.log('[CONSOLE]', m.text()); });
await p.route('**/__three__', r=>r.fulfill({contentType:'application/javascript', body:fs.readFileSync(T+'/build/three.module.js','utf8')}));
await p.route('**/examples/jsm/**', r=>{ const rel=new URL(r.request().url()).pathname.split('/examples/jsm/')[1];
  const f=T+'/examples/jsm/'+rel; if(!fs.existsSync(f)) return r.fulfill({status:404,body:''});
  r.fulfill({contentType:'application/javascript', body:fs.readFileSync(f,'utf8').replace(/from ['"]three['"]/g,"from '/__three__'")});});
await p.route('**/font-awesome/**', r=>r.fulfill({contentType:'text/css', body:''}));
await p.route('**/index.html', r=>{ let h=fs.readFileSync('/home/user/HotMill/index.html','utf8');
  h=h.replace(/\bnew App\(\);/,'window.__CFG=CONFIG; window.__app=new App();');
  h=h.replace(/"three":\s*"[^"]+"/,'"three": "/__three__"').replace(/"three\/addons\/":\s*"[^"]+"/,'"three/addons/": "/x/examples/jsm/"');
  r.fulfill({contentType:'text/html', body:h}); });
await p.goto('http://localhost/index.html',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__app,null,{timeout:25000});
await p.waitForTimeout(1200);

const out = await p.evaluate(() => {
  const A=window.__app, P=A.physics, W=A.world, K=window.__CFG, sc=K.SCALE, S=K.CROP_SHEAR, F=K.FLIP;
  A._probed=true;
  const anim=document.getElementById('chk-supply-anim'); anim.checked=false; anim.dispatchEvent(new Event('change'));
  document.getElementById('btn-reset').click(); document.getElementById('btn-start').click();
  window.requestAnimationFrame=()=>0;

  const mm = v => Math.round(v);
  // 描画されている «実体» を読む
  const measure = (t) => {
    const sl=P.slab, f=P.finish, m=P.mill, FV=W.finishView, SV=W.slabView;
    SV.mesh.updateWorldMatrix(true,false);
    SV.mesh.geometry.computeBoundingBox();
    const bb = SV.mesh.geometry.boundingBox.clone().applyMatrix4(SV.mesh.matrixWorld);
    FV.cropRam.updateWorldMatrix(true,false); FV.cropHold.updateWorldMatrix(true,false);
    FV.cropPiece.updateWorldMatrix(true,false);
    return { t:+t.toFixed(2), stage:f.cropStage, blade:+f.cropBlade.toFixed(3),
      spd:mm(m.currentSpeed), th:+sl.thickness.toFixed(1),
      logic:{ xMin:mm(sl.xMin), xMax:mm(sl.xMax), len:mm(sl.length) },
      drawn:{ x0:mm(bb.min.x/sc), x1:mm(bb.max.x/sc), y0:mm(bb.min.y/sc), y1:mm(bb.max.y/sc) },
      ram:{ x:mm(FV.cropRam.position.x/sc + FV.cropShear.position.x/sc), y:mm(FV.cropRam.position.y/sc) },
      hold:{ y:mm(FV.cropHold.position.y/sc) },
      piece:{ vis:FV.cropPiece.visible, x:mm(FV.cropPiece.position.x/sc), y:mm(FV.cropPiece.position.y/sc),
              z:mm(FV.cropPiece.position.z/sc), len:mm(f.cropLen), cropY:mm(f.cropY),
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
  return { log, sched:sch, cfg:{ SHEAR_X:S.X, CROP_LEN:S.CROP_LEN, MAX_TH:S.MAX_TH,
            TABLE:{min:K.TABLE.X_MIN, max:K.TABLE.X_MAX}, FLIP:F } };
});
fs.writeFileSync('croptrace.json', JSON.stringify(out,null,1));
console.log('cfg', JSON.stringify(out.cfg));
for (const r of out.log) console.log(JSON.stringify(r));
await b.close();
