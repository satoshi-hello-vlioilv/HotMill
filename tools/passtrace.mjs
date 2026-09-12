// パスマスタ（圧下の配分）が «表として整合しているか» と、実機の配分を再現しているかを見る。
//
// 実機の較正ロット（A5052・530 → 8 mm）は
//     530 → 65（17 パス）→ 26（4 パス）→ 16 → 8（巻取）… 合計 23 パス
// で通っている。この «区切り» は実機からいただいた数字なので、合否に数える。
// 途中の板厚そのもの（56・46・36 など）は本アプリの則が出した値で、実測ではない ——
// 参考として毎回出すだけにする。
//
//   node tools/passtrace.mjs
import { openApp } from './harness.mjs';

let failed = 0;
const ok = (n, p, d = '', ref = false) => {
  console.log(`  ${ref ? '??  ' : p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`);
  if (!p && !ref) failed++;
};

const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
const R = await page.evaluate(() => {
  const P = window.__PASS, K = window.__CFG, RO = window.__ROLL;
  const ids = P.ids;
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  const rows = P.all();
  /* 欠けている列が無いか。表をそのまま持つ以上、機械で見ないと崩れる。 */
  const need = ['id', 'name', 'hCrop', 'first', 'draftPlate', 'redPlate',
                'draftFinish', 'redLast', 'redLast2', 'vPlate', 'vFinish', 'hFinish', 'vCoil'];
  const holes = [];
  for (const r of rows) for (const k of need) if (r[k] === null || r[k] === undefined) holes.push(`${r.id}.${k}`);
  /* 出どころ（src）が書いてあるか —— 推定値をそれと分からない形で置かないための欄。 */
  const noSrc = rows.filter(r => !r.src).map(r => r.id);

  const build = (h0, hT, coil, id) =>
    RO.buildSchedule(h0, hT, 1330, 433, { coil, length: 3450, alloy: 'A5052', pass: id })
      .map(q => +q.gap.toFixed(1));
  const lot = build(530, 8, true, 'S23');
  const hCrop = P.of('S23').hCrop;
  const nPlate = lot.filter(g => g >= hCrop - 0.5).length;      // クロップ厚に着くまで
  const idx26 = lot.indexOf(26), idx65 = lot.indexOf(65);

  /* 記号を切り替えたら配分が変わることを、作り板（表にない記号）ではなく «実際の行» で見る。
   * いまは記号が 1 つしか無いので、既定へ落ちること（値を作らないこと）だけを確かめる。 */
  const fallback = P.practice('存在しない記号').id;
  /* パスマスタが持つ表（plateSeq / finishSeq）が効くか。行を一時的に足して確かめる ——
   * 実機の表をいただいたときに «入れれば効く» ことを、いま保証しておく。 */
  const K2 = K.PASS, keys = K2.KEYS.PASSES;
  const mk = (o) => keys.map(k => (k in o ? o[k] : null));
  K2.ROWS.push(mk({ id: '__T', name: '検査用', hCrop: 100, first: 10, draftPlate: 30, redPlate: 0.19,
                    plateSeq: [400, 300, 200, 100], draftFinish: 10, redLast: 0.5, redLast2: 0.38,
                    finishSeq: [60, 30], vPlate: 120, vFinish: 80, hFinish: 20, vCoil: 50, src: '検査用' }));
  const seqPlate = build(530, 30, false, '__T');
  K2.ROWS.pop();

  return { ids, dup, holes, noSrc, rows, lot, nPlate, hCrop, idx26, idx65, fallback, seqPlate,
           lotPass: K.SCHEDULE.length, demo: { soak: window.__app.ui._lotOf().soak, pass: window.__app.ui._lotOf().pass } };
});
await browser.close();

console.log(`--- パスマスタ（${R.ids.length} 記号） ---`);
console.log('      ' + R.rows.map(r => `${r.id} ${r.name}`).join(' ／ '));
console.log('      実機ロット A5052 530 → 8 mm の生成: ' + R.lot.join(' → ') + ` mm（${R.lot.length} パス）`);
ok('パス記号に重複が無い', R.dup.length === 0, R.dup.length ? R.dup.join(' / ') : `${R.ids.length} 記号`);
ok('どの記号にも欠けた列が無い', R.holes.length === 0, R.holes.length ? R.holes.join(' / ') : '欠けなし');
ok('どの記号にも «出どころ» が書いてある（推定をそれと分からない形で置かない）',
   R.noSrc.length === 0, R.noSrc.length ? R.noSrc.join(' / ') : R.rows.map(r => `${r.id}: ${r.src}`).join(' ／ '));
ok('表に無い記号では値を作らず、既定の行へ落ちる', R.fallback === 'S23', `落ちた先 ${R.fallback}`);

console.log('\n--- 実機の配分を再現しているか（実機ロット A5052 530 → 8 mm・23 パス）---');
ok('合計 23 パス', R.lot.length === 23, `${R.lot.length} パス`);
ok('クロップまで 17 パスで 65 mm へ', R.nPlate === 17 && R.lot[16] === R.hCrop,
   `${R.nPlate} パス ／ 17 パス目の出側 ${R.lot[16]} mm（クロップ厚 ${R.hCrop}）`);
ok('クロップから 6 パスで 8 mm へ', R.lot.length - R.nPlate === 6 && R.lot[R.lot.length - 1] === 8,
   `${R.lot.length - R.nPlate} パス ／ 最終 ${R.lot[R.lot.length - 1]} mm`);
ok('65 → 26 が 4 パス', R.idx26 - R.idx65 === 4, `${R.idx26 - R.idx65} パス（65 は ${R.idx65 + 1} パス目、26 は ${R.idx26 + 1} パス目）`);
ok('26 → 16 → 8 と落ちる（16 mm を必ず通る）', R.lot.includes(16) && R.lot.indexOf(16) === R.idx26 + 1,
   R.lot.slice(R.idx26).join(' → ') + ' mm');
ok('（参考）厚板段の通る板厚（則が出した値で、実測ではない）', true,
   R.lot.slice(0, R.nPlate).join(' → ') + ' mm', true);
ok('（参考）仕上げ段の通る板厚（26・16・8 は実測、56・46・36 は則）', true,
   R.lot.slice(R.nPlate - 1).join(' → ') + ' mm', true);

console.log('\n--- サンプルとの連動 ---');
ok('既定のサンプルロットがマスタの記号を持っている', R.demo.pass === 'S23' && R.demo.soak === 'E',
   `ソーキング ${R.demo.soak || '自動'} ／ パス ${R.demo.pass}`);
ok('運転に渡るスケジュールも同じパス数', R.lotPass === R.lot.length, `運転 ${R.lotPass} ／ 見積り ${R.lot.length} パス`);

console.log('\n--- 表（seq）で配分を指定できるか ---');
/* 実機の «パス記号ごとの表» をいただいたとき、行に板厚を並べるだけで効くこと。
 * 検査用の記号で 530 → 400 → 300 → 200 → 100 → 60 → 30 を指定して確かめる。 */
ok('厚板段・仕上げ段とも、表に並べた板厚をすべて通る（1 パスで届かないぶんは手前にパスが増える）',
   [400, 300, 200, 100, 60, 30].every(v => R.seqPlate.includes(v)),
   R.seqPlate.join(' → ') + ' mm');

console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
