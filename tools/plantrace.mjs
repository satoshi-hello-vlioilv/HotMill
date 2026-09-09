// 運転計画（キュー・プリセット・保存データ）と、実績の Excel 書き出しを検査する。
//
// 見たいのは «押した通りに状態が変わるか» と «出したファイルが本物か» の 2 つ。
// 画面の見た目だけでなく、保存 → 一覧 → 削除、書き出し → 読み戻しまで通して確かめる。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 1600, height: 950 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, ui = A.ui;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const R = {};

  // 書き出したファイルを掴まえる（実際のダウンロードはしない）
  const files = [];
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { files.push(b); return 'blob:test'; };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};

  // --- 1. ピルと板 ---
  R.pill = { plan: !!$('tb-plan'), pause: !!$('tb-pause'), log: !!$('tb-log') };
  R.panelHiddenAtStart = $('pnl-plan').hidden;
  $('tb-plan').click(); await sleep(60);
  R.panelOpens = !$('pnl-plan').hidden && $('tb-plan').getAttribute('aria-pressed') === 'true';

  // --- 2. 区分（タブ）---
  const tabState = () => ['queue', 'preset', 'saved'].map(k => $('plan-pane-' + k).hidden ? 0 : 1).join('');
  R.tab = {};
  for (const k of ['queue', 'preset', 'saved']) { $('plan-tab-' + k).click(); R.tab[k] = tabState(); }
  $('plan-tab-preset').click();
  R.presetCards = $('plan-presets').querySelectorAll('.card').length;

  // --- 3. プリセットを押すとキューに入り、条件が画面へ反映される ---
  $('plan-presets').querySelector('.card').click(); await sleep(260);
  R.afterPreset = { n: ui.plan.lots.length, tab: tabState(),
                    alloy: $('sel-alloy').value, width: +$('rng-init-wid').value,
                    target: +$('rng-target').value, badge: $('tb-plan-n').textContent };
  R.presetLot = { ...ui.plan.lots[0] };

  // --- 4. 自分の条件を足す・並べ替える・外す ---
  $('rng-init-wid').value = 1500; ui._slabChanged(); await sleep(240);
  $('btn-plan-add').click();
  R.afterAdd = { n: ui.plan.lots.length, lastW: ui.plan.lots[ui.plan.lots.length - 1].width };
  ui.planMove(1, -1);
  R.afterMove = ui.plan.lots.map(q => q.width);
  ui.planDel(0);
  R.afterDel = ui.plan.lots.map(q => q.width);

  // --- 5. 繰り返しの選択 ---
  R.loop = {};
  for (const k of ['queue', 'lot', 'none']) { $('plan-loop-' + k).click(); R.loop[k] = ui.plan.loop; }

  // --- 6. 保存 → 一覧 → 削除（IndexedDB。使えない環境では localStorage へ落ちる）---
  const realPrompt = window.prompt; window.prompt = () => '検査用の計画';
  await ui.planSave(); await sleep(220);
  window.prompt = realPrompt;
  R.saved1 = (await window.__Store.all()).length;
  R.savedCards = $('plan-saved').querySelectorAll('.card').length;
  R.storeKind = window.__Store.kind;

  // --- 7. エクスポート（JSON）---
  files.length = 0;
  await ui.planExport(); await sleep(120);
  R.exportBlobs = files.length;
  R.exportJson = files.length ? JSON.parse(await files[0].text()) : null;

  // --- 8. すべて削除 → インポートで戻る ---
  await window.__Store.clear(); await ui._loadSaved();
  R.afterWipe = (await window.__Store.all()).length;
  await ui.planImport(new File([JSON.stringify(R.exportJson)], 'p.json', { type: 'application/json' }));
  await sleep(220);
  R.afterImport = (await window.__Store.all()).length;

  // --- 9. 一時停止（運転していないときは押せない／運転中は効く）---
  R.pauseIdleDisabled = $('tb-pause').disabled;
  window.__startAuto(true);
  for (let i = 0; i < 600; i++) P.step(1 / 120);
  ui.togglePause();
  R.pauseOn = { paused: P.paused, pressed: $('tb-pause').getAttribute('aria-pressed'), tx: $('tb-pause-tx').textContent };
  ui.togglePause();
  R.pauseOff = { paused: P.paused, pressed: $('tb-pause').getAttribute('aria-pressed') };

  // --- 10. Excel 書き出し（ロットの記録が貯まってから）---
  for (let i = 0; i < 120 * 60 && P.log.passes.length < 2; i++) P.step(1 / 120);
  files.length = 0;
  ui.exportXlsx(); await sleep(120);
  R.xlsxBlobs = files.length;
  if (files.length) {
    const buf = new Uint8Array(await files[0].arrayBuffer());
    const txt = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    R.xlsx = { size: buf.length,
      zip: buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04,
      parts: ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
              'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'].filter(n => txt.includes(n)).length,
      sheets: (txt.match(/<sheet name=/g) || []).length,
      hasPassHead: txt.includes('最大荷重[t]'), hasSeriesHead: txt.includes('目標ギャップ[mm]'),
      rows: (txt.match(/<row r=/g) || []).length };
  }
  R.sampleHz = window.__RollingLog?.SAMPLE_HZ ?? null;
  R.series = P.log.series.length;
  {   // 標本の間隔は «長い目で見た平均» で見る（1 コマだけ見ると刻みの丸めに引っかかる）
    const q = P.log.series;
    R.dt = q.length > 20 ? +((q[q.length - 1].t - q[1].t) / (q.length - 2)).toFixed(4) : null;
  }

  // --- 10b. 計画の «次のロットへ進む» 動き（実際に流すと分単位なので、進行だけを見る）---
  ui.plan.lots = [{ ...ui.plan.lots[0] }, { ...ui.plan.lots[0], width: 1400 }];
  ui.plan.running = true; ui.plan.i = 0; ui.plan.done = 0;
  const step = [];
  ui.setPlanLoop('none'); ui._planStep(false); step.push([ui.plan.i, ui.plan.running]);
  ui._planStep(false); step.push([ui.plan.i, ui.plan.running]);          // 末尾の次 → 止まる
  ui.plan.running = true; ui.plan.i = 1; ui.setPlanLoop('queue');
  ui._planStep(false); step.push([ui.plan.i, ui.plan.running]);          // 先頭へ戻る
  ui.setPlanLoop('lot'); ui._planStep(false); step.push([ui.plan.i, ui.plan.running]);   // 同じロット
  R.step = step;
  ui._planStop(); clearTimeout(ui.plan.t);

  // --- 11. 板の中身がはみ出していないか（見切れ検査）---
  const el = $('pnl-plan'), body = el.querySelector('.body'), ctl = el.querySelector('.ctl');
  R.fit = { panelOverflowX: el.scrollWidth - el.clientWidth,
            ctlOverflowX: ctl.scrollWidth - ctl.clientWidth,
            bodyOverflowX: body.scrollWidth - body.clientWidth };
  const hd = el.querySelector('header').getBoundingClientRect(), cb = ctl.getBoundingClientRect();
  R.fit.headerOverlap = +(hd.bottom - cb.top).toFixed(1);

  URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
  return R;
});
await browser.close();

const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
const o = out;

ok('上部に «運転計画 / 一時停止 / 実績» の 3 つのピルがある', o.pill.plan && o.pill.pause && o.pill.log, JSON.stringify(o.pill));
ok('運転計画の板は既定で閉じている', o.panelHiddenAtStart, o.panelHiddenAtStart);
ok('ピルを押すと開く', o.panelOpens, o.panelOpens);
ok('区分が排他に切り替わる（キュー/プリセット/保存データ）',
   o.tab.queue === '100' && o.tab.preset === '010' && o.tab.saved === '001', JSON.stringify(o.tab));
ok(`プリセットが並んでいる（${o.presetCards} 種）`, o.presetCards >= 3, o.presetCards);
ok('プリセットを押すとキューに入る', o.afterPreset.n >= 1, o.afterPreset.n);
ok('プリセットを押すと «キュー» の区分へ戻る', o.afterPreset.tab === '100', o.afterPreset.tab);
ok(`プリセットの条件が画面へ反映される（${o.afterPreset.alloy} / 幅 ${o.afterPreset.width} / 目標 ${o.afterPreset.target}）`,
   o.afterPreset.alloy === o.presetLot.alloy && o.afterPreset.width === o.presetLot.width
   && Math.abs(o.afterPreset.target - o.presetLot.target) < 0.01, JSON.stringify(o.afterPreset));
ok(`ピルの数字がキューの本数と一致（${o.afterPreset.badge}）`, +o.afterPreset.badge === o.afterPreset.n, o.afterPreset.badge);
ok(`いまの条件を足せる（幅 ${o.afterAdd.lastW} が入った）`, o.afterAdd.n === o.afterPreset.n + 1 && o.afterAdd.lastW === 1500, JSON.stringify(o.afterAdd));
ok('並べ替えができる', o.afterMove[0] === 1500, o.afterMove.join(','));
ok('外せる', o.afterDel.length === o.afterMove.length - 1, o.afterDel.join(','));
ok('繰り返しが 3 通り選べる', o.loop.queue === 'queue' && o.loop.lot === 'lot' && o.loop.none === 'none', JSON.stringify(o.loop));
ok(`計画を保存できる（${o.storeKind}）`, o.saved1 === 1 && o.savedCards === 1, `${o.saved1} 件 / カード ${o.savedCards}`);
ok('エクスポートが JSON を 1 本出す', o.exportBlobs === 1 && o.exportJson?.plans?.length === 1, o.exportBlobs);
ok('すべて削除で空になる', o.afterWipe === 0, o.afterWipe);
ok('インポートで戻る', o.afterImport === 1, o.afterImport);
ok('運転していないときは一時停止ピルが押せない', o.pauseIdleDisabled, o.pauseIdleDisabled);
ok('一時停止が効く（物理が止まる・表示が «再開» になる）',
   o.pauseOn.paused === true && o.pauseOn.pressed === 'true' && o.pauseOn.tx === '再開', JSON.stringify(o.pauseOn));
ok('もう一度押すと再開する', o.pauseOff.paused === false && o.pauseOff.pressed === 'false', JSON.stringify(o.pauseOff));
ok('Excel を 1 本出す', o.xlsxBlobs === 1, o.xlsxBlobs);
if (o.xlsx) {
  ok('出したものが ZIP（xlsx）である', o.xlsx.zip, o.xlsx.zip);
  ok(`必要な部品がそろっている（${o.xlsx.parts}/5）`, o.xlsx.parts === 5, o.xlsx.parts);
  ok(`シートが 3 枚（諸元・パス実績・時系列）`, o.xlsx.sheets === 3, o.xlsx.sheets);
  ok('パス実績の見出しが入っている', o.xlsx.hasPassHead, o.xlsx.hasPassHead);
  ok('時系列の見出しが入っている', o.xlsx.hasSeriesHead, o.xlsx.hasSeriesHead);
  ok(`中身がある（${o.xlsx.rows} 行 / ${(o.xlsx.size / 1024).toFixed(0)} KB）`, o.xlsx.rows > 20, o.xlsx.rows);
}
ok(`時系列の分解能が 100 ms（${o.sampleHz} Hz・実測の平均 ${o.dt} s）`,
   o.sampleHz === 10 && Math.abs((o.dt ?? 0) - 0.1) <= 0.002, `${o.sampleHz} Hz / ${o.dt} s`);
ok('繰り返しなし: 末尾まで行くと止まる', o.step[0][0] === 1 && o.step[0][1] === true && o.step[1][1] === false, JSON.stringify(o.step));
ok('キュー全体: 末尾の次は先頭へ戻る', o.step[2][0] === 0 && o.step[2][1] === true, JSON.stringify(o.step[2]));
ok('1 ロット: 同じロットを繰り返す', o.step[3][0] === 0 && o.step[3][1] === true, JSON.stringify(o.step[3]));
ok('板からはみ出していない（横）', o.fit.panelOverflowX <= 1 && o.fit.ctlOverflowX <= 1 && o.fit.bodyOverflowX <= 1, JSON.stringify(o.fit));
ok(`見出しと操作列が重ならない（${o.fit.headerOverlap} px）`, o.fit.headerOverlap <= 1, o.fit.headerOverlap);

console.log(JSON.stringify({ store: o.storeKind, xlsx: o.xlsx, sampleHz: o.sampleHz, dt: o.dt, series: o.series }, null, 1));
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} ${bad.length ? 'FAIL' : 'PASS'}`);
process.exit(bad.length ? 1 : 0);
