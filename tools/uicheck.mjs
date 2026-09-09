// UI の «崩れない» ことを機械で確かめる: ツールバーが 1 行か、«切れている» 部品が無いか、
// 状態行・計器・主操作の位置がメッセージの長さで動かないか、JS エラーが無いか。
// 画面幅とメニューの開閉を変えて測る。
//
// アイコンの幅について: 評価器は Font Awesome を読み込まないので、字形は出ない。ただし
// 空の CSS を返すと «幅ゼロ» になり、実機と 190 px も食い違う（それで «右端が切れる» のを
// 長らく見逃していた）。harness.mjs が 1 em の箱として置き換えている。
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
    /* «切れていない» は目で見えるとおりに測る: 中身の幅が枠の内寸を超えていないか（overflow:hidden で
     * 黙って消えるのはこれ）と、どのボタンも枠と画面の内側に収まっているか。 */
    const tbEl = document.getElementById('toolbar');
    const clipW = tbEl.scrollWidth - tbEl.clientWidth;
    const cut = [...document.querySelectorAll('#hud-top button')].filter(b => {
      const q = b.getBoundingClientRect(), host = b.closest('#toolbar') || document.getElementById('hud-top');
      const h = host.getBoundingClientRect();
      return q.right > h.right + 1 || q.left < h.left - 1 || q.right > innerWidth + 1 || q.width < 1;
    }).map(b => b.id || b.textContent.trim().slice(0, 8));
    const logPill = box('tb-log'), fit = tbEl.dataset.fit;
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
    return { tbH: tb.height, rows, overflow, tbW: tb.width, clipW, cut, fit,
             logIn: logPill.right <= innerWidth - 1 && logPill.left > 0 && logPill.width > 40,
             logW: logPill.width,
             same: start0.top === start1.top && tabs0.top === tabs1.top && st0.top === st1.top && met0.top === met1.top && start0.top === start2.top,
             stH: st1.height, gap: met0.top - st0.bottom, hudBottom: tb.bottom, stTop: st0.top };
  });
  console.log(`--- ${w} px ---`);
  ok('ツールバーが 1 行に収まる', r.rows === 1 && !r.overflow, `${r.rows === 1 ? '1 行' : '折返しあり'} 幅 ${r.tbW.toFixed(0)} px`);
  ok('上部メニューが «見切れ» ていない（枠からはみ出す部品が無い）', r.clipW <= 1 && r.cut.length === 0,
     r.cut.length ? `切れている: ${r.cut.join(' / ')}（はみ出し ${r.clipW.toFixed(0)} px）` : `畳み段階 ${r.fit}・はみ出し 0 px`);
  ok('«実績» が常に押せる位置に出ている', r.logIn, `幅 ${r.logW.toFixed(0)} px`);
  ok('メッセージの長さで主操作・タブ・状態行・計器の位置が動かない', r.same);
  ok('状態行の高さが固定', Math.abs(r.stH - 36) < 1, `${r.stH.toFixed(0)} px`);
  ok('状態行と計器が重ならない', r.gap >= 4, `${r.gap.toFixed(0)} px`);
  ok('ツールバーと状態行が重ならない', r.hudBottom < r.stTop);
  ok('JS エラーなし', errors.length === 0, errors.slice(0, 3).join(' | '));
  // メニューをたたむと使える幅が 372 px 増える。畳み具合が «画面の幅» ではなく
  // «使える幅» で決まっていることを、たたんだ状態でも切れていないことで確かめる
  const c = await page.evaluate(() => {
    const A = window.__app, tb = document.getElementById('toolbar');
    A.ui.setSidebar(false);
    const collapsed = { fit: tb.dataset.fit, clip: tb.scrollWidth - tb.clientWidth, w: tb.scrollWidth };
    A.ui.setSidebar(true);
    const open = { fit: tb.dataset.fit, clip: tb.scrollWidth - tb.clientWidth, w: tb.scrollWidth };
    return { collapsed, open };
  });
  ok('メニューをたたんでも切れない', c.collapsed.clip <= 1, `畳み段階 ${c.collapsed.fit}・内容 ${c.collapsed.w} px`);
  ok('メニューをたたむと畳み具合がゆるむ（使える幅で決めている）',
     +c.collapsed.fit <= +c.open.fit && (c.collapsed.w >= c.open.w),
     `たたむ ${c.collapsed.fit}（${c.collapsed.w} px）／ 開く ${c.open.fit}（${c.open.w} px）`);
  await browser.close();
}
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
