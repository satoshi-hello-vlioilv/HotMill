// 鋳肌ラウンド断面（Sect）の実測。
//   node edgetrace.mjs
//  ・輪郭が «上面は平ら・側面に円弧» になっているか（面削面が平らでなければ鏡面がおかしい）
//  ・断面積が解析解（長方形 − 角の欠け）と一致するか
//  ・写像が単射で連続か（内部点が輪郭を越えない）
//  ・圧延で丸みが自己相似に縮み、板厚に対する比が単調に減るか
//  ・実際に焼かれたメッシュ（装入スラブ・圧延材）の頂点が輪郭上に載っているか
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, K = window.__CFG, S = K.SCALE;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  const SE = window.__SECT;                        // harness が公開した Sect（断面形状）
  const h = 476, w = 1500, R0 = K.SLAB.EDGE_R, scalp = 12;
  const sec = SE.prep(h, w, { R: R0, c: R0 - scalp });
  // 1) 上面は平ら
  let flatMax = 0;
  for (let i = 0; i <= 40; i++) { const b = -1 + 2 * i / 40, q = SE.at(sec, 1, b); flatMax = Math.max(flatMax, Math.abs(q.y - h / 2)); }
  ok('面削面（上下面）が平ら', flatMax < 1e-9, `最大のずれ ${flatMax.toExponential(2)} mm`);
  // 2) 上面の半幅 zt < w/2（丸みのぶん狭い）／ 側面の最大半幅 = w/2
  const zt = SE.at(sec, 1, 1).z, zside = SE.at(sec, 0, 1).z;
  ok('上面は丸みのぶん幅が狭い', zt < w / 2 - 1 && zt > w / 2 - R0, `上面半幅 ${zt.toFixed(1)} / 板半幅 ${w / 2}`);
  ok('側面の最大半幅が板幅の半分', Math.abs(zside - w / 2) < 1e-9, `${zside.toFixed(3)} mm`);
  // 3) 輪郭が円弧上にある（中心 (W−R, H−c) から R）
  let arcErr = 0;
  for (let i = 0; i <= 20; i++) { const a = 0.5 + 0.5 * i / 20, q = SE.at(sec, a, 1);
    arcErr = Math.max(arcErr, Math.abs(Math.hypot(q.z - (w / 2 - R0), q.y - (h / 2 - (R0 - scalp))) - R0)); }
  ok('丸み部が半径 R の円弧に載る', arcErr < 1e-6, `最大の半径ずれ ${arcErr.toExponential(2)} mm`);
  // 4) 断面積 = 長方形 − 角の欠け（数値積分と一致）
  const N = 4000; let num = 0;                       // y ごとの半幅を台形則で積分
  for (let i = 0; i <= N; i++) { const y = -h / 2 + h * i / N;
    const v = Math.abs(y) - (h / 2 - (R0 - scalp));
    const half = v <= 0 ? w / 2 : (w / 2 - R0) + Math.sqrt(Math.max(R0 * R0 - v * v, 0));
    num += (i === 0 || i === N ? 0.5 : 1) * 2 * half * (h / N); }
  const ana = SE.area(sec);
  ok('断面積が解析解と一致', Math.abs(ana - num) / num < 1e-4, `解析 ${ana.toFixed(0)} / 数値 ${num.toFixed(0)} mm²（長方形 ${(h * w).toFixed(0)}）`);
  // 5) 内部点が輪郭を越えない
  let outside = 0;
  for (let i = 0; i <= 30; i++) for (let j = 0; j <= 30; j++) {
    const a = -1 + 2 * i / 30, b = -1 + 2 * j / 30, q = SE.at(sec, a, b);
    const v = Math.abs(q.y) - (h / 2 - (R0 - scalp));
    const lim = v <= 0 ? w / 2 : (w / 2 - R0) + Math.sqrt(Math.max(R0 * R0 - v * v, 0));
    if (Math.abs(q.z) > lim + 1e-6 || Math.abs(q.y) > h / 2 + 1e-6) outside++; }
  ok('内部の点が輪郭の外へ出ない', outside === 0, `外へ出た点 ${outside} / 961`);
  // 6) 丸みが板厚とともに自己相似に縮む
  const sl = A.physics.slab, h0 = sl.initialThickness;
  const seq = [h0, h0 / 2, h0 / 5, h0 / 20, h0 / 50].map(t => ({ h: +t.toFixed(1), R: +sl.edgeAt(t).R.toFixed(2), c: +sl.edgeAt(t).c.toFixed(2) }));
  const mono = seq.every((q, i) => i === 0 || q.R < seq[i - 1].R);
  ok('圧延で丸みが単調に縮む', mono, seq.map(q => `${q.h}mm→R${q.R}`).join(' '));
  const ratio = seq.map(q => q.R / q.h);
  ok('板厚に対する丸みの比も単調に減る', ratio.every((r, i) => i === 0 || r < ratio[i - 1]),
     ratio.map(r => (r * 100).toFixed(2) + '%').join(' '));
  ok('鋳造まま（面削前）の丸みが仕様どおり', Math.abs(sl.edgeAt(h0).R - R0) < 1e-9 && Math.abs(sl.edgeAt(h0).c - (R0 - sl.scalp)) < 1e-9,
     `R ${sl.edgeAt(h0).R} / c ${sl.edgeAt(h0).c}（面削 ${sl.scalp}）`);
  // 7) 焼かれたメッシュ（装入スラブ）の頂点が輪郭上にある
  A.world.render(A.physics, 1 / 60);
  let mesh = null; A.world.scene.traverse(o => { if (o.name === '装入スラブ') mesh = o; });
  let vErr = -1, nOut = 0, wMax = 0;
  if (mesh) {
    const pos = mesh.geometry.attributes.position; vErr = 0;
    const e = A.physics.slab.edgeAt(A.physics.slab.thickness), th = A.physics.slab.thickness, wd = A.physics.slab.width;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / S, z = pos.getZ(i) / S;
      const v = Math.abs(y) - (th / 2 - e.c);
      const lim = v <= 0 ? wd / 2 : (wd / 2 - e.R) + Math.sqrt(Math.max(e.R * e.R - v * v, 0));
      wMax = Math.max(wMax, Math.abs(z));
      if (Math.abs(z) > lim + 0.5 || Math.abs(y) > th / 2 + 0.5) nOut++;
      vErr = Math.max(vErr, Math.abs(y) - th / 2); }
  }
  ok('装入スラブのメッシュが輪郭の内側に収まる', mesh && nOut === 0, mesh ? `外へ出た頂点 ${nOut} ／ 最大半幅 ${wMax.toFixed(1)} mm` : 'メッシュが無い');
  ok('装入スラブの板厚が正しい', mesh && Math.abs(vErr) < 0.5, `上下面のずれ ${vErr.toFixed(3)} mm`);
  return { checks, seq };
});
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
