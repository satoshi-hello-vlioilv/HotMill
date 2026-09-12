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
      // 畳まれているポップオーバーの中身は «見えていない» のだから、切れようがない
      if (b.closest('[hidden]')) return false;
      const q = b.getBoundingClientRect(), host = b.closest('#toolbar') || document.getElementById('hud-top');
      const h = host.getBoundingClientRect();
      return q.right > h.right + 1 || q.left < h.left - 1 || q.right > innerWidth + 1 || q.width < 1;
    }).map(b => b.id || b.textContent.trim().slice(0, 8));
    const logPill = box('tb-log'), fit = tbEl.dataset.fit;
    /* «使える幅» に対する余り。ツールバー自身は内容に合わせて縮む箱なので、
     * clientWidth を見ても常にちょうどになる。上部バーの幅から右端のピルを引いて測る。 */
    const hudEl = document.getElementById('hud-top');
    const gapPx = parseFloat(getComputedStyle(hudEl).columnGap) || parseFloat(getComputedStyle(hudEl).gap) || 0;
    const pills = [...hudEl.children].filter(c => c !== tbEl && !c.hidden)
      .reduce((a, c) => a + c.getBoundingClientRect().width, 0);
    const slack = hudEl.clientWidth - pills - gapPx * Math.max(hudEl.children.length - 1, 0) - tbEl.scrollWidth;
    const zoneNm = document.querySelector('#tb-zones .nm');
    const zoneLabelShown = !!zoneNm && zoneNm.getBoundingClientRect().width > 1;
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
    return { tbH: tb.height, rows, overflow, tbW: tb.width, clipW, cut, fit, slack: Math.round(slack), zoneLabelShown,
             logIn: logPill.right <= innerWidth - 1 && logPill.left > 0 && logPill.width > 40,
             logW: logPill.width,
             same: start0.top === start1.top && tabs0.top === tabs1.top && st0.top === st1.top && met0.top === met1.top && start0.top === start2.top,
             stH: st1.height, gap: met0.top - st0.bottom, hudBottom: tb.bottom, stTop: st0.top };
  });
  console.log(`--- ${w} px ---`);
  ok('ツールバーが 1 行に収まる', r.rows === 1 && !r.overflow, `${r.rows === 1 ? '1 行' : '折返しあり'} 幅 ${r.tbW.toFixed(0)} px`);
  ok('上部メニューが «見切れ» ていない（枠からはみ出す部品が無い）', r.clipW <= 1 && r.cut.length === 0,
     r.cut.length ? `切れている: ${r.cut.join(' / ')}（はみ出し ${r.clipW.toFixed(0)} px）` : `畳み段階 ${r.fit}・はみ出し 0 px`);
  /* «ぎりぎり» を通さない。アイコンフォントの実寸は環境で数 px 変わるので、
   * 余りが 10 px 未満なら実機では切れる（実際、右端の «区分記号» が切れていた）。 */
  ok('上部メニューに余白がある（ぎりぎりではない）', r.slack >= 10, `余り ${r.slack} px・畳み段階 ${r.fit}`);
  if (w >= 1728) ok('この画面幅では «区分記号» の文字が出ている', r.zoneLabelShown, r.zoneLabelShown ? '文字あり' : '記号だけ');
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
  /* 計器バーは «問い» ごとの 5 枚。中身が増えても減っても外形（位置と大きさ）は
   * 動かないこと —— 運転中に 3D の見える範囲が変わると、目で追っているものを見失う。
   * 値をわざと «長い文字列» や «空» に振って、札の外形が動かないかを実測する。 */
  const m = await page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    const bar = document.getElementById('metrics');
    const cards = [...bar.children];
    const before = { bar: box(bar), cards: cards.map(box) };
    // 副値をすべて «とても長い文字列» にする（実運転では出ないが、外形が動かないことの上限）
    const subs = [...bar.querySelectorAll('.mx span, .mx b, .val .mode, .val u')];
    const keep = subs.map(e => e.textContent);
    subs.forEach(e => { e.textContent = '長い値'.repeat(6); });
    const longer = { bar: box(bar), cards: cards.map(box) };
    subs.forEach(e => { e.textContent = ''; });                 // 逆に «全部空»
    const empty = { bar: box(bar), cards: cards.map(box) };
    subs.forEach((e, i) => { e.textContent = keep[i]; });
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
    return { n: cards.length, before,
             barStable: same(before.bar, longer.bar) && same(before.bar, empty.bar),
             cardStable: cards.every((_, i) => same(before.cards[i], longer.cards[i]) && same(before.cards[i], empty.cards[i])),
             longer, empty,
             overflow: cards.map(c => Math.max(0, c.scrollHeight - c.clientHeight)) };
  });
  ok(`計器バーが «問い» ごとの ${m.n} 枚にまとまっている`, m.n === 5, `${m.n} 枚（1 枚 ${Math.round(m.before.cards[0][2])} px）`);
  ok('値をいくら長くしても計器バーの外形が動かない', m.barStable,
     `枠 ${m.before.bar.join(',')} ／ 長い値 ${m.longer.bar.join(',')} ／ 空 ${m.empty.bar.join(',')}`);
  ok('値が増減しても札 1 枚ずつの外形が動かない', m.cardStable,
     m.cardStable ? `${m.n} 枚とも同じ` : m.before.cards.map((b, i) => `${i}: ${b.join(',')} → ${m.longer.cards[i].join(',')}`).filter((_, i) => true).slice(0, 2).join(' ／ '));
  ok('札からはみ出した中身は隠れる（外へ押し出さない）', m.overflow.every(v => v >= 0),
     `はみ出し ${m.overflow.join(' / ')} px（隠す設計）`);
  /* 実績ビュワーの «横軸スケール» と «4 辺 4 隅のサイズ変更»。
   * どちらも «目で見て確かめる» しかない類の機能なので、実際に掴んで動かして測る。 */
  if (w === 1728) {
    const pn = await page.evaluate(() => new Promise(res => setTimeout(() => {
      const A = window.__app, $ = (id) => document.getElementById(id);
      window.__startAuto(false);
      window.__ff((p) => p.mill.passIndex >= 2, 120 * 400, 0);
      $('pnl-log').hidden = false; A.ui.renderLog();
      const host = $('log-chart'), sl = $('log-zoom');
      const svgW = () => { const s = host.querySelector('svg'); return s ? +s.getAttribute('width') : 0; };
      const box = host.clientWidth, w1 = svgW();
      sl.value = '5'; sl.dispatchEvent(new Event('input', { bubbles: true }));
      const w5 = svgW(), scroll5 = host.scrollWidth > host.clientWidth + 1;
      $('log-zoom-fit').click();
      const wFit = svgW();
      const p = $('pnl-log');
      const dirs = [...p.querySelectorAll('[data-rz]')].map(e => e.dataset.rz).sort();
      const plan = [...document.querySelectorAll('#pnl-plan [data-rz]')].map(e => e.dataset.rz).sort();
      // 掴んだ辺«だけ»が動くこと（北西を掴んだら右下は動かない）
      const grab = (dir, dx, dy) => {
        const r = p.getBoundingClientRect(), g = p.querySelector(`[data-rz="${dir}"]`);
        const x = dir.includes('w') ? r.left + 2 : dir.includes('e') ? r.right - 2 : (r.left + r.right) / 2;
        const y = dir.includes('n') ? r.top + 2 : dir.includes('s') ? r.bottom - 2 : (r.top + r.bottom) / 2;
        g.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
        dispatchEvent(new PointerEvent('pointermove', { clientX: x + dx, clientY: y + dy, bubbles: true }));
        dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        const q = p.getBoundingClientRect();
        return { l: Math.round(q.left - r.left), t: Math.round(q.top - r.top),
                 r: Math.round(q.right - r.right), b: Math.round(q.bottom - r.bottom) };
      };
      const nw = grab('nw', 60, 40), se = grab('se', -50, -30), e = grab('e', -40, 0);
      res({ box, w1, w5, wFit, scroll5, dirs, plan, nw, se, e });
    }, 400)));
    ok('グラフの横軸スケールが 1 倍で枠ちょうど', Math.abs(pn.w1 - pn.box) <= 1, `SVG ${pn.w1} / 枠 ${pn.box} px`);
    ok('横軸スケールを上げると中身だけが伸びて横スクロールになる',
       Math.abs(pn.w5 - pn.box * 5) <= 2 && pn.scroll5, `5 倍で SVG ${pn.w5} px・スクロール ${pn.scroll5 ? 'あり' : 'なし'}`);
    ok('«全体» で 1 倍に戻る', Math.abs(pn.wFit - pn.box) <= 1, `SVG ${pn.wFit} px`);
    ok('サイズ変更の掴み手が 4 辺 4 隅の 8 つある（両方の板）',
       pn.dirs.join(',') === 'e,n,ne,nw,s,se,sw,w' && pn.plan.join(',') === 'e,n,ne,nw,s,se,sw,w',
       `実績 ${pn.dirs.join(' ')} ／ 計画 ${pn.plan.join(' ')}`);
    ok('北西の隅を掴むと左上だけが動く（右下は動かない）',
       pn.nw.l > 0 && pn.nw.t > 0 && pn.nw.r === 0 && pn.nw.b === 0,
       `左 ${pn.nw.l} / 上 ${pn.nw.t} / 右 ${pn.nw.r} / 下 ${pn.nw.b} px`);
    ok('南東の隅を掴むと右下だけが動く（左上は動かない）',
       pn.se.r < 0 && pn.se.b < 0 && pn.se.l === 0 && pn.se.t === 0,
       `左 ${pn.se.l} / 上 ${pn.se.t} / 右 ${pn.se.r} / 下 ${pn.se.b} px`);
    ok('右の辺を掴むと «右» だけが動く（上下は動かない）',
       pn.e.r < 0 && pn.e.t === 0 && pn.e.b === 0 && pn.e.l === 0,
       `左 ${pn.e.l} / 上 ${pn.e.t} / 右 ${pn.e.r} / 下 ${pn.e.b} px`);

    /* 板の形状モニタ。出せること・画面の中に収まること・計器バーと重ならないこと・
     * 圧延中に «形» が描けていること（空の SVG になっていないこと）を見る。 */
    const sm = await page.evaluate(() => new Promise(res => setTimeout(() => {
      const A = window.__app, P = A.physics;
      A.ui.setShapeMon(false);
      const off = document.getElementById('shape-mon').hidden;
      A.ui.setShapeMon(true);
      window.__startAuto(false);
      window.__ff((p) => p.slab.rollingActive && p.mill.passIndex >= 3, 120 * 900, 8);
      A.ui._shapeMon(P.slab);
      const box = document.getElementById('shape-mon'), r = box.getBoundingClientRect();
      const met = document.getElementById('metrics').getBoundingClientRect();
      const d = (id, cls) => (document.querySelector(`#${id} .${cls}`)?.getAttribute('d') || '').length;
      res({ off, on: !box.hidden,
            inView: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1,
            overMet: r.bottom > met.top + 1 && r.top < met.bottom - 1,
            widTop: d('sm-wid', 'f-top'), widBot: d('sm-wid', 'f-bot'),
            lenTop: d('sm-len', 'f-top'), lenBot: d('sm-len', 'f-bot'),
            wnum: document.getElementById('sm-wnum').textContent,
            lnum: document.getElementById('sm-lnum').textContent });
    }, 400)));
    ok('板の形状モニタが出し入れできる', sm.off && sm.on, `OFF → ${sm.off ? '隠れる' : '隠れない'} ／ ON → ${sm.on ? '出る' : '出ない'}`);
    ok('形状モニタが画面の中に収まり、計器バーと重ならない', sm.inView && !sm.overMet,
       `画面内 ${sm.inView} ／ 計器バーと重なり ${sm.overMet ? 'あり' : 'なし'}`);
    ok('幅方向の断面（上面・下面）が描けている', sm.widTop > 40 && sm.widBot > 40,
       `上面 ${sm.widTop} / 下面 ${sm.widBot} 文字（${sm.wnum}）`);
    ok('丈方向の側面（上面・下面）が描けている', sm.lenTop > 40 && sm.lenBot > 40,
       `上面 ${sm.lenTop} / 下面 ${sm.lenBot} 文字（${sm.lnum}）`);

    /* 変更履歴ビュワー。36 版・466 項目を «探せる» ことが作り直しの目的なので、
     * 探す道具（検索・分類・版の選択）が実際に効くか、画面に収まるかを測る。 */
    const vv = await page.evaluate(() => {
      const A = window.__app, V = window.__VER, $ = (id) => document.getElementById(id);
      A.ui.toggleVersion(true);
      const box = $('dlg-ver').getBoundingClientRect();
      const rows = () => $('ver-log').querySelectorAll('.rel').length;
      const lis = () => $('ver-detail').querySelectorAll('li').length;
      const all = rows(), allLi = lis(), focus = document.activeElement?.id;
      // 検索 —— どの版にも出てこない語で 0 版、よく出る語で «全部より少ないが 0 ではない»
      const find = (q) => { const el = $('ver-q'); el.value = q; el.dispatchEvent(new Event('input')); return { r: rows(), li: lis() }; };
      const none = find('該当しないはずの語zzz');
      const some = find('ワニ口');
      const someTxt = $('ver-detail').textContent;
      find('');
      // 分類 —— 評価器だけに絞ると、右に出る項目が全て tools/ になる
      $('ver-kinds').querySelector('[data-k="eval"]').click();
      const kRows = rows();
      const kW = [...$('ver-detail').querySelectorAll('li .w')].map(e => e.textContent);
      $('ver-kinds').querySelector('[data-k="eval"]').click();
      // 版の選択 —— 2 つめの版を押すと右の見出しがその版になる
      const second = $('ver-log').querySelectorAll('.rel')[1];
      second.click();
      const head = $('ver-detail').querySelector('.dv')?.textContent || '';
      const want = V.PREFIX + second.dataset.v;
      $('ver-log').querySelectorAll('.rel')[0].click();
      // w に <title> のような値がある。タグとして解釈されていないこと
      const raw = $('ver-detail').innerHTML + $('ver-log').innerHTML;
      A.ui.toggleVersion(false);
      return { all, allLi, focus, none, some, kRows, kW, head, want,
               inView: box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.top >= -1,
               w: Math.round(box.width), h: Math.round(box.height),
               nVer: V.LOG.length, nItem: V.LOG.reduce((a, r) => a + r.items.length, 0),
               strayTitle: /<title>/i.test(raw), hitTxt: /ワニ口/.test(someTxt) };
    });
    ok('変更履歴ビュワーが画面に収まる', vv.inView, `${vv.w} × ${vv.h} px（${vv.nVer} 版 ${vv.nItem} 件）`);
    /* «開いていないダイアログは出ていない»。dialog に display を指で書くと、ブラウザ既定の
     * display:none を上書きして閉じたまま画面に出る（実際そうなっていた）。 */
    const closed = await page.evaluate(() => {
      const A = window.__app;
      A.ui.toggleVersion(false); A.ui.toggleSoak?.(false);
      const d = (id) => ({ open: document.getElementById(id).open,
                           disp: getComputedStyle(document.getElementById(id)).display });
      return { ver: d('dlg-ver'), soak: d('dlg-soak') };
    });
    ok('閉じているダイアログが画面に出ていない',
       closed.ver.disp === 'none' && closed.soak.disp === 'none',
       `変更履歴 ${closed.ver.disp} ／ ソーキングマスタ ${closed.soak.disp}`);
    /* ソーキングマスタ。39 の操業パターンが «絞って選んで読める» こと。 */
    const sk = await page.evaluate(() => {
      const A = window.__app, $ = (id) => document.getElementById(id);
      A.ui.toggleSoak(true);
      const box = $('dlg-soak').getBoundingClientRect();
      const n0 = $('soak-list').querySelectorAll('.pat').length;
      const det0 = $('soak-detail').textContent.length;
      const find = (q) => { const e = $('soak-q'); e.value = q; e.dispatchEvent(new Event('input'));
        return $('soak-list').querySelectorAll('.pat').length; };
      const byMat = find('52S');                      // 代表材で引ける
      const none = find('該当しないはずの語zzz');
      find('');
      const second = $('soak-list').querySelectorAll('.pat')[1];
      const id2 = second.dataset.id; second.click();
      const head = $('soak-detail').querySelector('.dv')?.textContent || '';
      A.ui.toggleSoak(false);
      return { n0, det0, byMat, none, id2, head,
               inView: box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.top >= -1,
               w: Math.round(box.width), h: Math.round(box.height),
               nPat: window.__SOAK ? window.__SOAK.ids.length : 0 };
    });
    ok('ソーキングマスタが画面に収まり、全パターンが出る',
       sk.inView && sk.n0 > 30 && sk.det0 > 400,
       `${sk.w} × ${sk.h} px ／ ${sk.n0} パターン ／ 中身 ${sk.det0} 文字`);
    ok('ソーキングマスタが «代表材» でも探せる', sk.byMat > 0 && sk.byMat < sk.n0 && sk.none === 0,
       `«52S» で ${sk.byMat} 件 ／ 当たらない語で ${sk.none} 件`);
    ok('操業パターンを押すと右がその中身になる', sk.head.trim() === sk.id2,
       `押した ${sk.id2} ／ 右の見出し ${sk.head.trim()}`);
    ok('開くとすぐ探せる（検索欄に焦点があり、先頭の版の中身が出ている）',
       vv.focus === 'ver-q' && vv.allLi > 0 && vv.all === vv.nVer,
       `焦点 ${vv.focus} / 版 ${vv.all} / 先頭の版の項目 ${vv.allLi} 件`);
    ok('検索が版と項目の両方を絞る',
       vv.none.r === 0 && vv.none.li === 0 && vv.some.r > 0 && vv.some.r < vv.nVer && vv.hitTxt,
       `当たらない語 ${vv.none.r} 版 ／ «ワニ口» ${vv.some.r} 版（選んだ版で ${vv.some.li} 件）`);
    ok('分類で絞ると、その分類の項目だけが出る',
       vv.kRows > 0 && vv.kRows <= vv.nVer && vv.kW.length > 0 && vv.kW.every(w => w.startsWith('tools/')),
       `評価器 ${vv.kRows} 版 ／ 出た項目 ${vv.kW.length} 件すべて tools/`);
    ok('版を押すと右がその版になる', vv.head.startsWith(vv.want), `押した版 ${vv.want} / 右の見出し ${vv.head.trim()}`);
    ok('w の «<title>» がタグとして解釈されていない', !vv.strayTitle, vv.strayTitle ? '生の <title> が混ざっている' : '文字として出ている');
  }
  await browser.close();
}
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
