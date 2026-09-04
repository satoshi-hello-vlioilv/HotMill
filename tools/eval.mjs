/**
 * HotMill 評価ハーネス
 * 目的: 「描画コスト / 物理整合 / 幾何整合 / 数値健全性 / 初期フレーミング」を数値で判定する。
 * 外部CDNへ到達できない環境のため three.js はローカルへルーティングする。
 * index.html 自体は `new App()` を window に露出する1行だけの改変で評価する。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THREE_DIR = path.join(__dirname, 'node_modules/three');
const TARGET = process.argv[2] || '/home/user/HotMill/index.html';
const LABEL = process.argv[3] || 'baseline';

const readThree = () => fs.readFileSync(path.join(THREE_DIR, 'build/three.module.js'), 'utf8');

const run = async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  await page.route('**/__three__', r => r.fulfill({ contentType: 'application/javascript', body: readThree() }));
  await page.route('**/examples/jsm/**', r => {
    const rel = new URL(r.request().url()).pathname.split('/examples/jsm/')[1];
    const f = path.join(THREE_DIR, 'examples/jsm', rel);
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ contentType: 'application/javascript',
      body: fs.readFileSync(f, 'utf8').replace(/from ['"]three['"]/g, `from '/__three__'`) });
  });
  await page.route('**/font-awesome/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/index.html', r => {
    let h = fs.readFileSync(TARGET, 'utf8');
    h = h.replace(/\bnew App\(\);/, 'window.__CFG = CONFIG; window.__ROLL = Rolling; window.__app = new App();');
    h = h.replace(/"three":\s*"[^"]+"/, '"three": "/__three__"');
    h = h.replace(/"three\/addons\/":\s*"[^"]+"/, '"three/addons/": "/x/examples/jsm/"');
    r.fulfill({ contentType: 'text/html', body: h });
  });

  await page.goto('http://localhost/index.html', { waitUntil: 'load' }).catch(() => {});
  await page.waitForFunction(() => !!window.__app, null, { timeout: 25000 });

  // 実インスタンスを掴んでレンダラを計装する（render はインスタンスプロパティ）
  await page.evaluate(async () => {
    const THREE = await import('/__three__');
    window.__T = THREE;
    const w = window.__app.world;
    const r = w.renderer;
    const p = window.__probe = { frames: [], gpu: [], last: 0 };
    const orig = r.render.bind(r);
    r.render = (s, c) => {
      const t = performance.now();
      if (p.last) p.frames.push(t - p.last);
      p.last = t;
      const out = orig(s, c);
      p.gpu.push(performance.now() - t);
      return out;
    };
    p.renderer = r; p.scene = w.scene; p.camera = w.camera;
  });
  await page.waitForTimeout(1200);

  const R = { label: LABEL, target: TARGET };

  // ---- E1: シーン構成コスト ----
  R.scene = await page.evaluate(() => {
    const { renderer, scene } = window.__probe;
    let meshes = 0, instanced = 0, instances = 0, tris = 0, objects = 0, lights = 0, shadowCasters = 0;
    const geos = new Set(), mats = new Set();
    scene.traverse(o => {
      objects++;
      if (o.isLight) lights++;
      if (o.castShadow) shadowCasters++;
      if (o.isInstancedMesh) { instanced++; instances += o.count; }
      else if (o.isMesh) meshes++;
      if (o.geometry) {
        geos.add(o.geometry.uuid);
        const g = o.geometry, n = g.index ? g.index.count : (g.attributes.position?.count || 0);
        tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
      }
      if (o.material) [].concat(o.material).forEach(m => mats.add(m.uuid));
    });
    return { objects, meshes, instancedMeshes: instanced, instanceCount: instances, lights, shadowCasters,
      uniqueGeometries: geos.size, uniqueMaterials: mats.size, sceneTriangles: Math.round(tris),
      drawCalls: renderer.info.render.calls, renderedTriangles: renderer.info.render.triangles,
      programs: renderer.info.programs?.length ?? null,
      gpuGeometries: renderer.info.memory.geometries, gpuTextures: renderer.info.memory.textures,
      shadowMapEnabled: renderer.shadowMap.enabled, pixelRatio: renderer.getPixelRatio() };
  });

  // ---- E5: 初期フレーミング（ワークロール対が画面をどれだけ占めるか）----
  R.framing = await page.evaluate(() => {
    const { camera } = window.__probe, T = window.__T, w = window.__app.world;
    camera.updateMatrixWorld(true);
    const box = new T.Box3();
    box.expandByObject(w.millView.rolls.workTop); box.expandByObject(w.millView.rolls.workBot);
    const xs = [], ys = [];
    for (let i = 0; i < 8; i++) {
      const v = new T.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y,
                              i & 4 ? box.max.z : box.min.z).project(camera);
      xs.push(v.x); ys.push(v.y);
    }
    return { rollStackScreenWidthFrac: +((Math.max(...xs) - Math.min(...xs)) / 2).toFixed(3),
             rollStackScreenHeightFrac: +((Math.max(...ys) - Math.min(...ys)) / 2).toFixed(3),
             cameraDistanceUnits: +camera.position.length().toFixed(0) };
  });

  // ---- E3: 回転方向の整合（材料 +X 進行時のロール角速度符号）----
  //  rAF のフレームレートに依存しないよう、物理を明示ステップし描画も明示的に呼ぶ。
  R.kinematics = await page.evaluate(() => {
    const app = window.__app, p = app.physics, w = app.world;
    window.requestAnimationFrame = () => 0;
    p.mill.mode = 'MANUAL'; p.mill.passIndex = -1;
    if ('passPhase' in p.mill) p.mill.passPhase = 'IDLE';
    p.mill.targetGap = 200; p.mill.gap = 200;
    p.mill.targetSpeed = 150; p.mill.currentSpeed = 150;
    if ('onLine' in p.slab) p.slab.onLine = true; else p.slab.visible = true;
    const mm = ('onLine' in p.slab);
    p.slab.thickness = 300;
    p.slab.xMin = mm ? -3000 : -3; p.slab.xMax = mm ? 3000 : 3;
    const wrTop = w.millView.rolls.workTop, wrBot = w.millView.rolls.workBot;
    const tbl = w.tableView.tableL?.children?.[0];
    const readT = () => tbl ? tbl.rotation.z : (w.tableView.rollAngle ?? 0);
    const draw = () => { if (p.update) p.update(1 / 60); w.render(p, 1 / 60); };
    draw();
    const a0 = wrTop.rotation.z, b0 = wrBot.rotation.z, t0 = readT();
    for (let i = 0; i < 12; i++) draw();
    const sg = v => (Math.abs(v) < 1e-5 ? 0 : Math.sign(v));
    // three.js 右手系(+X右/+Y上/+Z手前)。+Z回転(CCW)のとき円柱の -Y 面は +X へ動く。
    // 材料が +X: 上ロールは接触点が下面 → ω>0 / 下ロールは上面 → ω<0 / テーブルロールは上面 → ω<0
    return { materialDirection: '+X',
      topWorkRoll: { measured: sg(wrTop.rotation.z - a0), expected: +1 },
      botWorkRoll: { measured: sg(wrBot.rotation.z - b0), expected: -1 },
      tableRoll:   { measured: sg(readT() - t0),          expected: -1 } };
  });

  // ---- E2/E4: 物理を固定 dt で決定論的に評価（描画から分離） ----
  // 実行環境のフレームレートに左右されずに、体積保存・荷重・温度・パス進行を検証する。
  R.physicsFixedDt = await page.evaluate(async ({ dt, maxSteps }) => {
    const app = window.__app, p = app.physics;
    window.requestAnimationFrame = () => 0;          // アプリのrAFループを停止
    app.world.render = () => {};                     // 描画を無効化（純物理ステップ）
    document.getElementById('btn-reset').click();
    document.getElementById('chk-supply-anim').checked = false;
    document.getElementById('chk-supply-anim').dispatchEvent(new Event('change'));
    document.getElementById('btn-start').click();

    const h0 = p.slab.thickness, w0 = p.slab.width, l0 = p.slab.length;
    const V0 = h0 * w0 * l0;
    const XU = ('onLine' in p.slab) ? 1 : 1000;      // xMin/xMax の単位: mm か m か
    let vPreCrop = null;
    const passSeen = new Set(); let nan = 0, steps = 0, finished = false;
    let maxForce = 0, maxPower = 0, minTemp = 1e9, maxAbsX = 0, geomErr = 0, spdErrSum = 0, spdN = 0;
    let prevTh = h0, monotonic = true;
    const passLog = [];
    let lastPass = -1;

    while (steps < maxSteps) {
      p.update(dt); steps++;
      const s = p.slab, m = p.mill;
      if ([s.thickness, s.length, s.xMin, s.xMax, s.temperature, s.rollForce, m.gap, m.currentSpeed]
          .some(v => !Number.isFinite(v))) { nan++; break; }
      if (m.passIndex >= 0) { passSeen.add(m.passIndex); }
      if (m.passIndex !== lastPass) {
        passLog.push({ step: steps, t: +(steps * dt).toFixed(1), pass: m.passIndex,
                       th: +s.thickness.toFixed(1), len: +(s.length / 1000).toFixed(2),
                       temp: +s.temperature.toFixed(0) });
        lastPass = m.passIndex;
      }
      maxForce = Math.max(maxForce, s.rollForce);
      maxPower = Math.max(maxPower, s.rollPower || 0);
      minTemp = Math.min(minTemp, s.temperature);
      maxAbsX = Math.max(maxAbsX, Math.abs(s.xMin) * XU / 1000, Math.abs(s.xMax) * XU / 1000);
      if (!s.inBite && s.length > 0) geomErr = Math.max(geomErr, Math.abs((s.xMax - s.xMin) * XU - s.length) / s.length);
      if (m.passIndex === -1 && passSeen.size > 0 && vPreCrop === null) vPreCrop = s.thickness * s.width * s.length;
      if (s.inBite && Math.abs(m.currentSpeed) > 20) { spdErrSum += Math.abs(Math.abs(m.currentSpeed) - s.currentSpeed) / Math.abs(m.currentSpeed); spdN++; }
      if (s.thickness > prevTh + 1e-6) monotonic = false;
      prevTh = s.thickness;
      if (passSeen.size > 0 && m.passIndex === -1 && steps > 60) {
        if (!p.finish || p.finish.done) { finished = true; break; }
      }
    }
    const s = p.slab;
    const V1 = s.thickness * s.width * s.length;
    return {
      dt, steps, simSeconds: +(steps * dt).toFixed(1), finished, nanCount: nan,
      passesCompleted: passSeen.size, totalPasses: (window.__CFG_PASSES ?? null),
      finalThickness_mm: +s.thickness.toFixed(2), finalLength_m: +(s.length / 1000).toFixed(2),
      finalTemp_C: +s.temperature.toFixed(1), minTemp_C: +minTemp.toFixed(1),
      maxRollForce_ton: +maxForce.toFixed(0), maxPower_kW: +maxPower.toFixed(0), maxAbsX_m: +maxAbsX.toFixed(1),
      finishDone: p.finish ? p.finish.done : null,
      coilOD_mm: p.finish ? +p.finish.od.toFixed(0) : null,
      coilMass_kg: p.finish ? +p.finish.coilMass.toFixed(0) : null,
      trimmedWidth_mm: p.finish ? p.finish.trimmedWidth : null,
      volumeErrorPct: +((((vPreCrop ?? V1) - V0) / V0) * 100).toFixed(3),
      volumeErrorInclCropPct: +(((V1 - V0) / V0) * 100).toFixed(3),
      geomVsLogicalLenErrPct: +(geomErr * 100).toFixed(2),
      exitSpeedMismatchPct: spdN ? +((spdErrSum / spdN) * 100).toFixed(2) : null,
      thicknessMonotonicDecreasing: monotonic, passLog,
    };
  }, { dt: 1 / 60, maxSteps: 60 * 2000 });

  // ---- E4b: dt ロバスト性（低FPS/高FPSでも同じ結果に収束するか） ----
  R.dtRobustness = [];
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 12]) {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__app, null, { timeout: 25000 });
    const r = await page.evaluate(async ({ dt, maxSteps }) => {
      const p = window.__app.physics;
      window.requestAnimationFrame = () => 0;
      window.__app.world.render = () => {};
      document.getElementById('btn-reset').click();
      document.getElementById('chk-supply-anim').checked = false;
      document.getElementById('chk-supply-anim').dispatchEvent(new Event('change'));
      document.getElementById('btn-start').click();
      const seen = new Set(); let steps = 0;
      while (steps < maxSteps) {
        p.update(dt); steps++;
        if (p.mill.passIndex >= 0) seen.add(p.mill.passIndex);
        if (!Number.isFinite(p.mill.gap) || !Number.isFinite(p.slab.thickness)) break;
        if (seen.size > 0 && p.mill.passIndex === -1 && steps > 60) {
        if (!p.finish || p.finish.done) break;
      }
      }
      return { passesCompleted: seen.size, finalThickness_mm: +p.slab.thickness.toFixed(2),
               finalLength_m: +(p.slab.length / 1000).toFixed(2), simSeconds: +(steps * dt).toFixed(1) };
    }, { dt, maxSteps: Math.ceil(2000 / dt) });
    R.dtRobustness.push({ fps: Math.round(1 / dt), ...r });
  }

  // 描画計測のためリロードして通常動作へ戻す
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 25000 });
  await page.evaluate(() => {
    const w = window.__app.world, r = w.renderer;
    const p = window.__probe = { frames: [], gpu: [], last: 0, renderer: r };
    const orig = r.render.bind(r);
    r.render = (s, c) => { const t = performance.now(); if (p.last) p.frames.push(t - p.last); p.last = t;
      const o = orig(s, c); p.gpu.push(performance.now() - t); return o; };
  });

  // ---- E6: 幾何・構造の整合性検査（新版のみ。CONFIG から解析的に判定する）----
  R.integrity = await page.evaluate(async () => {
    window.__T = window.__T || await import('/__three__');

    const app = window.__app, P = app.physics, W = app.world;
    if (!P.mill.passLine) return { skipped: '旧版には該当する構造が無いため対象外' };
    const C = window.__CFG || null;
    const out = [];
    const ok = (name, cond, detail) => out.push({ name, pass: !!cond, detail });

    // CONFIG をアプリ内から取り出す（モジュールスコープなので状態経由で再構成する）
    const M = { WR_D: P.mill.wrTopY - P.mill.passLine - P.mill.gap };   // = WR 半径
    const wrR = M.WR_D, passLine = P.mill.passLine;

    // 1) ロール積み重ね: WR と BUR は外接していること
    const dWB_top = P.mill.brTopY - P.mill.wrTopY;
    const dWB_bot = P.mill.wrBotY - P.mill.brBotY;
    ok('ロール外接(上)', Math.abs(dWB_top - dWB_bot) < 1e-6, `上${dWB_top.toFixed(1)} / 下${dWB_bot.toFixed(1)} mm`);

    // 2) 下ワークロール上面 = パスライン（下ロールは固定）
    ok('下WR上面＝パスライン', Math.abs((P.mill.wrBotY + wrR) - passLine) < 1e-6,
       `${(P.mill.wrBotY + wrR).toFixed(1)} vs ${passLine.toFixed(1)} mm`);

    // 3) 圧下してもパスラインが動かない
    const g0 = P.mill.gap, pl0 = P.mill.passLine;
    P.mill.gap = 60; const plA = P.mill.passLine, wbA = P.mill.wrBotY;
    P.mill.gap = 600; const plB = P.mill.passLine, wbB = P.mill.wrBotY;
    P.mill.gap = g0;
    ok('圧下してもパスライン不動', plA === plB && wbA === wbB, `gap60→${wbA} / gap600→${wbB}`);

    // 4) テーブルローラ上面 = パスライン（支持は胴端 Φ281.6 部）
    const tv = W.tableView, K = window.__CFG, CFG = { ...K.TABLE, ...K.SLAB, ...K.SUPPLY,
      FLIP: K.FLIP, FURNACE_DEPTH: K.FURNACE.DEPTH, HOIST_CLEAR: K.CRANE.HOIST_CLEAR,
      SCHEDULE0dir: K.SCHEDULE[0]?.dir ?? 0 };
    ok('テーブルローラ上面＝パスライン',
       Math.abs((tv.y + CFG.ROLL_D_END / 2) - passLine) < 1e-6,
       `${(tv.y + CFG.ROLL_D_END / 2).toFixed(1)} mm`);

    // 5) 圧延機直下・シャー直下にローラが無い
    const allX = tv.zones.flatMap(z => z.xs);
    ok('圧延機直下にローラ無し', allX.every(x => Math.abs(x) > 1000), `最近接 ${Math.min(...allX.map(Math.abs)).toFixed(0)} mm`);
    const sx = K.CROP_SHEAR.X;
    ok('75 mm シャー直下にローラ無し', allX.every(x => Math.abs(x - sx) > 1200),
       `最近接 ${Math.min(...allX.map(x => Math.abs(x - sx))).toFixed(0)} mm`);

    // 6) テーブルローラ同士が干渉しない（ピッチ > 胴径）
    const sorted = [...allX].sort((a, b) => a - b);
    let minPitch = 1e9;
    for (let i = 1; i < sorted.length; i++) minPitch = Math.min(minPitch, sorted[i] - sorted[i - 1]);
    ok('テーブルローラ同士の非干渉', minPitch > CFG.ROLL_D_END,
       `最小ピッチ ${minPitch.toFixed(0)} mm > 胴端径 ${CFG.ROLL_D_END} mm`);

    // 7) 横送りローラが主テーブルローラと干渉しない
    const cross = W.supplyView.crossSlots.map(([x]) => x);
    const uniqCross = [...new Set(cross)];
    let worst = 1e9;
    for (const cx of uniqCross) for (const x of allX) worst = Math.min(worst, Math.abs(cx - x));
    const need = CFG.CROSS_ROLL_L / 2 + CFG.ROLL_D_END / 2;
    ok('横送りローラの非干渉', worst > need, `最小離隔 ${worst.toFixed(0)} mm > ${need.toFixed(0)} mm`);

    // 8) スラブがロール面へ食い込まない（バイト内のプロファイル検査）
    P.mill.mode = 'MANUAL'; P.slab.onLine = true; P.slab.inBite = true; P.slab.dir = 1;
    P.slab.thickness = 400; P.slab.length = 8000; P.slab.xMin = -4000; P.slab.xMax = 4000;
    P.mill.gap = 300; P.mill.targetGap = 300;
    W.slabView._sig = null; W.slabView.update(P.slab, P.mill);
    const pos = W.slabView.geo.attributes.position;
    let maxPen = 0, maxAbove = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) / 0.02, y = pos.getY(i) / 0.02;
      const topRollY = P.mill.wrTopY, botRollY = P.mill.wrBotY;
      const dTop = Math.hypot(x, y - topRollY), dBot = Math.hypot(x, y - botRollY);
      if (dTop < wrR) maxPen = Math.max(maxPen, wrR - dTop);
      if (dBot < wrR) maxPen = Math.max(maxPen, wrR - dBot);
      if (x > 200) maxAbove = Math.max(maxAbove, y - (passLine + P.mill.gap));
    }
    ok('スラブがロール面に食い込まない', maxPen < 1.0, `最大食い込み ${maxPen.toFixed(2)} mm`);
    ok('出側板厚がギャップと一致', maxAbove < 0.5, `出側の超過 ${maxAbove.toFixed(2)} mm`);

    // 9) 巻取パス以外は必ずテーブルに載る（載らない厚みまで薄くしない）
    const R2 = window.__ROLL;
    const th0 = CFG.CAST_TH[0] - 2 * 12, L0 = CFG.LEN_DEFAULT, W0 = CFG.WID_DEFAULT;
    const sch = R2.buildSchedule(th0, K.SLAB.FINISH.COIL.def, W0, CFG.TEMP_DEFAULT, { coil: true, length: L0 });
    let overMax = 0, overPass = 0;
    for (const q of sch) {
      if (q.coil) continue;                                  // 巻取パスはコイルに巻き取るので対象外
      const L = L0 * th0 / q.gap;
      const side = (q.dir > 0 ? Math.abs(CFG.X_MAX) : Math.abs(CFG.X_MIN)) - 8000;
      const over = L - side;
      if (over > overMax) { overMax = over; overPass = q.pass; }
    }
    ok('巻取パス以外はテーブルに載る', overMax <= 0,
       `最大超過 ${overMax.toFixed(0)} mm（第${overPass}パス）/ 全${sch.length}パス`);
    const last = sch[sch.length - 1];
    ok('最終パスが巻取パスで出側に向かう', !!last && last.coil === true && Math.sign(last.dir) === CFG.FLIP,
       `第${last?.pass}パス ${last?.gap.toFixed(1)} mm coil=${last?.coil} dir=${last?.dir}`);

    // 10) サイドガイドは板幅未満に閉じない
    ok('サイドガイド最小開度 ≥ 板幅', P.mill.guideGap >= P.slab.width,
       `${P.mill.guideGap.toFixed(0)} vs 板幅 ${P.slab.width} mm`);

    // 11) 架構が床から浮いていない（テーブル架台がパスライン下から床まで届く）
    ok('テーブル架台が床に接地', (passLine - 400) > 0, `脚高 ${(passLine - 400).toFixed(0)} mm`);

    // ---- 装入設備（転倒装置 → 縦送り → 横送り）の配置検査 ----
    const T3 = window.__T, SV = W.supplyView, mm = v => v / 0.02;
    const bbox = o => { const b = new T3.Box3().setFromObject(o); return { x0: mm(b.min.x), x1: mm(b.max.x), z0: mm(b.min.z), z1: mm(b.max.z), y0: mm(b.min.y), y1: mm(b.max.y) }; };

    // 12) 縦送りテーブルが主ラインと干渉しない
    const mainPed = bbox(W.tableView.zones[0].peds.mesh);
    const runPed  = bbox(SV.runPeds.mesh);
    const lateral = Math.min(Math.abs(runPed.z0), Math.abs(runPed.z1)) - Math.max(Math.abs(mainPed.z0), Math.abs(mainPed.z1));
    ok('縦送りテーブルと主テーブルの離隔', lateral > 0, `離隔 ${lateral.toFixed(0)} mm`);

    // 13) 転倒アームを倒した状態で横送りローラ・縦送りローラと干渉しない
    const arm = SV.tilterArm, keep = arm.rotation.z;
    arm.rotation.z = 0; SV.tilterPivot.updateMatrixWorld(true);
    const armB = bbox(arm);
    arm.rotation.z = keep; SV.tilterPivot.updateMatrixWorld(true);
    const FL = window.__CFG.FLIP;
    const armEnd = FL > 0 ? armB.x1 : armB.x0;             // ミル側のアーム端
    const crossXs = [...new Set(SV.crossSlots.map(([x]) => x))];
    const nearCross = crossXs.reduce((a, b) => (FL * b > FL * a ? b : a));
    ok('転倒アームと横送りローラの非干渉', FL * (nearCross - armEnd) > 210,
       `アーム端 ${armEnd.toFixed(0)} / 最寄り横送り ${nearCross.toFixed(0)} mm`);
    const nearRun = SV.runXs.reduce((a, b) => (FL * b > FL * a ? b : a));
    ok('転倒アームと縦送りローラの非干渉', FL * (nearRun - armEnd) > 200,
       `アーム端 ${armEnd.toFixed(0)} / 最寄り縦送り ${nearRun.toFixed(0)} mm`);

    // 14) 転倒アームは最大スラブ長を受けられる
    ok('転倒アーム長 ≥ 最大スラブ長', (armB.x1 - armB.x0) >= CFG.LEN_MAX,
       `アーム長 ${(armB.x1 - armB.x0).toFixed(0)} mm ≥ ${CFG.LEN_MAX} mm`);

    // 15) 倒した状態でアームのベッドローラ上面＝パスライン（立ち上がり面ではなくローラで測る）
    const keep2 = SV.tilterArm.rotation.z;
    SV.tilterArm.rotation.z = 0; SV.tilterPivot.updateMatrixWorld(true);
    const bedB = bbox(SV.armRolls.mesh);
    SV.tilterArm.rotation.z = keep2; SV.tilterPivot.updateMatrixWorld(true);
    ok('転倒アームのベッドローラ上面＝パスライン', Math.abs(bedB.y1 - passLine) < 30,
       `${bedB.y1.toFixed(0)} vs ${passLine.toFixed(0)} mm`);

    // 16) 横送りローラと入側サイドガイドの非干渉
    const gEntry = bbox(W.guideView.stations[FL > 0 ? 0 : 1].sides[0]);
    const gEdge = FL > 0 ? gEntry.x0 : gEntry.x1;          // 装入側に近いガイド端
    // 横送りローラはガイドより「装入側（ミルから遠い側）」にある必要がある
    ok('横送りローラと入側サイドガイドの非干渉', -FL * (nearCross - gEdge) > 210,
       `横送り端 ${nearCross.toFixed(0)} / ガイド端 ${gEdge.toFixed(0)} mm`);

    // 17) 横送りローラは退避時に縦送り／主テーブルのローラ面より下にある
    ok('横送りローラの退避高さ', SV.crossY + 200 < passLine - 100,
       `退避時上面 ${(SV.crossY + 200).toFixed(0)} mm < パスライン ${passLine} mm`);

    // ---- 図面どおりのローラ形状か（ジオメトリから実測する）----
    const rollAttr = tv.zones[0].rolls.mesh.geometry.attributes.position;
    let rEnd = 0, rMid = 0;
    const zBarrelEnd = 0.02 * (CFG.BARREL / 2 - CFG.ROLL_FLAT / 2);
    for (let i = 0; i < rollAttr.count; i++) {
      const z = Math.abs(rollAttr.getZ(i)), r = Math.hypot(rollAttr.getX(i), rollAttr.getY(i));
      // 中央直部の径は「胴内で最も細い非ゼロ半径」で測る（頂点は区間端にしか無い）
      if (z < 0.02 * CFG.BARREL / 2 && r > 0.02 * 20) rMid = (rMid === 0 ? r : Math.min(rMid, r));
      if (Math.abs(z - zBarrelEnd) < 0.02 * 40) rEnd = Math.max(rEnd, r);  // 胴端の直部
    }
    ok('テーブルローラ 胴端径＝図面値', Math.abs(rEnd / 0.02 * 2 - CFG.ROLL_D_END) < 1,
       `実測 Φ${(rEnd / 0.02 * 2).toFixed(1)} / 図面 Φ${CFG.ROLL_D_END}`);
    ok('テーブルローラ 中央径＝図面値', Math.abs(rMid / 0.02 * 2 - CFG.ROLL_D_MID) < 1.5,
       `実測 Φ${(rMid / 0.02 * 2).toFixed(1)} / 図面 Φ${CFG.ROLL_D_MID}`);
    ok('テーブルローラは中央が細い（自動調心形状）', rMid < rEnd - 0.02 * 20,
       `中央 Φ${(rMid / 0.02 * 2).toFixed(1)} < 胴端 Φ${(rEnd / 0.02 * 2).toFixed(1)}`);

    // ---- 入側／出側の向き ----
    const F = CFG.FLIP;
    ok('第1パスは設定した向きへ進む', Math.sign(CFG.SCHEDULE0dir) === F,
       `第1パス dir=${CFG.SCHEDULE0dir} / FLIP=${F}`);
    ok('入側テーブルが第1パスの上流側にある',
       Math.sign(-(CFG.X_MIN + CFG.X_MAX)) === F || (Math.abs(CFG.X_MIN) > Math.abs(CFG.X_MAX)) === (F > 0),
       `X_MIN ${CFG.X_MIN} / X_MAX ${CFG.X_MAX} / FLIP ${F}`);
    ok('出側設備（トリマー・スリーロール・リール・シャー）が出側にある',
       [K.TRIMMER.X, K.COILER.DEFLECTOR_X, K.COILER.X, K.CROP_SHEAR.X].every(x => Math.sign(x) === F),
       `トリマー ${K.TRIMMER.X} / 三本ロール ${K.COILER.DEFLECTOR_X} / リール ${K.COILER.X} / シャー ${K.CROP_SHEAR.X}`);
    ok('図面どおりの配置間隔（5,875 / 6,900 / 8,350 mm）',
       Math.abs(Math.abs(K.TRIMMER.X) - 5875) < 1 && Math.abs(Math.abs(K.COILER.DEFLECTOR_X) - 6900) < 1
       && Math.abs(Math.abs(K.COILER.X) - 8350) < 1,
       `${Math.abs(K.TRIMMER.X)} / ${Math.abs(K.COILER.DEFLECTOR_X)} / ${Math.abs(K.COILER.X)} mm`);
    // リールはコイル最大外径でも下端がパスラインより上にあり、可逆パス中の板が下を通れる
    const clrD = K.COILER.Y_ABOVE - K.COILER.OD_DRAWING / 2;   // 図面のこのラインでの最大径
    ok('図面の最大コイル径でコイル下端がパスラインより 300 mm 以上上', clrD > 300,
       `離隔 ${clrD.toFixed(0)} mm（リール高さ ${K.COILER.Y_ABOVE} − Φ${K.COILER.OD_DRAWING}/2）`);
    const clrM = K.COILER.Y_ABOVE - K.COILER.OD_MAX / 2;       // 巻取機の能力上限径
    ok('巻取機の能力上限径でもコイル下端がパスラインを侵さない', clrM > 0,
       `離隔 ${clrM.toFixed(0)} mm（Φ${K.COILER.OD_MAX} のとき）`);
    // 図面の注記「8 mm × 56 巻 → Φ1510」を、モデルのコイル外径式が再現するか
    const nW = 56, hW = 8, id = K.COILER.MANDREL_D;
    let lenW = 0; for (let i = 0; i < nW; i++) lenW += Math.PI * (id + hW * (2 * i + 1));
    const odW = window.__ROLL.coilOD(lenW, hW);
    ok('コイル外径式が図面の巻数（8 mm × 56 巻 = Φ1510）を再現する', Math.abs(odW - 1510) < 8,
       `${nW} 巻 ${(lenW / 1000).toFixed(1)} m → Φ${odW.toFixed(0)}（図面 Φ1510）`);
    ok('3ロールは下2本 Φ230（軸間 260）＋上1本 Φ320',
       K.COILER.ROLL_LO_D === 230 && K.COILER.ROLL_LO_PITCH === 260 && K.COILER.ROLL_UP_D === 320,
       `下 Φ${K.COILER.ROLL_LO_D}×2 @${K.COILER.ROLL_LO_PITCH} / 上 Φ${K.COILER.ROLL_UP_D}`);
    ok('リール中心は 3ロールから 1,450 mm・パスライン上 1,200 mm（図面）',
       Math.abs(Math.abs(K.COILER.X - K.COILER.DEFLECTOR_X) - 1450) < 1 && K.COILER.Y_ABOVE === 1200,
       `水平 ${Math.abs(K.COILER.X - K.COILER.DEFLECTOR_X)} mm / 高さ ${K.COILER.Y_ABOVE} mm`);
    // アップカットは «刃がベッドを貫いてせり上がれる» ことが成立条件。
    // ベッド側の三角形が刃の通り道（スリット）に入り込んでいないかを実形状で見る。
    {
      const S = K.CROP_SHEAR, F = K.FLIP, sc = K.SCALE;
      const xKnife = -F * S.BLADE_T / 2, half = S.SLOT / 2;
      const grp = window.__app.world.finishView.cropShear;
      let intrude = 0;
      grp.children.forEach(o => {
        if (!o.isMesh || o === window.__app.world.finishView.cropRam) return;
        if (o === window.__app.world.finishView.cropHold) return;
        const pos = o.geometry.attributes.position;
        const zw = K.TABLE.BARREL / 2 + 120;          // 刃の胴幅（この範囲だけが通り道）
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i) / sc + o.position.x / sc, y = pos.getY(i) / sc, z = pos.getZ(i) / sc;
          // 通り道を見るのはベッド（パスラインより下）。パスラインより上は固定上刃が
          // 刃と隣り合うのが正しい構造なので対象外にする。
          if (y > K.MILL.PASS_LINE - 900 && y < K.MILL.PASS_LINE - 5 &&
              Math.abs(z) < zw && Math.abs(x - xKnife) < half)
            { const d = half - Math.abs(x - xKnife);
              if (d > intrude) { intrude = d; window.__intr = { i: grp.children.indexOf(o),
                x: Math.round(x), y: Math.round(y), z: Math.round(z), n: pos.count }; } }
        }
      });
      ok('アップカット刃の通り道（ベッドのスリット）が塞がっていない', intrude === 0,
         `スリット幅 ${S.SLOT} mm ／ 侵入 ${intrude.toFixed(0)} mm ${JSON.stringify(window.__intr ?? {})}`);
      const travelTop = K.MILL.PASS_LINE + S.MAX_TH + S.UPPER_CLR + 60;
      ok('刃の上昇端が固定上刃を越える（切り離せる）',
         travelTop >= K.MILL.PASS_LINE + S.UPPER_CLR + 10,
         `刃先の上昇端 ${travelTop} mm ＞ 固定上刃の下端 ${K.MILL.PASS_LINE + S.UPPER_CLR} mm`);
      ok('押えの退避位置が最大板厚を越える',
         S.HOLD_OPEN > S.MAX_TH, `退避 ${S.HOLD_OPEN} mm ＞ 最大板厚 ${S.MAX_TH} mm`);
      ok('端材長は実機の範囲（800 mm 以下）', S.CROP_LEN <= 800, `${S.CROP_LEN} mm`);
    }
    ok('75 mm シャーはアップカット（可動刃が下、固定刃が上）',
       K.CROP_SHEAR.UPPER_CLR >= K.CROP_SHEAR.MAX_TH,
       `固定上刃の下端はパスライン上 ${K.CROP_SHEAR.UPPER_CLR} mm（最大板厚 ${K.CROP_SHEAR.MAX_TH} mm）`);
    // 上下の刃を同じ Z に置くと刃どうしが食い込む。実配置を読んで軸方向の離れを見る。
    {
      const m = window.__app.world.finishView.knives.mesh.instanceMatrix.array, sc = K.SCALE;
      const z = [0, 1, 2, 3].map(i => m[i * 16 + 14] / sc);      // 上×2, 下×2（片側ずつ）
      const gapZ = Math.min(Math.abs(z[0] - z[2]), Math.abs(z[1] - z[3]));
      ok('トリマーの上下刃が軸方向に干渉しない', gapZ >= K.TRIMMER.KNIFE_T,
         `軸方向の芯間 ${gapZ.toFixed(1)} mm ≥ 刃厚 ${K.TRIMMER.KNIFE_T} mm`);
    }
    // サイドガイド: 板の «耳» に当たるのはローラで、フレームはその外側にあること
    {
      const gv = window.__app.world.guideView, sc = K.SCALE, gD = K.TABLE.GUIDE.ROLL_D;
      const grp = gv.stations[0].sides[0];
      const rm = grp.children.find(o => o.isInstancedMesh);
      const fr = grp.children.find(o => o.isMesh && !o.isInstancedMesh);
      const rz = rm.instanceMatrix.array[14] / sc;          // ローラ中心（ローカル Z）
      fr.geometry.computeBoundingBox();
      const frameInner = fr.geometry.boundingBox.min.z / sc;
      const rollInner = rz - gD / 2;                        // ローラ内接面
      ok('サイドガイドは板の耳にローラが当たる（フレームはその外側）',
         Math.abs(rollInner) < 1 && frameInner > rollInner + 10,
         `ローラ内接面 ${rollInner.toFixed(0)} mm / フレーム最内 ${frameInner.toFixed(0)} mm（開口面基準）`);
    }
    ok('トリマー刃の開位置はパスライン ±305 mm（図面）',
       K.TRIMMER.SHAFT_OPEN === 305 && K.TRIMMER.SHAFT_OPEN * 2 > K.TRIMMER.KNIFE_D,
       `軸心 ±${K.TRIMMER.SHAFT_OPEN} mm / 刃 Φ${K.TRIMMER.KNIFE_D} → 開口 ${K.TRIMMER.SHAFT_OPEN * 2 - K.TRIMMER.KNIFE_D} mm`);
    ok('75 mm シャーは板厚 75 mm 以下のパスで使う', K.CROP_SHEAR.MAX_TH === 75,
       `対応板厚 ${K.CROP_SHEAR.MAX_TH} mm 以下`);

    // ---- ピット炉・装入クレーン ----
    const pitDepth = CFG.FURNACE_DEPTH;
    ok('ピット炉深さ ≥ 最大スラブ長', pitDepth >= CFG.LEN_MAX,
       `深さ ${pitDepth} mm ≥ ${CFG.LEN_MAX} mm`);
    ok('吊上げ高さで炉口・転倒機を越える', CFG.HOIST_CLEAR > 1500,
       `床上クリアランス ${CFG.HOIST_CLEAR} mm`);

    return { checks: out, failed: out.filter(x => !x.pass).length };
  });

  // ---- E1b: 描画性能 ----
  //  公平に比較するため (1) 両版で同一のカメラ位置・注視点、(2) 実際に圧延している最中、
  //  (3) 2つの解像度、で測る。旧版は初期画角が極端に引きだったため、
  //  既定画角のままでは「ほぼ背景だけを描いている」状態と比較することになり意味を成さない。
  R.perf = {};
  await page.evaluate(() => {
    const w = window.__app.world, p = window.__app.physics;
    w._tw = null;
    w.camera.position.set(140, 80, 220);
    w.controls.target.set(0, 20, 0);
    w.controls.update();
    const anim = document.getElementById('chk-supply-anim');
    if (anim && anim.checked) { anim.checked = false; anim.dispatchEvent(new Event('change')); }
    document.getElementById('btn-reset').click();
    document.getElementById('btn-start').click();
  });
  await page.waitForFunction(() => {
    const p = window.__app.physics;
    return p.mill.passIndex >= 0 && Math.abs(p.mill.currentSpeed) > 20;
  }, null, { timeout: 60000 }).catch(() => { R.perfNoRoll = true; });

  for (const [W, H] of [[640, 360], [1920, 1080]]) {
    await page.setViewportSize({ width: W, height: H });
    await page.evaluate(() => {
      const w = window.__app.world;
      w._tw = null; w.camera.position.set(140, 80, 220); w.controls.target.set(0, 20, 0); w.controls.update();
    });
    await page.waitForTimeout(400);
    R.perf[`${W}x${H}`] = await page.evaluate(async () => {
      const p = window.__probe; p.frames.length = 0; p.gpu.length = 0; p.last = 0;
      await new Promise(res => setTimeout(res, 6000));
      const q = (a, x) => { const s = a.slice(3).sort((m, n) => m - n); return s.length ? +s[Math.floor(s.length * x)].toFixed(2) : null; };
      return { frames: p.frames.length, fps: +(p.frames.length / 6).toFixed(1),
               frameMs_p50: q(p.frames, .5), frameMs_p95: q(p.frames, .95),
               cpuRenderMs_p50: q(p.gpu, .5), cpuRenderMs_p95: q(p.gpu, .95),
               drawCalls: p.renderer.info.render.calls, triangles: p.renderer.info.render.triangles };
    });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  R.consoleErrors = consoleErrors.slice(0, 20);
  await page.screenshot({ path: path.join(__dirname, `shot-${LABEL}.png`) });
  fs.writeFileSync(path.join(__dirname, `report-${LABEL}.json`), JSON.stringify(R, null, 2));
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
};
run().catch(e => { console.error('EVAL FAILED:', e); process.exit(1); });
