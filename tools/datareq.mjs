// 実績データ（測っていただきたいもの）の表と、記入用テンプレートの往復を確かめる。
//
// «何が分かれば何が決まるか» の一覧は CONFIG.DATAREQ だけが持つ。画面も、記入表（CSV）も、
// この評価器もそこを見る —— 一覧を 2 か所に書くと片方が必ず古くなる。
// 記入表は «出して → 記入して → 読み戻す» が通ることが要なので、往復をそのまま測る。
//
//   node tools/datareq.mjs
import { openApp } from './harness.mjs';

let failed = 0;
const ok = (n, p, d = '', ref = false) => {
  console.log(`  ${ref ? '??  ' : p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`);
  if (!p && !ref) failed++;
};

const { browser, page } = await openApp({ viewport: { width: 1280, height: 800 }, quiet: true });
const R = await page.evaluate(() => {
  const D = window.__DATAREQ, K = window.__CFG.DATAREQ;
  const ids = D.ids, dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  const rows = D.all();
  const need = ['id', 'group', 'item', 'meas', 'nMin', 'now', 'fixes', 'where'];
  const holes = [];
  for (const r of rows) for (const k of need) if (r[k] === null || r[k] === undefined || r[k] === '') holes.push(`${r.id}.${k}`);
  /* 条件を振るもの（cond あり）は 2 点以上ないと傾きが取れない。 */
  const badN = rows.filter(r => (r.sweep ? r.nMin < 2 : r.nMin < 1)).map(r => `${r.id}(${r.nMin})`);
  /* 入る先（where）が実在するか。CONFIG の場所を指しているものだけ見る（tools/ は資料）。 */
  const missWhere = [];
  for (const r of rows) {
    const w = String(r.where || '');
    if (!w.startsWith('CONFIG.')) continue;
    /* «CONFIG.ALLOYS[].LN_A» は «どの要素にもある鍵»、«CONFIG.DRIVE.ROTOR_*» は «接頭辞»。
     * どちらも素直に辿れないので、そこだけ読み替えて実在を見る。 */
    const path = w.replace(/^CONFIG\./, '').split('.');
    let o = window.__CFG, hitAll = true;
    for (const seg of path) {
      if (seg.endsWith('[]')) {                       // 配列／辞書の «どの要素にも» ある鍵
        o = o?.[seg.slice(0, -2)];
        const first = o && Object.values(o)[0];
        if (!first) { hitAll = false; break; }
        o = first; continue;
      }
      if (seg.endsWith('*')) {                        // 接頭辞（ROTOR_* など）
        if (!Object.keys(o || {}).some(k => k.startsWith(seg.slice(0, -1)))) hitAll = false;
        break;
      }
      if (o && seg in o) o = o[seg]; else { hitAll = false; break; }
    }
    if (!hitAll) missWhere.push(w);
  }

  /* --- 記入表の往復 --- */
  const tpl = D.template();
  const lines = tpl.split('\r\n').filter(Boolean);
  const head = lines[0].replace(/^﻿/, '').split(',');
  const nEx = lines.filter(l => l.startsWith(K.KIND_EX + ',')).length;
  const nBlank = lines.filter(l => l.startsWith(K.KIND_BLANK + ',')).length;
  const wantBlank = rows.reduce((a, r) => a + Math.max(1, r.nMin), 0);
  const bom = tpl.charCodeAt(0) === 0xfeff;

  /* 記入欄を «実績» にして値を入れ、読み戻す。全項目を 1 点ずつ埋める。 */
  const filled = [lines[0]];
  const want = new Map();
  for (const l of lines.slice(1)) {
    const c = D.parse(l)[0];
    if (!c || c[0] !== K.KIND_BLANK) { filled.push(l); continue; }
    const id = c[1];
    if (want.has(id)) { filled.push(l); continue; }        // 1 点だけ埋める
    c[0] = K.KIND_REAL; c[5] = c[5] || '12'; c[8] = '123.4'; c[10] = '2026-09-12';
    want.set(id, '123.4');
    filled.push(c.map(D.cell).join(','));
  }
  const back = D.read(filled.join('\r\n'));
  /* 引用が要る文字（区切り・改行・引用符）を通しても壊れないか。 */
  const tricky = [lines[0], ['実績', 'CROP', 'x', '', '端', '頭', 'mm', 'クロップ長', '400', 'mm', '',
                             'カンマ, と "引用符" と\n改行'].map(D.cell).join(',')].join('\r\n');
  const trickyBack = D.read(tricky);
  /* 表に無い項目ID は読み捨てて、そのことを言うか。 */
  const unknownBack = D.read([lines[0], '実績,ZZZZ,x,,,,,,1,,,'].join('\r\n'));
  /* 例の行だけを返したら «0 行» になるか（見本を実績として数えない）。 */
  const exOnly = D.read([lines[0], ...lines.filter(l => l.startsWith(K.KIND_EX + ','))].join('\r\n'));
  /* 点数が足りないことを言うか（2 点要る項目を 1 点だけ入れた場合）。 */
  const short2 = back.short.map(q => `${q.id} ${q.have}/${q.need}`);

  return { ids, dup, holes, badN, missWhere, rows,
           tpl: { lines: lines.length, head, nEx, nBlank, wantBlank, bom, csvKeys: K.CSV },
           back: { n: back.n, ids: [...back.byId.keys()].length, unknown: back.unknown.length, short: short2 },
           tricky: { n: trickyBack.n, note: trickyBack.rows[0]?.note ?? '' },
           unknownBack: { n: unknownBack.n, unknown: unknownBack.unknown },
           exOnly: exOnly.n, groups: D.groups().map(g => [g.name, g.rows.length]) };
});
await browser.close();

console.log(`--- 実績データの一覧（${R.ids.length} 件） ---`);
console.log('      ' + R.groups.map(([k, n]) => `${k} ${n}`).join(' ／ '));
ok('項目ID に重複が無い', R.dup.length === 0, R.dup.length ? R.dup.join(' / ') : `${R.ids.length} 件`);
ok('どの項目にも欠けた列が無い', R.holes.length === 0, R.holes.length ? R.holes.join(' / ') : '欠けなし');
ok('条件を振る項目は 2 点以上を求めている（1 点では傾きが取れない）',
   R.badN.length === 0, R.badN.length ? R.badN.join(' / ')
     : `振る条件つき ${R.rows.filter(r => r.sweep).length} 件（${R.rows.filter(r => r.sweep).map(r => r.id).join('・')}）`);
ok('«入る先» がすべて実在する（CONFIG の場所を指しているもの）',
   R.missWhere.length === 0, R.missWhere.length ? `無い場所: ${R.missWhere.join(' / ')}` : '参照切れなし');

console.log('\n--- 記入用テンプレート（CSV）---');
ok('見出しが表の列どおり', JSON.stringify(R.tpl.head) === JSON.stringify(R.tpl.csvKeys),
   R.tpl.head.join(' / '));
ok('Excel が日本語を読めるよう BOM が付いている', R.tpl.bom, R.tpl.bom ? 'BOM あり' : 'BOM なし（Excel で化ける）');
ok('1 項目につき «例» が 1 行ある', R.tpl.nEx === R.ids.length, `${R.tpl.nEx} / ${R.ids.length} 行`);
ok('記入欄が «要る点数» ぶん並んでいる', R.tpl.nBlank === R.tpl.wantBlank, `${R.tpl.nBlank} / ${R.tpl.wantBlank} 行`);

console.log('\n--- 記入したものを読み戻す ---');
ok('記入した行がすべて読める', R.back.n === R.ids.length && R.back.ids === R.ids.length,
   `${R.back.n} 行 ／ ${R.back.ids} 項目`);
ok('«例» の行は実績として数えない（見本を混ぜない）', R.exOnly === 0, `例だけを返したとき ${R.exOnly} 行`);
ok('表に無い項目ID は読み捨て、そのことを言う',
   R.unknownBack.n === 0 && R.unknownBack.unknown.includes('ZZZZ'),
   `読んだ ${R.unknownBack.n} 行 ／ 知らない記号 ${R.unknownBack.unknown.join(' / ') || 'なし'}`);
ok('点数が足りない項目を言う（2 点要るものを 1 点だけ入れたとき）',
   R.back.short.length > 0, R.back.short.join(' / ') || 'なし');
ok('区切り・引用符・改行を含む備考が壊れずに往復する',
   R.tricky.n === 1 && R.tricky.note.includes('カンマ, と "引用符" と') && R.tricky.note.includes('\n'),
   JSON.stringify(R.tricky.note));

console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
