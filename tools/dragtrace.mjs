// クロップ屑を «クリックで掴んで動かせる» ことを実測する評価器。
//   node dragtrace.mjs
// 実際のポインタ操作（押す → 動かす → 放す）を送り、屑の状態と位置を追う。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 1200, height: 700 }, quiet: true });
await installHelpers(page);
const checks = [];
const ok = (n, c, d = '') => { checks.push({ name: n, pass: !!c, detail: d }); };

// 屑が屑箱に収まるまで進める
const first = await page.evaluate(() => {
  const A = window.__app;
  A.bus.emit('CMD_RESET');
  window.__startAuto(false);
  window.__ff((p) => p.finish.scraps.some(s => s.stage === 'REST') || p.tripped, 120 * 4000, 0);
  A.world.render(A.physics, 1 / 60);
  const sc = A.physics.finish.scraps.find(s => s.stage === 'REST');
  return sc ? { id: sc.id, x: sc.x, y: sc.y, z: sc.z, stage: sc.stage } : null;
});
ok('屑が払い出されて静止する', !!first, first ? `id ${first.id} / ${first.stage}` : '屑が出なかった');

// その屑が画面のどこに写るかを出し、そこへ視点を寄せてから掴む
const at = await page.evaluate((id) => {
  const A = window.__app, W = A.world, K = window.__CFG;
  const sc = A.physics.finish.scraps.find(s => s.id === id);
  const P = K.MILL.PASS_LINE;
  W.applyView({ pos: [sc.x + 5200, 4200, sc.z + 5200], tgt: [sc.x, P + sc.y, sc.z] }, true);
  W.render(A.physics, 1 / 60);
  const m = W.finishView.scraps.get(id);
  const v = m.position.clone().project(W.camera);
  const r = W.renderer.domElement.getBoundingClientRect();
  return { sx: (v.x * .5 + .5) * r.width + r.left, sy: (-v.y * .5 + .5) * r.height + r.top,
           x: sc.x, z: sc.z, y: sc.y, w: r.width, h: r.height };
}, first.id);

await page.mouse.move(at.sx, at.sy);
const hover = await page.evaluate(() => window.__app.world.renderer.domElement.style.cursor);
ok('屑の上でカーソルが «掴める» 形になる', hover === 'grab', `cursor = "${hover}"`);

await page.mouse.down();
const held = await page.evaluate((id) => {
  const A = window.__app, sc = A.physics.finish.scraps.find(s => s.id === id);
  return { stage: sc.stage, ctrl: A.world.controls.enabled, cursor: A.world.renderer.domElement.style.cursor };
}, first.id);
ok('押すと «掴んだ» 状態になる', held.stage === 'HELD', `stage = ${held.stage}`);
ok('掴んでいる間は視点操作が止まる', held.ctrl === false, `controls.enabled = ${held.ctrl}`);

// 画面上で 200 px ほど引きずる
await page.mouse.move(at.sx - 200, at.sy - 60, { steps: 8 });
const moved = await page.evaluate((a) => {
  const A = window.__app, sc = A.physics.finish.scraps.find(s => s.id === a.id);
  A.world.render(A.physics, 1 / 60);
  return { x: sc.x, z: sc.z, y: sc.y, dx: sc.x - a.x, dz: sc.z - a.z, dy: sc.y - a.y };
}, { id: first.id, x: at.x, z: at.z, y: at.y });
ok('引きずると床の上を動く（水平に移動する）',
   Math.hypot(moved.dx, moved.dz) > 300 && Math.abs(moved.dy) < 1,
   `Δx ${moved.dx.toFixed(0)} / Δz ${moved.dz.toFixed(0)} / Δy ${moved.dy.toFixed(2)} mm`);

await page.mouse.up();
const after = await page.evaluate((id) => {
  const A = window.__app, K = window.__CFG;
  const sc = A.physics.finish.scraps.find(s => s.id === id);
  const st0 = sc.stage;
  window.__ff(() => sc.stage === 'REST', 120 * 20, 0);
  A.world.render(A.physics, 1 / 60);
  return { st0, stage: sc.stage, y: sc.y, floor: sc.th / 2 - K.MILL.PASS_LINE,
           ctrl: A.world.controls.enabled, cursor: A.world.renderer.domElement.style.cursor };
}, first.id);
ok('放すと落下の状態へ移る', after.st0 === 'RELEASED', `stage = ${after.st0}`);
ok('落ちて床（または箱）に着く', after.stage === 'REST', `stage = ${after.stage} / y = ${after.y.toFixed(0)}`);
ok('置いた高さが床の上（めり込まない・浮かない）', Math.abs(after.y - after.floor) < 260,
   `y ${after.y.toFixed(0)} / 床 ${after.floor.toFixed(0)} mm`);
ok('放すと視点操作が戻る', after.ctrl === true, `controls.enabled = ${after.ctrl}`);

for (const c of checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${checks.filter(c => c.pass).length}/${checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
process.exit(checks.every(c => c.pass) ? 0 : 1);
