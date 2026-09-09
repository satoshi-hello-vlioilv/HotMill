// 圧延実績（ロギング）が «実際に起きたこと» と合っているかを見る評価器。
//
// なぜ要るか: ログは «後から数字だけを見る» ためのものなので、間違っていても画面では
// 気づけない。物理の状態と突き合わせて、記録が現実とずれていないことを機械で縛る。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG;
  const R = { checks: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: d });
  const L = P.log;

  ok('運転前は記録が空', L.lot === null && L.passes.length === 0, `${L.passes.length} パス`);

  // 全パス走り切らせ、その間の «物理が指した最大値» を独立に拾っておく
  let fPeak = 0, vPeak = 0;
  window.__startAuto(false);
  window.__ff((p) => {
    fPeak = Math.max(fPeak, p.slab.rollForce || 0);
    vPeak = Math.max(vPeak, Math.abs(p.mill.currentSpeed));
    return p.mill.passIndex < 0 && p.log.passes.length >= K.SCHEDULE.length;
  }, 120 * 4000);

  const rows = L.rows, n = K.SCHEDULE.length;
  ok('パス数がスケジュールと一致', rows.length === n, `${rows.length} / ${n} パス`);
  ok('全パスが閉じている（所要時間が入る）', rows.every(r => r.sec !== null && r.sec > 0),
     `所要 ${rows.map(r => (r.sec ?? 0).toFixed(0)).join('/')} s`);

  // 板厚は «前のパスの出厚 = 次のパスの入厚» で繋がる
  const chain = rows.every((r, i) => i === 0 || Math.abs(r.hIn - rows[i - 1].hOut) < 0.05);
  ok('板厚が前のパスから連続している', chain,
     rows.map(r => `${r.hIn?.toFixed(0)}→${r.hOut?.toFixed(0)}`).join(' '));
  ok('入厚が素材の実厚から始まる', Math.abs(rows[0].hIn - L.lot.thick0) < 0.05,
     `${rows[0].hIn?.toFixed(1)} / 素材 ${L.lot.thick0.toFixed(1)} mm`);
  /* 記録は «スケジュールがそう決めた厚み» に一致していること。目標へ届くかどうかは
   * 素材とミルの能力の問題で（届かなければ画面が «テーブル長／荷重の制約で
   * ここまで» と警告する）、ロギングの正しさとは別の話。ここでは記録と計画の一致を見る。 */
  const lastPlan = K.SCHEDULE[K.SCHEDULE.length - 1]?.gap ?? K.SLAB.TARGET_TH;
  ok('最終の出厚がスケジュールの最終ギャップに一致',
     Math.abs(rows[n - 1].hOut - lastPlan) <= Math.max(lastPlan * 0.03, 0.3),
     `${rows[n - 1].hOut.toFixed(2)} / 計画 ${lastPlan} mm（目標 ${K.SLAB.TARGET_TH} mm）`);
  ok('圧下率がすべて正（各パスで薄くなる）', rows.every(r => r.red > 0),
     `${rows.map(r => r.red.toFixed(0)).join('/')} %`);

  // 記録した最大値は «物理が指した最大値» を超えない（作り話をしていない）
  const fMax = Math.max(...rows.map(r => r.fMax)), vMax = Math.max(...rows.map(r => r.vMax));
  ok('記録の最大荷重が実際の最大を超えない', fMax <= fPeak + 1, `記録 ${fMax.toFixed(0)} / 実際 ${fPeak.toFixed(0)} t`);
  ok('記録の最大速度が実際の最大を超えない', vMax <= vPeak + 0.5, `記録 ${vMax.toFixed(1)} / 実際 ${vPeak.toFixed(1)} mpm`);
  ok('平均荷重は最大荷重以下（噛んでいる間の平均）', rows.every(r => r.fAvg <= r.fMax + 1e-6 && r.fAvg > 0),
     `最大の差 ${Math.max(...rows.map(r => r.fMax - r.fAvg)).toFixed(0)} t`);

  // 時系列は時間の順に並び、パス番号が飛ばない
  const S = L.series;
  ok('時系列が時間の昇順', S.every((p, i) => i === 0 || p.t >= S[i - 1].t), `${S.length} 点`);
  ok('時系列の間隔が指定のサンプリング周期に収まる',
     S.every((p, i) => i === 0 || (p.t - S[i - 1].t) <= 1 / window.__app.physics.log.constructor.SAMPLE_HZ + 0.05),
     `最大間隔 ${Math.max(...S.map((p, i) => i ? p.t - S[i - 1].t : 0)).toFixed(3)} s`);

  // 時系列には «荷重・速度・板厚・ギャップ» が揃っている（ビュワーの 4 系列）
  ok('時系列が 4 系列（荷重・速度・板厚・ギャップ）を持つ',
     S.every(p => ['f', 'v', 'h', 'g'].every(k => typeof p[k] === 'number')),
     Object.keys(S[0]).join(' '));
  /* 反りと太り。パス行（そのパスで出来上がった形）と時系列の両方に入っていること。
   * 幅反りは長手の反りに «逆向きに» 従属するので、符号が反対であることまで見る。 */
  ok('パスごとに 丈反り・幅反り・プロファイルカーブ値 が記録される',
     rows.every(r => Number.isFinite(r.curlL) && Number.isFinite(r.curlW) && Number.isFinite(r.prof)),
     rows.slice(-3).map(r => `P${r.no} 丈 ${r.curlL.toFixed(2)} / 幅 ${r.curlW.toFixed(2)} / P ${r.prof.toFixed(4)}`).join(' ／ '));
  ok('幅反りは丈反りと逆向き（アンチクラスティック）',
     rows.filter(r => Math.abs(r.curlL) > 0.01).every(r => r.curlL * r.curlW < 0),
     `${rows.filter(r => Math.abs(r.curlL) > 0.01).length} パスで判定`);
  ok('プロファイルカーブ値が 1 のまわりの現実的な範囲（0.9〜1.1）',
     rows.every(r => r.prof > 0.9 && r.prof < 1.1),
     `${Math.min(...rows.map(r => r.prof)).toFixed(4)} 〜 ${Math.max(...rows.map(r => r.prof)).toFixed(4)}`);
  ok('時系列にも 丈反り・幅反り・プロファイル が入る',
     S.every(p => ['cl', 'cw', 'pc'].every(k => typeof p[k] === 'number')),
     `例 ${JSON.stringify({ cl: S[S.length >> 1].cl, cw: S[S.length >> 1].cw, pc: S[S.length >> 1].pc })}`);
  ok('ギャップが板厚以下（ミルばねを含めても出側が入側を超えない）',
     S.filter(p => p.f > 0).every(p => p.g <= p.h + 0.01),
     `最大の超過 ${Math.max(0, ...S.filter(p => p.f > 0).map(p => p.g - p.h)).toFixed(2)} mm`);

  /* CSV は «パス表» と «時系列» の 2 段。それぞれ見出しと列数が揃っていること。
   * 画面で絞り込んだパスだけを出せること（画面と別物が出るのがいちばん困る）。 */
  const lines = L.csv().split('\n');
  const cut = lines.findIndex(l => l.startsWith('# 時系列'));
  const body = lines.slice(0, cut).filter(l => l && !l.startsWith('#'));
  const ser = lines.slice(cut + 1).filter(l => l);
  ok('CSV がパス数ぶんの行を持つ', body.length === n + 1, `${body.length - 1} 行 + 見出し`);
  ok('CSV の列数が見出しと揃う', body.every(l => l.split(',').length === body[0].split(',').length),
     `${body[0].split(',').length} 列`);
  ok('CSV に時系列が入る', ser.length === S.length + 1, `${ser.length - 1} 点 + 見出し`);
  const one = L.csv(null, [2]).split('\n');
  const oneBody = one.slice(0, one.findIndex(l => l.startsWith('# 時系列'))).filter(l => l && !l.startsWith('#'));
  ok('CSV が画面で絞ったパスだけを出す', oneBody.length === 2, `${oneBody.length - 1} 行`);

  // 画面（表・グラフ・チップ）が記録と一致する
  A.ui.toggleLog(true);
  const tr = document.querySelectorAll('#log-table tbody tr');
  ok('画面の表が記録と同じ行数を描く', tr.length === n, `${tr.length} 行`);
  ok('時系列グラフが描かれている', !!document.querySelector('#log-chart svg path'),
     `${document.querySelectorAll('#log-chart svg path').length} 本の折れ線`);
  // チップの数は RollingLog.SERIES から決まる（系列を足すたびに検査を書き換えない）
  const nSeries = window.__app.physics.log.constructor.SERIES.length;
  ok(`項目チップが ${nSeries} つ出て、押すと系列が消える`, (() => {
    const chips = document.querySelectorAll('#log-series .chip');
    if (chips.length !== nSeries) return false;
    const before = document.querySelectorAll('#log-chart svg path').length;
    document.querySelector('#log-series .chip[data-k="g"]').click();
    const after = document.querySelectorAll('#log-chart svg path').length;
    document.querySelector('#log-series .chip[data-k="g"]').click();
    return after < before;
  })(), `${document.querySelectorAll('#log-series .chip').length} 項目`);
  ok('パスチップで絞ると表の他行が薄くなる', (() => {
    const c = document.querySelector('#log-passes .chip[data-p="2"]');
    if (!c) return false;
    c.click();
    const off = document.querySelectorAll('#log-table tbody tr.off').length;
    document.getElementById('log-pass-all').click();
    return off === n - 1;
  })(), `${n} パス中 1 パス表示`);
  /* ロットは «見比べる» のが目的なので、次のロットを始めても前のロットが消えないこと。
   * 2 本目を短く回して、履歴が 2 件になり、選び直すと表の中身が入れ替わることを見る。 */
  const before = L.lots.length, id0 = L.lots[0].lot.id;
  A.bus.emit('CMD_RESET');
  window.__startAuto(false);
  window.__ff(p => p.log.passes.length >= 2, 120 * 600);
  A.ui.renderLog();
  ok('次のロットを始めても前のロットが残る', L.lots.length === before + 1,
     `${before} → ${L.lots.length} ロット`);
  ok('ロット選択に履歴がすべて並ぶ',
     document.querySelectorAll('#log-lot-sel option').length === L.lots.length,
     `${document.querySelectorAll('#log-lot-sel option').length} 件`);
  ok('前のロットを選ぶと表がそのロットに入れ替わる', (() => {
    const sel = document.getElementById('log-lot-sel');
    const now = document.querySelectorAll('#log-table tbody tr').length;
    sel.value = String(id0); sel.dispatchEvent(new Event('change'));
    const old = document.querySelectorAll('#log-table tbody tr').length;
    return old === n && old !== now;
  })(), `${n} 行`);
  ok('項目チップが凡例を兼ねる（色と最大値がチップに出る）', (() => {
    const b = document.querySelector('#log-series .chip[data-k="f"]');
    return b && /最大/.test(b.textContent) && /rgb|#/.test(b.style.color);
  })(), document.querySelector('#log-series .chip[data-k="f"]')?.textContent.trim());
  ok('グラフをなぞると読み取り線とその時刻の値が出る', (() => {
    const h = document.getElementById('log-chart'), b = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointermove',
      { clientX: b.left + b.width * 0.55, clientY: b.top + b.height * 0.5, bubbles: true }));
    const c = document.getElementById('log-cross'), rd = document.getElementById('log-read');
    return c && !c.hidden && rd && !rd.hidden && /P\d/.test(rd.textContent);
  })(), document.getElementById('log-read')?.textContent.slice(0, 40));
  ok('表の行を押すとそのパスだけになる', (() => {
    const tr = document.querySelectorAll('#log-table tbody tr')[2];
    if (!tr) return false;
    tr.click();
    const one = A.ui.logPass.size === 1 && A.ui.logPass.has(3);
    document.getElementById('log-pass-all').click();
    return one;
  })(), 'クリック → 第 3 パスのみ');
  /* 見出しと操作列が «重ならない・はみ出さない» こと。項目が増えるとチップが折り返して
   * 下の段に重なり、読めなくなっていた（チップの高さを固定していたのが原因）。
   * 画面幅を狭めても崩れないか、板の幅を最小まで縮めて確かめる。 */
  {
    const pnl = document.getElementById('pnl-log');
    const boxes = () => [...pnl.querySelectorAll('.ctl > *, header .hd > *, header .btns > *')]
      .map(e => ({ id: e.id || e.className, r: e.getBoundingClientRect() })).filter(q => q.r.width > 0);
    const overlaps = () => { const b2 = boxes(), out = [];
      for (let i = 0; i < b2.length; i++) for (let j = i + 1; j < b2.length; j++) {
        const a2 = b2[i].r, c2 = b2[j].r;
        if (a2.right > c2.left + 1 && c2.right > a2.left + 1 && a2.bottom > c2.top + 1 && c2.bottom > a2.top + 1)
          out.push(`${b2[i].id} × ${b2[j].id}`);
      } return out; };
    const outside = () => { const p2 = pnl.getBoundingClientRect();
      return [...pnl.querySelectorAll('.ctl *, header *')].filter(e => { const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > p2.right + 1 || r.bottom > p2.bottom + 1 || r.left < p2.left - 1); })
        .map(e => e.id || e.className); };
    const wide = { over: overlaps(), out: outside() };
    pnl.style.width = pnl.style.minWidth = '520px';           // 最小幅まで縮める
    const narrow = { over: overlaps(), out: outside() };
    pnl.style.width = ''; pnl.style.minWidth = '';
    ok('見出しと操作列が重ならない', wide.over.length === 0 && narrow.over.length === 0,
       [...wide.over, ...narrow.over].slice(0, 3).join(' / ') || '重なり 0 件（広い・狭いの両方）');
    ok('見出しと操作列が板からはみ出さない', wide.out.length === 0 && narrow.out.length === 0,
       [...wide.out, ...narrow.out].slice(0, 3).join(' / ') || 'はみ出し 0 件（広い・狭いの両方）');
  }
  /* 表示タブ（グラフ＋表 / グラフ / 表）と、選ぶものを畳むポップオーバー。 */
  {
    A.ui.setLogShow('chart');
    const chartOnly = document.querySelector('#pnl-log .tblwrap').getBoundingClientRect().height === 0;
    A.ui.setLogShow('table');
    const tableOnly = document.querySelector('#pnl-log .chart').getBoundingClientRect().height === 0;
    A.ui.setLogShow('both');
    const both = document.querySelector('#pnl-log .tblwrap').getBoundingClientRect().height > 0
              && document.querySelector('#pnl-log .chart').getBoundingClientRect().height > 0;
    ok('表示タブでグラフだけ・表だけ・両方を切り替えられる', chartOnly && tableOnly && both,
       `グラフのみ ${chartOnly} / 表のみ ${tableOnly} / 両方 ${both}`);
    A.ui.toggleLogPop('log-series-pop');
    const opened = !document.getElementById('log-series-pop').hidden;
    A.ui.toggleLogPop('log-pass-pop');
    const swapped = document.getElementById('log-series-pop').hidden && !document.getElementById('log-pass-pop').hidden;
    A.ui.toggleLogPop(null);
    const closed = document.getElementById('log-pass-pop').hidden;
    ok('項目とパスのポップオーバーが 1 つずつ開く', opened && swapped && closed,
       `開く ${opened} / 入れ替え ${swapped} / 閉じる ${closed}`);
    ok('畳んでいても何を選んでいるかがボタンに出る',
       /\d+ *\/ *\d+/.test(document.getElementById('log-series-n').textContent)
       && document.getElementById('log-pass-n').textContent.length > 0,
       `項目 ${document.getElementById('log-series-n').textContent} ／ パス ${document.getElementById('log-pass-n').textContent}`);
  }
  ok('パネルはモーダルではない（3D を操作できる）',
     document.getElementById('pnl-log').tagName === 'SECTION' && !document.querySelector('dialog[open]#pnl-log'),
     document.getElementById('pnl-log').tagName);
  A.ui.toggleLog(false);
  R.summary = { passes: rows.length, samples: S.length, fMax: +fMax.toFixed(0), t: +L.lot.t.toFixed(0) };
  return R;
});

console.log(`  ロット: ${out.summary.passes} パス / 時系列 ${out.summary.samples} 点 / 最大荷重 ${out.summary.fMax} t / ${out.summary.t} s\n`);
for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name} — ${c.detail}`);
const bad = out.checks.filter(c => !c.pass).length;
console.log(`\nRESULT: ${bad ? 'FAIL' : 'PASS'} (${out.checks.length - bad}/${out.checks.length})`);
await browser.close();
process.exit(bad ? 1 : 0);
