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
     * 圧延中に «形» が描けていることを見る。
     *
     * 見るものは 2 つ（反り／板厚）で、既定は «反り»。反りの図は «板そのもの» を描いて
     * 定規を板の両端へ載せる向きにしてある —— 隙間だけを描くと上反りが下向きに
     * 膨らんで見えるため（それを直したのがこの検査の主目的）。向きが逆に戻っていないか、
     * 縦の拡大に下限が効いているか（反り 0 に近い板が «大反り» に見えないか）まで測る。 */
    const sm = await page.evaluate(() => new Promise(res => setTimeout(() => {
      const A = window.__app, P = A.physics;
      const defMode = A.ui.shapeMonMode;                       // 何も触っていないときのモード
      const defBtn = [...document.querySelectorAll('#sm-mode button')]
        .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.m).join(',');
      A.ui.setShapeMon(false);
      const off = document.getElementById('shape-mon').hidden;
      A.ui.setShapeMon(true);
      window.__startAuto(false);
      window.__ff((p) => p.slab.rollingActive && p.mill.passIndex >= 3, 120 * 900, 8);
      A.ui._shapeMon(P.slab);
      const box = document.getElementById('shape-mon'), r = box.getBoundingClientRect();
      const met = document.getElementById('metrics').getBoundingClientRect();
      const d = (id, cls) => (document.querySelector(`#${id} .${cls}`)?.getAttribute('d') || '').length;
      /* 反りの図から «板の形» を読む。path の各点の画面 y（下ほど大きい）と、定規の y。
       *   ends … 板の端（＝ 定規に触れる側）／ mid … 板の中央 */
      const geom = (id) => {
        const pa = document.querySelector(`#${id} .f-warp`), ru = document.querySelector(`#${id} .f-rule`);
        if (!pa || !ru) return null;
        const ys = [...(pa.getAttribute('d') || '').matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(m => +m[1]);
        return { cls: pa.getAttribute('class'), n: ys.length, end: ys[0], mid: ys[ys.length >> 1],
                 rule: +ru.getAttribute('y1'), gap: document.querySelector(`#${id} .f-gap`)?.getAttribute('class') };
      };
      /* 曲率を指定した «作り板» で、向きと拡大の下限を測る。実機の反りは向きも大きさも
       * 選べないので、ここだけは値を置いて確かめる。 */
      const fake = (k, kw) => ({ thickness: 16, width: 1330, length: 30000, alloy: P.slab.alloy,
        warp: { kappa: k, kappaW: kw, len: k * 1e6 / 8, wid: kw * 1330 * 1330 / 8, prof: 1,
                R: Math.abs(k) > 1e-9 ? 1 / Math.abs(k) / 1000 : Infinity } });
      const shot = (k, kw) => { A.ui._shapeMon(fake(k, kw)); return { w: geom('sm-wid'), l: geom('sm-len') }; };
      A.ui.setShapeMonMode('warp');
      const live = { w: geom('sm-wid'), l: geom('sm-len'),
                     wnum: document.getElementById('sm-wnum').textContent,
                     lnum: document.getElementById('sm-lnum').textContent };
      const up = shot(+1.6e-6, +2.3e-7);       // 丈 +0.20 mm（上反り）／幅 +0.20 mm
      const dn = shot(-1.6e-6, -2.3e-7);       // 同じ大きさで逆向き
      const tiny = shot(8e-9, 1.1e-9);         // 丈 0.001 mm —— ほぼ真っ直ぐ
      // 切替ボタンを実際に押す（クリックで状態が移るか）
      document.querySelector('#sm-mode button[data-m="gauge"]').click();
      const gMode = A.ui.shapeMonMode;
      A.ui._shapeMon(P.slab);
      const g = { widTop: d('sm-wid', 'f-top'), widBot: d('sm-wid', 'f-bot'),
                  lenTop: d('sm-len', 'f-top'), lenBot: d('sm-len', 'f-bot'),
                  warp: document.querySelectorAll('#shape-mon .f-warp').length,
                  wnum: document.getElementById('sm-wnum').textContent,
                  lnum: document.getElementById('sm-lnum').textContent };
      document.querySelector('#sm-mode button[data-m="warp"]').click();
      const back = A.ui.shapeMonMode;
      res({ off, on: !box.hidden, defMode, defBtn, gMode, back, live, up, dn, tiny, g,
            inView: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1,
            overMet: r.bottom > met.top + 1 && r.top < met.bottom - 1 });
    }, 400)));
    const bow = (x) => Math.abs(x.mid - x.end);                // 板の «たわみ» の画面上の大きさ [px]
    ok('板の形状モニタが出し入れできる', sm.off && sm.on, `OFF → ${sm.off ? '隠れる' : '隠れない'} ／ ON → ${sm.on ? '出る' : '出ない'}`);
    ok('形状モニタが画面の中に収まり、計器バーと重ならない', sm.inView && !sm.overMet,
       `画面内 ${sm.inView} ／ 計器バーと重なり ${sm.overMet ? 'あり' : 'なし'}`);
    ok('既定で «反り» が出る（主に見たいのは反りなので）', sm.defMode === 'warp' && sm.defBtn === 'warp',
       `既定 ${sm.defMode} ／ 押されているボタン ${sm.defBtn || 'なし'}`);
    ok('反りモードで幅・丈とも «板» と «定規» が描けている',
       sm.live.w && sm.live.l && sm.live.w.n > 8 && sm.live.l.n > 8 && isFinite(sm.live.w.rule) && isFinite(sm.live.l.rule),
       `幅 ${sm.live.w?.n ?? 0} 点（${sm.live.wnum}）／ 丈 ${sm.live.l?.n ?? 0} 点（${sm.live.lnum}）`);
    /* 上反り ＝ 端が上がる。画面 y は下ほど大きいので «中央の y ＞ 端の y»。
     * 定規は板の両端に載るので、定規の y は端の y と一致する。 */
    ok('上反りは «端が上がった» 形に描かれ、定規はその端に載る',
       sm.up.l.mid > sm.up.l.end + 5 && Math.abs(sm.up.l.rule - sm.up.l.end) < 1.5 && /\bup\b/.test(sm.up.l.cls),
       `中央 y ${sm.up.l.mid} ／ 端 y ${sm.up.l.end} ／ 定規 y ${sm.up.l.rule}（${sm.up.l.cls}）`);
    ok('下反りは上反りの «上下逆» に描かれる',
       sm.dn.l.mid < sm.dn.l.end - 5 && Math.abs(sm.dn.l.rule - sm.dn.l.end) < 1.5 && /\bdn\b/.test(sm.dn.l.cls)
       && Math.abs(bow(sm.dn.l) - bow(sm.up.l)) < 2,
       `中央 y ${sm.dn.l.mid} ／ 端 y ${sm.dn.l.end}（${sm.dn.l.cls}）／ たわみ 上反り ${bow(sm.up.l).toFixed(1)} ＝ 下反り ${bow(sm.dn.l).toFixed(1)} px`);
    ok('幅方向も同じ向きの決まりで描かれる（＋は樋状 ＝ 両耳が上がる）',
       sm.up.w.mid > sm.up.w.end + 5 && sm.dn.w.mid < sm.dn.w.end - 5,
       `＋ 中央 y ${sm.up.w.mid} ＞ 端 y ${sm.up.w.end} ／ − 中央 y ${sm.dn.w.mid} ＜ 端 y ${sm.dn.w.end}`);
    ok('反りが極小の板は «まっすぐ» に描かれる（縦の拡大に下限がある）',
       bow(sm.tiny.l) < 2 && bow(sm.up.l) > 25,
       `0.001 mm → ${bow(sm.tiny.l).toFixed(1)} px ／ 0.20 mm → ${bow(sm.up.l).toFixed(1)} px（箱の内寸 50 px）`);
    ok('«板厚» に切り替えると断面（上面・下面）になり、反りの線は消える',
       sm.gMode === 'gauge' && sm.g.widTop > 40 && sm.g.widBot > 40 && sm.g.lenTop > 40 && sm.g.lenBot > 40 && sm.g.warp === 0,
       `幅 上面 ${sm.g.widTop} / 下面 ${sm.g.widBot} 文字（${sm.g.wnum}）／ 丈 上面 ${sm.g.lenTop} / 下面 ${sm.g.lenBot} 文字（${sm.g.lnum}）／ 反りの線 ${sm.g.warp} 本`);
    ok('切替ボタンで «反り» へ戻れる', sm.back === 'warp', `戻り先 ${sm.back}`);

    /* 実績データ（測っていただきたいもの）。一覧が出ること・画面に収まること・
     * テンプレートが本当にファイルとして出ること・記入したものを読み戻せることを見る。
     * «出して → 記入して → 読み戻す» が通らないとテンプレートは飾りになる。 */
    const rq = await page.evaluate(async () => {
      const A = window.__app, D = window.__DATAREQ, $ = (id) => document.getElementById(id);
      // 出したファイルを掴まえる（実際のダウンロードはしない）
      const blobs = [];
      const realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test'; };
      HTMLAnchorElement.prototype.click = function () {};
      A.ui.openReqDialog();
      const box = $('dlg-req').getBoundingClientRect();
      const items = $('dlg-req').querySelectorAll('.rq').length;
      const heads = [...$('dlg-req').querySelectorAll('.rq-g > h4')].map(h => h.textContent);
      $('btn-req-tpl').click();
      const blob = blobs[blobs.length - 1];
      const text = blob ? await blob.text() : '';
      /* Blob.text() は先頭の BOM を «取り除いて» 返すので、BOM があるかは生のバイトで見る
       * —— 文字列で見ると «BOM を付けていない» のと区別が付かない。 */
      const head3 = blob ? new Uint8Array((await blob.arrayBuffer()).slice(0, 3)) : new Uint8Array();
      const bom = head3[0] === 0xef && head3[1] === 0xbb && head3[2] === 0xbf;
      // 記入欄をすべて «実績» にして値を入れ、読み込みの経路そのものを通す
      const filled = D.parse(text).map((c, i) => {
        if (i === 0 || c[0] !== window.__CFG.DATAREQ.KIND_BLANK) return c;
        const d = c.slice(); d[0] = window.__CFG.DATAREQ.KIND_REAL; d[8] = '1'; return d;
      }).map(c => c.map(D.cell).join(',')).join('\r\n');
      await A.ui.reqRead(new File(['﻿' + filled], 'x.csv', { type: 'text/csv' }));
      const got = $('dlg-req').querySelectorAll('.rq.has').length;
      const readTx = $('req-read').textContent;
      const count = $('req-count').textContent;
      $('dlg-req').close();
      URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
      return { items, heads, n: D.ids.length, blobs: blobs.length, bytes: text.length,
               csv: text.replace(/^\ufeff/, '').startsWith('種別,'), bom, got, readTx, count,
               inView: box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.top >= -1,
               w: Math.round(box.width), h: Math.round(box.height) };
    });
    ok('実績データの一覧が «測っていただきたいもの» を全部出す', rq.items === rq.n,
       `${rq.items} / ${rq.n} 件 ／ 分類 ${rq.heads.length} 区分`);
    ok('実績データが画面に収まる', rq.inView, `${rq.w} × ${rq.h} px`);
    ok('テンプレートが CSV として出る（Excel 用の BOM つき）',
       rq.blobs === 1 && rq.csv && rq.bom && rq.bytes > 800,
       `${rq.blobs} 本 ／ ${rq.bytes} 文字 ／ 見出し ${rq.csv ? 'あり' : 'なし'} ／ BOM ${rq.bom ? 'あり' : 'なし'}`);
    ok('記入したものを読み込むと、読めた項目が一覧で分かる', rq.got === rq.n,
       `読み込み済みの表示 ${rq.got} / ${rq.n} 件 ／ ${rq.count}`);
    ok('読み込みの結果に «読めた行数» が出る', /行/.test(rq.readTx), rq.readTx.slice(0, 80));

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
      const byMat = find('52S');                      // 代表材（社内記号）で引ける
      /* 材質マスタの橋渡しが効いていれば JIS 記号でも引ける。«A5052 のソーキングは？»
       * と探す人は 52S を知らない —— 探させないための橋渡しがこれ。 */
      const byJis = find('A5052');
      const jisIds = [...$('soak-list').querySelectorAll('.pat')].map(b => b.dataset.id);
      const none = find('該当しないはずの語zzz');
      find('52S');
      $('soak-list').querySelector('.pat').click();
      // 対象材の表の «JIS» 欄（最終列）に記号が出ている行の数
      const jisCol = [...$('soak-detail').querySelectorAll('table')]
        .filter(t => [...t.querySelectorAll('th')].some(h => h.textContent.trim() === 'JIS'))
        .flatMap(t => [...t.querySelectorAll('tbody tr')])
        .filter(r => { const c = r.lastElementChild; return c && !['–', ''].includes(c.textContent.trim()); }).length;
      find('');
      const second = $('soak-list').querySelectorAll('.pat')[1];
      const id2 = second.dataset.id; second.click();
      const head = $('soak-detail').querySelector('.dv')?.textContent || '';
      A.ui.toggleSoak(false);
      return { n0, det0, byMat, byJis, jisIds, jisCol, none, id2, head,
               inView: box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.top >= -1,
               w: Math.round(box.width), h: Math.round(box.height),
               nPat: window.__SOAK ? window.__SOAK.ids.length : 0 };
    });
    ok('ソーキングマスタが画面に収まり、全パターンが出る',
       sk.inView && sk.n0 > 30 && sk.det0 > 400,
       `${sk.w} × ${sk.h} px ／ ${sk.n0} パターン ／ 中身 ${sk.det0} 文字`);
    ok('ソーキングマスタが «代表材» でも探せる', sk.byMat > 0 && sk.byMat < sk.n0 && sk.none === 0,
       `«52S» で ${sk.byMat} 件 ／ 当たらない語で ${sk.none} 件`);
    ok('ソーキングマスタが «JIS 記号» でも探せる（材質マスタの橋渡しが効いている）',
       sk.byJis > 0 && sk.byJis < sk.n0 && sk.jisIds.includes('A'),
       `«A5052» で ${sk.byJis} 件（${sk.jisIds.join('・') || 'なし'}）`);
    ok('代表材の «JIS» 欄が表に出ている', sk.jisCol > 0, `JIS 欄に記号が出ている行 ${sk.jisCol} 件`);
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
