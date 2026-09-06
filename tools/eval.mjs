/**
 * HotMill 評価ハーネス
 * 目的: 「描画コスト / 物理整合 / 幾何整合 / 数値健全性 / 初期フレーミング」を数値で判定する。
 * 外部CDNへ到達できない環境のため three.js はローカルへルーティングする。
 * index.html 自体は `new App()` を window に露出する1行だけの改変で評価する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openApp, __dirname, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const LABEL = process.argv[3] || 'baseline';

const run = async () => {
  const { browser, page, errors: consoleErrors } = await openApp({ target: TARGET, viewport: { width: 1920, height: 1080 }, quiet: true });

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

    // 5) ワークロール・シャーの刃に当たる位置にローラが無い
    // E-1 / E-2（ミル直近の Φ380）はミル直下 1 m まで入るので «|x| > 1,000» では見ない。
    // 見るべきはワークロール外周との軸間距離（下ワークロールは軸心がパスライン − WR/2）。
    const allX = tv.xs;                                  // E-1 / E-2 を含む «段» の X
    {
      const ER = K.TABLE.EROLL, rWR = K.MILL.WR_D / 2, P0 = K.MILL.PASS_LINE;
      const worst = Math.min(...allX.map(x => {
        const near = Math.abs(x) < 3000 ? K.TABLE.EROLL : null;   // ミル直近は E ロール、それ以外は主ローラ
        const r = near ? ER.D_END / 2 : K.TABLE.ROLL_D_END / 2;
        const ay = P0 - r, wy = P0 - rWR;                          // ローラ軸心 / 下ワークロール軸心
        return Math.hypot(x, ay - wy) - (rWR + r);                 // 外周どうしの隙間
      }));
      ok('テーブルローラがワークロールに当たらない', worst > 0, `最小の隙間 ${worst.toFixed(0)} mm`);
    }
    const sx = K.CROP_SHEAR.X, SZ = K.CROP_SHEAR.ZONE;
    // 図面のシャー区間（29.8〜31.4 m）の «内側» にローラが入っていないか。区間の境界に
    // ローラが載る区分（H-1 は区間長 = ピッチの合計）があるので、境界そのものは許す。
    ok('75 mm シャー区間（29.8〜31.4 m）の内側にローラ無し',
       allX.filter(x => x * sx > 0).every(x => Math.abs(x) <= SZ[0] + 1 || Math.abs(x) >= SZ[1] - 1),
       `最近接 ${Math.min(...allX.map(x => Math.abs(x - sx))).toFixed(0)} mm（刃から）`);
    // 図面のテーブル区分どおりの本数か（E-1 / E-2 は 1 段 OS/DS の 2 本なので «段数» で見る）
    {
      const SEC = K.TABLE.SECTIONS, Lay = window.__LAYOUT, bad = [];
      for (const s of SEC) {
        const gen = Lay.section(s).xs, want = Lay.stages(s);
        const n = allX.filter(x => gen.some(g => Math.abs(g - x) < 1)).length;
        if (n !== want) bad.push(`${s.name}:${n}/${want}`);
      }
      const stages = SEC.reduce((a, s) => a + Lay.stages(s), 0);
      ok('図面のテーブル区分どおりの段数（全 ' + stages + ' 段 / ' + SEC.reduce((a, s) => a + s.n, 0) + ' 本）',
         bad.length === 0 && allX.length === stages, bad.join(' ') || `${allX.length} 段`);
    }

    // 6) テーブルローラ同士が干渉しない（ピッチ > 胴径）
    const sorted = [...allX].sort((a, b) => a - b);
    let minPitch = 1e9;
    for (let i = 1; i < sorted.length; i++) minPitch = Math.min(minPitch, sorted[i] - sorted[i - 1]);
    ok('テーブルローラ同士の非干渉', minPitch > CFG.ROLL_D_END,
       `最小ピッチ ${minPitch.toFixed(0)} mm > 胴端径 ${CFG.ROLL_D_END} mm`);

    // 7) トランスファークレーンが降ろす位置（倒したスラブの真横）が入側テーブル A-9 の上にある
    {
      const L = window.__app.physics.slab.length, xc = K.SUPPLY.TILTER_X + K.FLIP * L / 2;
      const a9 = K.TABLE.SECTIONS.find(s => s.name === 'A-9'), lo = Math.min(a9.side * a9.x0, a9.side * a9.x1), hi = Math.max(a9.side * a9.x0, a9.side * a9.x1);
      ok('降ろし位置（倒したスラブの真横）が A-9 テーブルの上', xc - L / 2 >= lo && xc + L / 2 <= hi, `スラブ ${(xc - L / 2).toFixed(0)}〜${(xc + L / 2).toFixed(0)} / A-9 ${lo}〜${hi}`);
      const under = allX.filter(x => x > xc - L / 2 && x < xc + L / 2).length;
      ok('降ろしたスラブが 3 本以上のローラに載る', under >= 3, `${under} 本`);
    }

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
    const sch = R2.buildSchedule(th0, K.SLAB.FINISH.DEFAULT, W0, CFG.TEMP_DEFAULT, { coil: true, length: L0 });
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

    // 12) 転倒機（ベッド）が主テーブル架台の側方にあり、重ならない
    const mainPed = bbox(W.tableView.zones[0].peds.mesh);
    const arm = SV.tilterArm, keep = arm.rotation.z;
    arm.rotation.z = 0; SV.tilterPivot.updateMatrixWorld(true);
    const armB = bbox(arm);
    arm.rotation.z = keep; SV.tilterPivot.updateMatrixWorld(true);
    const lateral = Math.min(Math.abs(armB.z0), Math.abs(armB.z1)) - Math.max(Math.abs(mainPed.z0), Math.abs(mainPed.z1));
    ok('転倒機ベッドと主テーブル架台の側方離隔', lateral > 0, `離隔 ${lateral.toFixed(0)} mm`);

    // 13) 転倒機は A-8 / A-9 / B-1 テーブルの操作側（+Z）にある（実機配置）
    const FL = window.__CFG.FLIP;
    {
      const rng = (n) => { const s = K.TABLE.SECTIONS.find(q => q.name === n); return [Math.min(s.side * s.x0, s.side * s.x1), Math.max(s.side * s.x0, s.side * s.x1)]; };
      const lo = Math.min(rng('A-8')[0], rng('B-1')[0]), hi = Math.max(rng('A-8')[1], rng('B-1')[1]);
      ok('転倒機が A-8〜B-1 テーブルの範囲の操作側にある', armB.x0 >= lo && armB.x1 <= hi && armB.z0 > 0,
         `転倒アーム X ${armB.x0.toFixed(0)}〜${armB.x1.toFixed(0)}（A-8〜B-1: ${lo}〜${hi}）/ Z ${armB.z0.toFixed(0)}〜`);
    }

    // 14) 転倒アームは最大スラブ長を受けられる
    ok('転倒アーム長 ≥ 最大スラブ長', (armB.x1 - armB.x0) >= CFG.LEN_MAX,
       `アーム長 ${(armB.x1 - armB.x0).toFixed(0)} mm ≥ ${CFG.LEN_MAX} mm`);

    // 15) 転倒機ベッドと受取テーブルは «テーブルローラ» で、その上面＝パスライン
    //     （ジオメトリの胴部最高点＋インスタンスの軸心高さから実測する）
    for (const [label, rt] of [['転倒機ベッド', SV.bedRolls], ['受取テーブル', SV.runoutRolls]]) {
      const g = rt.inst.mesh.geometry.attributes.position; let top = -1e9;
      for (let i = 0; i < g.count; i++)
        if (Math.abs(g.getZ(i) / 0.02) < K.SUPPLY.ROLLER.BARREL / 2) top = Math.max(top, g.getY(i) / 0.02);
      const axisY = rt.inst.mesh.instanceMatrix.array[13] / 0.02;      // 1 本目の軸心（全数同じ高さ）
      const bedTop = (passLine - CFG.PIVOT_DROP) + axisY + top;
      ok(`${label}のローラ上面＝パスライン`, Math.abs(bedTop - passLine) < 5 && rt.xs.length >= 3,
         `上面 ${bedTop.toFixed(0)} vs ${passLine.toFixed(0)} mm / ローラ ${rt.xs.length} 本`);
    }
    // 15b) 受取テーブルは転倒アームの回転半径の外にある（起き上がるアームが当たらない）
    ok('受取テーブルが転倒アームの回転半径の外にある', SV.runoutRolls.xs[0] > CFG.ARM_L,
       `先頭ローラ ${SV.runoutRolls.xs[0].toFixed(0)} mm > アーム長 ${CFG.ARM_L} mm`);

    // 16) トランスファークレーンの吊り上げ高さは転倒機の受け面（リップ）を越える
    ok('横移動時のスラブ底面が転倒機の受け面より上', K.TRANSFER.LIFT > CFG.LIP_H + 100,
       `吊り上げ ${K.TRANSFER.LIFT} mm > 受け面 ${CFG.LIP_H} mm`);

    // 17) トング（図面: 最大巾 W_MAX）の成立条件
    {
      const TG = K.TRANSFER.TONG, railIn = CFG.ARM_W / 2 - 80 - 80;
      ok('全開のトングが転倒アームのサイドレールの内側に収まる', TG.W_MAX / 2 < railIn,
         `トング外面 ${TG.W_MAX / 2} mm < レール内面 ${railIn} mm`);
      // 爪の内面（= W_MAX/2 − JAW_T）が最大幅スラブの側面より外にないと、そもそも被せられない
      ok('全開のトングが最大幅スラブを跨げる', TG.W_MAX / 2 - TG.JAW_T > CFG.WID_MAX / 2,
         `爪内面 ${TG.W_MAX / 2 - TG.JAW_T} mm > 板半幅 ${CFG.WID_MAX / 2} mm`);
      // 爪先はローラ上面より上（テーブルローラの胴に当てずに側面だけを掴む）
      ok('トングの爪先がテーブルローラの上面より上で止まる', TG.JAW_LIFT > 0 && TG.JAW_LIFT < CFG.CAST_TH[0] / 2,
         `爪先 パスライン + ${TG.JAW_LIFT} mm（最薄スラブ ${CFG.CAST_TH[0]} mm の半分未満）`);
    }
    // 18) 装入クレーンとトランスファークレーンの桁が待機時に重ならない
    {
      const dx = Math.abs(SV.girderT.position.x - SV.girder.position.x) / 0.02;
      ok('2 台のクレーンの桁が待機時に重ならない', dx > 760 + CFG.LEN_MAX / 2, `桁間 ${dx.toFixed(0)} mm`);
    }

    // ---- 図面どおりのローラ形状か（ジオメトリから実測する）----
    const rollAttr = tv.zones[0].rolls.mesh.geometry.attributes.position, TB = K.TABLE;
    let rEnd = 0, rMid = 0;
    // 胴端の直部（胴端から ROLL_FLAT の範囲。カラーは胴端の外なので除く）と中央直部（±ROLL_MID/2）を頂点の Z で選ぶ
    const zEnd0 = 0.02 * (TB.BARREL / 2 - TB.ROLL_FLAT) - 0.02, zEnd1 = 0.02 * TB.BARREL / 2 - 0.02;
    for (let i = 0; i < rollAttr.count; i++) {
      const z = Math.abs(rollAttr.getZ(i)), r = Math.hypot(rollAttr.getX(i), rollAttr.getY(i));
      if (z < 0.02 * (TB.ROLL_MID / 2 + 1) && r > 0.02 * 20) rMid = (rMid === 0 ? r : Math.min(rMid, r));
      if (z >= zEnd0 && z <= zEnd1) rEnd = Math.max(rEnd, r);
    }
    ok('テーブルローラ 胴端径＝図面値', Math.abs(rEnd / 0.02 * 2 - TB.ROLL_D_END) < 1,
       `実測 Φ${(rEnd / 0.02 * 2).toFixed(1)} / 図面 Φ${TB.ROLL_D_END}`);
    ok('テーブルローラ 中央径＝図面値', Math.abs(rMid / 0.02 * 2 - TB.ROLL_D_MID) < 1.5,
       `実測 Φ${(rMid / 0.02 * 2).toFixed(1)} / 図面 Φ${TB.ROLL_D_MID}`);
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
    // 75 mm シャー（上刃固定・下台上昇式）の成立条件
    {
      const S = K.CROP_SHEAR, FV = window.__app.world.finishView, sc = K.SCALE, P0 = K.MILL.PASS_LINE;
      ok('下台の行程で下刃先が固定上刃を越える（切り離せる）', S.UPPER_CLR + S.OVERTRAVEL >= S.UPPER_CLR + 10,
         `行程 ${S.UPPER_CLR + S.OVERTRAVEL} mm ＞ 上刃刃先 ${S.UPPER_CLR} mm`);
      ok('固定上刃の刃先は最大板厚 75 mm を通す高さ', S.UPPER_CLR >= S.MAX_TH, `刃先 ${S.UPPER_CLR} mm ≥ ${S.MAX_TH} mm`);
      const bb = new window.__T.Box3().setFromObject(FV.cropShear);
      ok('シャー架構はコンパクト（最上部がパスライン上 1.5 m 以内）', bb.max.y / sc <= P0 + 1500, `最上部 ${(bb.max.y / sc - P0).toFixed(0)} mm`);
      ok('板押えを持たない', FV.cropHold === undefined && FV.cropBed !== undefined, `下台=${!!FV.cropBed} 押え=${!!FV.cropHold}`);
      // 端部切断の計画: 板厚 60 mm 換算で、全材質・全幅・温度域で 1 カット 300〜500、総量 300〜2400
      const sl = window.__app.physics.slab, keep = { th: sl.thickness, w: sl.width, T: Array.from(sl.T), al: sl.alloy, h0: sl.initialThickness };
      let cutMin = 1e9, cutMax = 0, totMin = 1e9, totMax = 0;
      for (const [k, a] of Object.entries(K.ALLOYS)) for (const w of [900, 1500, 2200]) for (const T of [a.T_ROLL[0], a.T_ROLL[1]]) {
        sl.thickness = 60; sl.width = w; sl.initialThickness = 382; sl.alloy = a; sl.T.fill(T); sl.cropped = { 1: false, '-1': false };
        const plan = window.__ROLL.cropPlan(sl.overhangAt(1));
        cutMin = Math.min(cutMin, plan.each); cutMax = Math.max(cutMax, plan.each); totMin = Math.min(totMin, plan.total); totMax = Math.max(totMax, plan.total);
      }
      sl.thickness = keep.th; sl.width = keep.w; sl.T.set(keep.T); sl.alloy = keep.al; sl.initialThickness = keep.h0;
      ok('1 カットは 300〜500 mm（板厚 60 mm・全材質・全幅・温度域）', cutMin >= S.CUT_MIN && cutMax <= S.CUT_MAX, `${cutMin}〜${cutMax} mm`);
      ok('総切断長は 300〜2,400 mm（板厚 60 mm 換算）', totMin >= S.TOTAL_MIN && totMax <= S.TOTAL_MAX, `${totMin}〜${totMax} mm`);
      // --- 実機仕様との突き合わせ ---
      ok('シャー刃の寸法が実機仕様（75 × 180 × 2500 mm）',
         S.BLADE_T === 75 && S.BLADE_H === 180 && S.BLADE_L === 2500,
         `${S.BLADE_T} × ${S.BLADE_H} × ${S.BLADE_L} mm / ${S.BLADE_MAT} ${S.BLADE_HS}`);
      {
        const f = window.__ROLL.cropForce(S.MAX_TH, S.BLADE_L);
        ok('最大断面を切るのに要する剪断力が定格 368 t と一致',
           Math.abs(f - S.RATED_FORCE_T) < 1,
           `75 × 2500 mm → ${f.toFixed(0)} t（定格 ${S.RATED_FORCE_T} t）`);
        const fw = window.__ROLL.cropForce(S.MAX_TH, K.TRIMMER.WIDTH_IN_MAX);
        ok('実運用の最大板幅でも定格剪断力を超えない', fw <= S.RATED_FORCE_T,
           `板厚 ${S.MAX_TH} × 幅 ${K.TRIMMER.WIDTH_IN_MAX} mm → ${fw.toFixed(0)} t`);
      }
      ok('上下刃のサイドクリアランスが板厚の 3〜8 %',
         S.CLEARANCE / S.MAX_TH >= 0.03 && S.CLEARANCE / S.MAX_TH <= 0.08,
         `${S.CLEARANCE} mm ＝ 板厚 ${S.MAX_TH} mm の ${(100 * S.CLEARANCE / S.MAX_TH).toFixed(1)} %`);
      {
        // クロップ屑は先端・後端とも «テーブルロールの下» の受けへ落とし、1 台の傾斜
        // コンベアで操作側へ抜く。受け開口が刃の入側・出側の両方を跨いでいるかを見る。
        const SC = S.SCRAP, PIT = SC.PIT, CV = SC.CONV, w = K.SLAB.WID_MAX;
        ok('屑の受け開口が刃の入側・出側の両方に跨がる（正準 X の 0 を含む）',
           PIT.X0 < 0 && PIT.X1 > 0, `開口 ${PIT.X0}〜${PIT.X1}（0 が剪断面）`);
        ok('受け開口の Z が最大板巾より広い', Math.abs(PIT.BRIDGE[0] - PIT.Z0) > w,
           `開口 ${PIT.Z0}〜${PIT.BRIDGE[0]} ＝ ${Math.abs(PIT.BRIDGE[0] - PIT.Z0)} mm / 最大板巾 ${w}`);
        ok('屑コンベアの受け面が開口の全幅を受ける', CV.W >= (PIT.X1 - PIT.X0) - 120,
           `受け面 ${CV.W} mm / 開口 ${PIT.X1 - PIT.X0} mm`);
        ok('払い出し方向が操作側（+Z＝装入設備と同じ側）',
           CV.Z1 > CV.Z0 && SC.BOX.Z > 0 && K.SUPPLY.SIDE_Z > 0,
           `コンベア ${CV.Z0} → ${CV.Z1} ／ 屑箱 Z ${SC.BOX.Z}`);
      }
    }
    // --- 巻取: 段付きコイル・拡縮マンドレル・押えアーム ---
    {
      const C = K.COILER, R2 = window.__ROLL, FV = window.__app.world.finishView, sc = K.SCALE, P0 = K.MILL.PASS_LINE;
      const L56 = R2.coilLayers(56, 8);
      ok('段数モデルの外径が図面の巻数（8 mm × 56 巻 = Φ1510）を再現する', Math.abs(L56.od - 1510) < 8, `56 巻 → Φ${L56.od.toFixed(0)}`);
      const shrink = 2 * C.SEG_STROKE * Math.cos(Math.PI / 4);
      ok('マンドレルの縮小でコイル内径 Φ610 から 20 mm 以上離れる', shrink >= 20, `外接径の減少 ${shrink.toFixed(0)} mm（ストローク ${C.SEG_STROKE}）`);
      const eLo = R2.coilEntry(FV.coiler.position.x / sc + K.COILER.DEFLECTOR_X - C.X + K.FLIP * C.ROLL_LO_PITCH / 2, P0 + 4, C.X, P0 + C.Y_ABOVE, C.MANDREL_D / 2);
      const eHi = R2.coilEntry(K.COILER.DEFLECTOR_X + K.FLIP * C.ROLL_LO_PITCH / 2, P0 + 4, C.X, P0 + C.Y_ABOVE, C.OD_MAX / 2 - 4);
      ok('3ロール出側からコイルへの接線が最小径〜最大径で存在し、接点は下半分（下巻き）', !!eLo && !!eHi && Math.sin(eLo.phi) < 0 && Math.sin(eHi.phi) < 0,
         `接点角 Φ610: ${eLo ? (eLo.phi * 180 / Math.PI).toFixed(0) : '-'}° / Φ1900: ${eHi ? (eHi.phi * 180 / Math.PI).toFixed(0) : '-'}°`);
      const pvx = FV.holdPivot.x + C.X, pvy = FV.holdPivot.y;
      ok('押えアームの支点がサイドトリマー架構の梁の位置にある', Math.abs(pvx - K.TRIMMER.X) <= 1200 && pvy >= P0 + 1500 && pvy <= P0 + 2100,
         `支点 x=${pvx.toFixed(0)}（トリマー ${K.TRIMMER.X}）/ y=パスライン上 ${(pvy - P0).toFixed(0)} mm`);
      ok('仕上げ形態は板厚で決まる（10 mm 以下はコイル、10 mm 超は板材）', R2.finishMode(10) === 'COIL' && R2.finishMode(10.5) === 'PLATE' && R2.finishMode(4) === 'COIL',
         `10 → ${R2.finishMode(10)} / 10.5 → ${R2.finishMode(10.5)}`);
    }
    // --- 構造: ピット・ハウジング・ガイド・転倒機・駆動系 ---
    {
      const H = K.MILL.HOUSING, sc = K.SCALE, W3 = window.__app.world, T3 = window.__T;
      const hOuter = H.POST_X + H.WIN_X / 2;
      // 主テーブル（長胴 Φ281.6）はハウジング外面の外側から。ミル直近の E-1 / E-2 は
      // 胴が短く（857）OS/DS に分けてあるので、ハウジングの «内側» に入る。
      const mainX = allX.filter(x => Math.abs(x) > 2400), eX = allX.filter(x => Math.abs(x) <= 2400);
      ok('主テーブルローラはハウジング外面の外側から始まる', Math.min(...mainX.map(Math.abs)) - CFG.ROLL_D_END / 2 > hOuter,
         `最近接 ${Math.min(...mainX.map(Math.abs))} mm / ハウジング外面 ${hOuter} mm`);
      ok('E-1 / E-2 の短胴ローラはハウジングの内側幅に収まる',
         eX.length === 8 && CFG.EROLL.Z_OUT + CFG.EROLL.COLLAR_L + CFG.EROLL.JOURNAL_L < H.INNER_Z,
         `胴端 ${CFG.EROLL.Z_OUT} + 首 ${CFG.EROLL.COLLAR_L + CFG.EROLL.JOURNAL_L} < ハウジング内面 ${H.INNER_Z}（段 ${eX.length}）`);
      const gb = new T3.Box3().setFromObject(W3.guideView.stations[0].sides[0]);
      const gIn = Math.min(Math.abs(gb.min.x), Math.abs(gb.max.x)) / sc;
      ok('サイドガイドはハウジングの外側にある', gIn > hOuter, `ガイド内端 ${gIn.toFixed(0)} mm / ハウジング外面 ${hOuter} mm`);
      ok('ピット幅はソールプレートより広く、深さはソールプレート下面に一致する',
         K.BUILDING.PIT.X * 2 > H.POST_X * 2 + H.WIN_X + 100 && K.BUILDING.PIT.DEPTH === -H.BOT_Y,
         `ピット ±${K.BUILDING.PIT.X} / 深さ ${K.BUILDING.PIT.DEPTH} / BOT_Y ${H.BOT_Y}`);
      const db = new T3.Box3().setFromObject(W3.driveView.group);
      ok('駆動系（ピニオンスタンド・減速機・電動機）が床上にある', db.min.y / sc >= -1, `最下点 ${(db.min.y / sc).toFixed(0)} mm`);
      const S = K.SUPPLY;
      ok('転倒軸はベッド面より軸半径以上低い（軸が板に当たらない）', S.PIVOT_DROP >= S.SHAFT_D / 2 + 20, `PIVOT_DROP ${S.PIVOT_DROP} ≥ ${S.SHAFT_D / 2 + 20}`);
      ok('装入スラブの降ろし位置がサイドガイドの外側', Math.abs(S.TILTER_X) - K.SLAB.LEN_MAX > Math.max(Math.abs(gb.min.x), Math.abs(gb.max.x)) / sc,
         `スラブ端 ${(Math.abs(S.TILTER_X) - K.SLAB.LEN_MAX).toFixed(0)} / ガイド外端 ${(Math.max(Math.abs(gb.min.x), Math.abs(gb.max.x)) / sc).toFixed(0)} mm`);
    }
    // --- 材質・温度・反り ---
    {
      const M = K.MATERIAL, R2 = window.__ROLL;
      ok('材質表: 巻取温度 < 熱間域下限 < 上限（全材質）', Object.values(K.ALLOYS).every(a => a.T_COIL < a.T_ROLL[0] && a.T_ROLL[0] < a.T_ROLL[1]),
         Object.keys(K.ALLOYS).join(' '));
      ok('変形抵抗は温度が低いほど高い（全材質）', Object.keys(K.ALLOYS).every(k => R2.flowStress(350, 5, K.ALLOYS[k]) > R2.flowStress(450, 5, K.ALLOYS[k])),
         Object.keys(K.ALLOYS).map(k => `${k}:${R2.flowStress(450, 5, K.ALLOYS[k]).toFixed(0)}`).join(' '));
      {   // クーラントは «上面と側面がメイン»。下面は濡れたテーブルローラの跡だけ
        const CO = M.COOLANT, PE = window.__app.physics.constructor;
        ok('クーラント冷却は上面が強い（下面は濡れたローラの跡だけ）', CO.WET_TOP > CO.WET_BOT,
           `上面 ${CO.WET_TOP} / 下面 ${CO.WET_BOT} / 側面 ${CO.WET_SIDE}`);
        ok('板面（300〜600 ℃）は膜沸騰域で熱伝達率が核沸騰より桁で低い', PE.boiling(450).h < CO.H_NB / 10 && CO.T_LEID > 150,
           `450 ℃ ${PE.boiling(450).h} / 60 ℃ ${PE.boiling(60).h} W/m²K（ライデンフロスト点 ${CO.T_LEID} ℃）`);
        ok('膜沸騰の熱の受け手は液温でなく飽和温度', CO.T_SAT > CO.T_BULK && Math.abs(PE.boiling(450).T - CO.T_SAT) < 1,
           `液温 ${CO.T_BULK} ℃ / 飽和 ${CO.T_SAT} ℃`);
        // テーブルローラは鼓の逆形なので接触は板の «両エッジ寄りの 2 本の線» に限られる
        const TB = K.TABLE, TT = M.TABLE_TOUCH;
        ok('テーブルローラは胴端が太く、平板は自分のエッジ位置で載る（自動調心）', TB.ROLL_D_END > TB.ROLL_D_MID,
           `胴端 Φ${TB.ROLL_D_END} > 中央 Φ${TB.ROLL_D_MID}`);
        const frac = Math.min(1, 2 * TT.BAND / 1500) * Math.min(1, TT.ARC / TT.PITCH);
        ok('ローラ接触の見かけの熱伝達率は放熱と同程度（«多少» の寄与）', TT.H * frac > 5 && TT.H * frac < 60,
           `${(TT.H * frac).toFixed(0)} W/m²K（幅 1,500 mm、面積割合 ${(frac * 100).toFixed(2)} %）`);
      }
      const sp = R2.curlSpan(2e-5, 60, 1500);
      ok('反りの自重釣り合い: 60 mm 板・R=50 m で浮き上がり長 2〜15 m', sp.liftOff > 2000 && sp.liftOff < 15000, `ℓ=${(sp.liftOff / 1000).toFixed(1)} m / 先端 ${sp.tip.toFixed(0)} mm`);
      ok('板厚方向の層数は奇数（中心層を持つ）', M.LAYERS % 2 === 1 && M.LAYERS >= 5, `${M.LAYERS} 層`);
    }
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

    // ---- 版数と変更履歴 ----
    // «画面に出ている版» と «コードの版» がずれると、更新したのに直っていないのか
    // 反映されていないのかが分からなくなる。表記も履歴の並びもここで縛る。
    {
      const V = window.__VER, semver = /^\d+\.\d+\.\d+$/;
      const num = (v) => v.split('.').map(Number);
      const cmp = (a, b) => { const x = num(a), y = num(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
      ok('版数バッジの表記がコードの版と一致する',
         document.getElementById('btn-ver')?.textContent === V.label, `バッジ ${document.getElementById('btn-ver')?.textContent} / VERSION.label ${V.label}`);
      ok('現在の版は履歴の先頭', V.now === V.LOG[0] && semver.test(V.now.v), `${V.PREFIX}${V.now.v}（${V.now.date}）`);
      ok('履歴が新しい順に並ぶ（版数が単調減少・日付が単調非増加）',
         V.LOG.every((r, i) => i === 0 || (cmp(V.LOG[i - 1].v, r.v) > 0 && V.LOG[i - 1].date >= r.date)),
         V.LOG.map(r => r.v).join(' > '));
      ok('版数の重複が無い', new Set(V.LOG.map(r => r.v)).size === V.LOG.length, `${V.LOG.length} 版`);
      ok('全ての版に日付・表題・変更点がある',
         V.LOG.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.title && r.items?.length),
         `変更点 ${V.LOG.reduce((a, r) => a + r.items.length, 0)} 件`);
      const rels = document.querySelectorAll('#ver-log .rel');
      ok('履歴パネルが全ての版を描く', rels.length === V.LOG.length && rels[0].classList.contains('is-cur'),
         `${rels.length} 版 / 先頭に «現在» の印`);
    }

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
