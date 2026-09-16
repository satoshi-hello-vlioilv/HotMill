// クーラントの沸騰曲線を «曲線の上で» 決める編集ダイアログ（UIManager.openBoilDialog）の実測トレース。
//
// 物理が読むのは CONFIG.MATERIAL.COOLANT の 1 か所（PhysicsEngine.boiling / coolantCurve）。ダイアログは
// その値をハンドルで動かし、曲線そのものも boiling() を呼んで描く —— 式が 2 か所に無いことを、描いた
// 曲線の点と関数の値を突き合わせて確かめる。
//
//   ① 開くと軸・基準の曲線（実線）・いまの液の曲線（破線）・ハンドル 2 つが描かれる
//   ② 描いた基準の曲線の点が boiling()（基準の液）と一致する（300／450 ℃ で 1 % 以内）
//   ③ ハンドルの位置が CONFIG の値の上にある（逆写像で 1 % 以内）
//   ④ ライデンフロスト点のハンドルをドラッグすると CONFIG（T_LEID・H_FILM）が落とした位置に変わり、
//      boiling(450).h と予測側（Rolling.tempBudget の冷却項）がそれに追従する
//   ⑤ 制約: 核沸騰の上限をライデンフロスト点より右へ引きずっても 10 K 手前で止まる
//   ⑥ 数値欄に入れるとハンドルと曲線が動く
//   ⑦ «既定に戻す» で開く前の値に戻る
//   参考: 450 ℃ での熱流束（編集前 → 後）
//
//   node tools/boiltrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 1400, height: 900 }, quiet: true });
await installHelpers(page);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const snap = () => page.evaluate(() => {
  const C = window.__CFG.MATERIAL.COOLANT, U = window.__app.ui, PE = window.__phys.constructor, R = window.__ROLL;
  const svg = document.getElementById('boil-svg'), hnds = [...svg.querySelectorAll('.hnd')];
  const hnd = Object.fromEntries(hnds.map(h => [h.dataset.k, { cx: +h.getAttribute('cx'), cy: +h.getAttribute('cy'), T: U._boilTofX(+h.getAttribute('cx')), h: U._boilHofY(+h.getAttribute('cy')) }]));
  const base = svg.querySelector('.cv-base')?.getAttribute('d') || '', now = svg.querySelector('.cv-now')?.getAttribute('d') || '';
  // 基準曲線の点を «描いた d» から読む（M/L の対）
  const pts = base.match(/[ML]([\d.]+) ([\d.]+)/g)?.map(q => { const m = q.match(/[ML]([\d.]+) ([\d.]+)/); return { x: +m[1], y: +m[2] }; }) || [];
  const at = (T) => { const x = U._boilX(T); let best = pts[0]; for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; return U._boilHofY(best.y); };
  const bulk = C.T_BULK;
  const budget = R.tempBudget(16, 8, 50, 420, 60, R.alloy('A5052'), 1330, 100, 80, true);
  return { cfg: { T_NB: C.T_NB, H_NB: C.H_NB, T_LEID: C.T_LEID, H_FILM: C.H_FILM, T_BULK: bulk, T_SAT: C.T_SAT }, subK: U._boilSubK(),
           open: document.getElementById('dlg-boil').open, nHnd: hnds.length, hasBase: !!base, hasNow: !!now, nAxis: svg.querySelectorAll('.ax').length,
           hnd, drawn: { h300: at(300), h450: at(450) }, fn: { h300: U._boilBase(300).h, h450: U._boilBase(450).h, now450: PE.boiling(450).h },
           q450: (() => { const b = PE.boiling(450); return b.h * (450 - b.T) / 1e6; })(),
           budget: { cool: budget.cool, net: budget.net, keys: Object.keys(budget) } };
});

await page.evaluate(() => window.__app.ui.openBoilDialog());
await sleep(120);
const s0 = await snap();

// ④ ドラッグ: ライデンフロスト点のハンドルを «右へ 60 px・上へ 40 px»
const box = await page.evaluate(() => { const h = document.querySelector('#boil-svg .hnd[data-k="leid"]').getBoundingClientRect(); return { x: h.left + h.width / 2, y: h.top + h.height / 2 }; });
await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + 30, box.y - 20, { steps: 4 }); await page.mouse.move(box.x + 60, box.y - 40, { steps: 4 }); await page.mouse.up();
await sleep(60);
const s1 = await snap();
const dropped = await page.evaluate(({ x, y }) => { const U = window.__app.ui, svg = document.getElementById('boil-svg'), r = svg.getBoundingClientRect();
  const px = (x - r.left) * 680 / r.width, py = (y - r.top) * 380 / r.height; return { T: U._boilTofX(px), h: U._boilHofY(py) }; }, { x: box.x + 60, y: box.y - 40 });

// ⑤ 制約: 核沸騰の上限を右端まで引きずる
const nb = await page.evaluate(() => { const h = document.querySelector('#boil-svg .hnd[data-k="nb"]').getBoundingClientRect(); return { x: h.left + h.width / 2, y: h.top + h.height / 2 }; });
await page.mouse.move(nb.x, nb.y); await page.mouse.down(); await page.mouse.move(nb.x + 400, nb.y, { steps: 6 }); await page.mouse.up();
await sleep(60);
const s2 = await snap();

// ⑥ 数値欄
await page.evaluate(() => { const el = document.getElementById('boil-hfilm'); el.value = '1500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(60);
const s3 = await snap();

// ⑦ 既定に戻す
await page.click('#boil-reset'); await sleep(60);
const s4 = await snap();
await browser.close();

const f0 = (x) => (+x).toFixed(0), f1 = (x) => (+x).toFixed(1);
const checks = [];
const ok = (name, pass, got, ref = false) => { checks.push({ name, pass: !!pass, got, ref }); console.log(`${ref ? '??' : pass ? 'OK' : 'NG'}   ${name}  → ${got}`); };
const rel = (a, b) => Math.abs(a / b - 1);
ok('開くと軸・基準の曲線・いまの液の曲線・ハンドル 2 つが描かれる', s0.open && s0.nAxis === 2 && s0.hasBase && s0.hasNow && s0.nHnd === 2, `open ${s0.open}・軸 ${s0.nAxis}・実線 ${s0.hasBase}・破線 ${s0.hasNow}・ハンドル ${s0.nHnd}`);
ok('描いた基準の曲線の点が boiling()（基準の液）と一致する（300／450 ℃、1 % 以内）', rel(s0.drawn.h300, s0.fn.h300) < 0.01 && rel(s0.drawn.h450, s0.fn.h450) < 0.01, `300 ℃ ${f0(s0.drawn.h300)} vs ${f0(s0.fn.h300)}／450 ℃ ${f0(s0.drawn.h450)} vs ${f0(s0.fn.h450)} W/m²K`);
ok('ハンドルが CONFIG の値の上にある（核沸騰の上限 T_NB/H_NB、ライデンフロスト点 T_LEID/H_FILM×液温係数）', Math.abs(s0.hnd.nb.T - s0.cfg.T_NB) < 1 && rel(s0.hnd.nb.h, s0.cfg.H_NB) < 0.01 && Math.abs(s0.hnd.leid.T - s0.cfg.T_LEID) < 1 && rel(s0.hnd.leid.h, s0.cfg.H_FILM * s0.subK) < 0.01,
   `nb ${f0(s0.hnd.nb.T)} ℃・${f0(s0.hnd.nb.h)} vs ${s0.cfg.T_NB}・${s0.cfg.H_NB}／leid ${f0(s0.hnd.leid.T)} ℃・${f0(s0.hnd.leid.h)} vs ${s0.cfg.T_LEID}・${f0(s0.cfg.H_FILM * s0.subK)}`);
ok('ライデンフロスト点をドラッグすると CONFIG が落とした位置になる（T_LEID ±1 ℃・H_FILM ±2 %）', Math.abs(s1.cfg.T_LEID - dropped.T) <= 1 && rel(s1.cfg.H_FILM * s1.subK, dropped.h) < 0.02 && s1.cfg.T_LEID !== s0.cfg.T_LEID,
   `${s0.cfg.T_LEID} → ${s1.cfg.T_LEID} ℃（落とした ${f0(dropped.T)}）、H_FILM ${s0.cfg.H_FILM} → ${s1.cfg.H_FILM}（落とした高さ ${f0(dropped.h)} ＝ H_FILM×${f1(s1.subK)}）`);
ok('物理（boiling(450).h）と予測（tempBudget の冷却項）がドラッグに追従する', s1.fn.now450 !== s0.fn.now450 && Math.abs(s1.budget.cool) > Math.abs(s0.budget.cool),
   `boiling(450).h ${f0(s0.fn.now450)} → ${f0(s1.fn.now450)}／予測の冷却項 ${s0.budget.cool === null ? `(項名なし: ${s0.budget.keys.join(',')})` : `${f1(s0.budget.cool)} → ${f1(s1.budget.cool)} K`}`);
ok('核沸騰の上限を右端まで引きずってもライデンフロスト点の 10 K 手前で止まる', s2.cfg.T_NB === s2.cfg.T_LEID - 10, `T_NB ${s2.cfg.T_NB} / T_LEID ${s2.cfg.T_LEID}`);
ok('数値欄（膜沸騰 1,500）でハンドルと曲線が動く', s3.cfg.H_FILM === 1500 && rel(s3.hnd.leid.h, 1500 * s3.subK) < 0.01 && rel(s3.drawn.h450, s3.fn.h450) < 0.01, `H_FILM ${s3.cfg.H_FILM}・ハンドル ${f0(s3.hnd.leid.h)}・曲線 450 ℃ ${f0(s3.drawn.h450)} vs ${f0(s3.fn.h450)}`);
ok('«既定に戻す» で開く前の値に戻る', JSON.stringify(s4.cfg) === JSON.stringify(s0.cfg), JSON.stringify(s4.cfg));
ok('（参考）450 ℃ の熱流束（開いたとき → ドラッグ後 → 数値欄 1,500）', true, `${(s0.q450).toFixed(2)} → ${(s1.q450).toFixed(2)} → ${(s3.q450).toFixed(2)} MW/m²`, true);
const fails = checks.filter(c => !c.ref && !c.pass).length, n = checks.filter(c => !c.ref).length;
console.log(`RESULT: ${fails ? 'FAIL' : 'PASS'} (${n - fails}/${n}、参考 ${checks.filter(c => c.ref).length} 件)`);
process.exit(fails ? 1 : 0);
