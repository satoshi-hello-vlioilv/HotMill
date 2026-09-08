// UI の «崩れない» ことを機械で確かめる: ツールバーが 1 行か、状態行・計器・主操作の位置が
// メッセージの長さで動かないか、JS エラーが無いか。画面幅を変えて測る。
//   node tools/uicheck.mjs
import { openApp, installHelpers } from './harness.mjs';
const widths = [1920, 1728, 1536, 1280];
let failed = 0;
const ok = (n, p, d = '') => { console.log(`  ${p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`); if (!p) failed++; };
for (const w of widths) {
  const { browser, page, errors } = await openApp({ viewport: { width: w, height: Math.round(w * 9 / 16) }, quiet: true });
  await installHelpers(page);
  const r = await page.evaluate(() => {
    const A = window.__app, box = (id) => document.getElementById(id).getBoundingClientRect();
    const tb = box('toolbar'), chips = [...document.querySelectorAll('#toolbar button')].map(b => b.getBoundingClientRect());
    // «行» は、あるボタンの上端が別のボタンの下端より下にあるときだけ増える（高さの違いは行ではない）
    let rows = 1; for (const a of chips) for (const b of chips) if (a.top >= b.bottom - 2) { rows = 2; }
    const start0 = box('btn-start'), tabs0 = box('tabs'), st0 = box('status-banner'), met0 = box('metrics');
    // 長いメッセージを入れても位置が変わらないこと
    A.ui.toast('これは長い通知のテストです。'.repeat(6), 'warn');
    document.getElementById('sb-hint').textContent = '長い説明文 '.repeat(40);
    const start1 = box('btn-start'), tabs1 = box('tabs'), st1 = box('status-banner'), met1 = box('metrics');
    const overflow = tb.right > innerWidth || [...document.querySelectorAll('#toolbar button')].some(b => b.getBoundingClientRect().right > tb.right + 1);
    // タブ切替で主操作の位置が動かないこと
    A.ui.selectTab('view'); const start2 = box('btn-start'); A.ui.selectTab('prep');
    return { tbH: tb.height, rows, overflow, tbW: tb.width,
             same: start0.top === start1.top && tabs0.top === tabs1.top && st0.top === st1.top && met0.top === met1.top && start0.top === start2.top,
             stH: st1.height, gap: met0.top - st0.bottom, hudBottom: tb.bottom, stTop: st0.top };
  });
  console.log(`--- ${w} px ---`);
  ok('ツールバーが 1 行に収まる', r.rows === 1 && !r.overflow, `${r.rows === 1 ? '1 行' : '折返しあり'} 幅 ${r.tbW.toFixed(0)} px`);
  ok('メッセージの長さで主操作・タブ・状態行・計器の位置が動かない', r.same);
  ok('状態行の高さが固定', Math.abs(r.stH - 36) < 1, `${r.stH.toFixed(0)} px`);
  ok('状態行と計器が重ならない', r.gap >= 4, `${r.gap.toFixed(0)} px`);
  ok('ツールバーと状態行が重ならない', r.hudBottom < r.stTop);
  ok('JS エラーなし', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
