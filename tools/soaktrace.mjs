// ソーキング（均質化熱処理）のマスタが «表として整合しているか» を確かめる。
//
// 実機の操業基準（2026-09 提供）を、いただいた表のまま CONFIG.SOAK に置いてある。
// 表をそのまま持つ以上、«参照が合っているか» は機械で見ないと崩れる ——
// どのパターンにも熱サイクルがあるか、炉温設定の記号が段と噛み合っているか、
// 他の表から呼ばれているパターン記号が M1 に実在するか。
//
//   node tools/soaktrace.mjs
import { openApp } from './harness.mjs';

let failed = 0;
const ok = (n, p, d = '', ref = false) => {
  console.log(`  ${ref ? '??  ' : p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`);
  if (!p && !ref) failed++;
};

const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
const R = await page.evaluate(() => {
  const S = window.__SOAK, K = window.__CFG.SOAK, M = window.__MATCODE, C = window.__CFG;
  const ids = S.ids;
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  /* 他の表が «M1 に無いパターン» を指していないか。参照が切れていると、画面では
   * 黙って空欄になるので気づけない。 */
  const refTables = ['TEMPS', 'STEPS', 'PROBES', 'TRIGGERS', 'MATERIALS', 'TIMELIM', 'RULES'];
  const orphan = [];
  for (const t of refTables)
    for (const r of S.all(t)) if (!ids.includes(r.pattern)) orphan.push(`${t}:${r.pattern}`);
  // M8 は «適用パターン» が ',' 区切り
  for (const r of S.all('LIMITS'))
    for (const q of String(r.patterns || '').split(/[,、]\s*/).filter(Boolean))
      if (!ids.includes(q)) orphan.push(`LIMITS:${q}`);
  // 熱サイクルが無いパターン / 段番号が 1 から連番でないパターン
  const noSteps = ids.filter(id => S.steps(id).length === 0);
  const badNo = ids.filter(id => S.steps(id).some((q, i) => q.no !== i + 1));
  // 段数（M1）と «均熱段の数»（M3）が噛み合っているか
  const stageBad = [];
  for (const id of ids) {
    const st = S.steps(id), holds = st.filter(q => /均熱/.test(q.type || '')).length;
    const want = S.stages(id) === '2段' ? 2 : 1;
    if (holds !== want) stageBad.push(`${id}(M1 ${S.stages(id)} / 均熱 ${holds} 段)`);
  }
  // 炉温設定の記号。H→L 系は «判定温度» であって設定温度ではない
  const codes = [...new Set(S.all('TEMPS').map(r => r.code))].sort();
  const judge = codes.filter(c => /→/.test(c));
  // 最後の均熱段の設定温度が引けるか（持ちかかり温度の出どころ）
  const noFinal = ids.filter(id => S.finalHoldC(id, 'G1') === null);
  const finals = ids.map(id => ({ id, g1: S.finalHoldC(id, 'G1'), g2: S.finalHoldC(id, 'G2') }));
  const g12 = finals.filter(f => f.g1 !== f.g2);
  // 炉（M4）
  const furn = S.all('FURNACES');
  const grpOf = furn.map(f => `${f.no}:${f.group}`);
  // 代表材からパターンを引けるか
  const byS = { '52S': S.patternsForSample('52S'), '3S': S.patternsForSample('3S'), '75S': S.patternsForSample('75S') };
  /* «→» と «群の括弧» が混ざった書き方を正しく読めているか。E5 の第2段は
   * «540→530(G2:550→540)» で、G2 の値は括弧の最初の 550 ではなく最後の 540。 */
  const parse = { e5g1: S.parseSetC('540→530(G2:550→540)', 'G1'), e5g2: S.parseSetC('540→530(G2:550→540)', 'G2'),
                  eg1: S.parseSetC('550→530(G2:540)', 'G1'), eg2: S.parseSetC('550→530(G2:540)', 'G2'),
                  plain: S.parseSetC('590(G2:600)', 'G2'), none: S.parseSetC('カバー開', 'G1') };
  /* --- 材質マスタ（社内材質記号 ↔ JIS 記号）--- */
  const rows = C.MATCODE.ROWS;
  const allCodes = rows.flatMap(r => r[1]);
  const mcDup = allCodes.filter((v, i) => allCodes.indexOf(v) !== i);
  const jisList = rows.map(r => r[0]);
  const mcDupJis = jisList.filter((v, i) => jisList.indexOf(v) !== i);
  const roundTrip = allCodes.filter(c => M.codesFor(M.jisOf(c)).includes(c)).length;
  const keys = Object.keys(C.ALLOYS);
  const perAlloy = keys.map(k => ({ k: k, key: k, codes: M.codesForAlloy(k).length,
                                    samples: M.soakSamples(k), auto: S.autoFor(k) }));
  const noSample = perAlloy.filter(a => a.samples.length === 0).map(a => a.key);
  const currentOf = {}; for (const k of noSample) currentOf[k] = S.autoFor(k)[0] || S.GENERAL;
  const mc = { jis: rows.length, codes: allCodes.length, dup: [...new Set(mcDup)], dupJis: [...new Set(mcDupJis)],
               roundTrip, unknownJis: M.jisOf('zzz'), unknownCodes: M.codesFor('9999').length,
               perAlloy, noSample, currentOf, general: S.GENERAL,
               lotPattern: C.MATERIAL.SOAK_PATTERN, lotTempC: C.SLAB.TEMP_DEFAULT, holdMin: C.SUPPLY.HOLD_MIN,
               pick: S.pickupC('E', 'A5052'),
               needMin: S.coolMinutesTo(C.SLAB.TEMP_DEFAULT, 'E', 'A5052') };
  return { n: ids.length, ids, dup, orphan: [...new Set(orphan)], noSteps, badNo, stageBad, mc,
           codes, judge, noFinal, finals, g12, grpOf, byS, parse,
           counts: Object.fromEntries(Object.keys(K).filter(k => Array.isArray(K[k])).map(k => [k, K[k].length])) };
});
await browser.close();

console.log(`--- ソーキングマスタ（${R.n} パターン） ---`);
console.log('      ' + Object.entries(R.counts).map(([k, v]) => `${k} ${v}`).join(' ／ '));
ok('操業パターンの記号に重複が無い', R.dup.length === 0, R.dup.length ? R.dup.join(' / ') : `${R.n} パターン`);
ok('他の表が指すパターン記号がすべて実在する', R.orphan.length === 0,
   R.orphan.length ? `無い記号を指している: ${R.orphan.join(' / ')}` : '参照切れなし');
ok('すべてのパターンに熱サイクル（M3）がある', R.noSteps.length === 0,
   R.noSteps.length ? R.noSteps.join(' / ') : `${R.n} パターンすべて`);
ok('熱サイクルの段番号が 1 から連番', R.badNo.length === 0, R.badNo.length ? R.badNo.join(' / ') : '連番');
ok('M1 の «段数» と M3 の «均熱段の数» が噛み合う', R.stageBad.length === 0,
   R.stageBad.length ? R.stageBad.join(' / ') : '1 段 ＝ 均熱 1 つ／2 段 ＝ 均熱 2 つ');
ok('炉温設定の記号に «判定温度»（H→L 系）が含まれる（設定温度と区別されている）',
   R.judge.length > 0, `判定温度の記号: ${R.judge.join(' / ')}`);
ok('すべてのパターンで «最後の均熱段の設定温度» が引ける（持ちかかり温度の出どころ）',
   R.noFinal.length === 0, R.noFinal.length ? R.noFinal.join(' / ') : `${R.n} パターンすべて`);
ok('炉の群が図面どおり（#1〜6 ＝ G1 ／ #7・8 ＝ G2 ／ #9 ＝ G3）',
   R.grpOf.join(' ') === '1:G1 2:G1 3:G1 4:G1 5:G1 6:G1 7:G2 8:G2 9:G3', R.grpOf.join(' '));
ok('代表材から操業パターンを引ける', R.byS['52S'].length > 0 && R.byS['3S'].length > 0 && R.byS['75S'].length > 0,
   Object.entries(R.byS).map(([k, v]) => `${k} → ${v.join(',') || 'なし'}`).join(' ／ '));
ok('«→»（途中で落とす）と «群の括弧» が混ざった設定温度を正しく読む',
   R.parse.e5g1 === 530 && R.parse.e5g2 === 540 && R.parse.eg1 === 530 && R.parse.eg2 === 540
   && R.parse.plain === 600 && R.parse.none === null,
   `«540→530(G2:550→540)» → G1 ${R.parse.e5g1} / G2 ${R.parse.e5g2} ℃ ／ «590(G2:600)» → G2 ${R.parse.plain} ℃`
 + ` ／ «カバー開» → ${R.parse.none}`);
/* #7・8 号炉（2 ゾーン）は均熱の設定が #1〜6 と違うパターンがある。持ちかかり温度が
 * 炉で変わるということなので、数値を毎回出しておく。 */
ok('（参考）炉の群で最後の均熱温度が変わるパターン', true,
   R.g12.length ? R.g12.map(f => `${f.id} G1 ${f.g1} / G2 ${f.g2} ℃`).join(' ／ ') : 'なし', true);
ok('（参考）最後の均熱温度の分布（持ちかかり温度の素）', true,
   [...new Set(R.finals.map(f => f.g1))].sort((a, b) => a - b).join(' / ') + ' ℃', true);

/* --- 材質マスタ（社内材質記号 ↔ JIS 記号）--------------------------------
 * 実機の操業基準は社内記号で書かれているので、この橋渡しが崩れると «A5052 の
 * ソーキングはどれか» が引けなくなる。表そのものの整合と、橋渡しが実際に
 * 効いていること（本アプリの 8 材質すべてで社内記号が引けること）を見る。 */
console.log('\n--- 材質マスタ（社内材質記号 ↔ JIS 記号）---');
ok('対応表に重複した社内材質記号が無い', R.mc.dup.length === 0,
   R.mc.dup.length ? R.mc.dup.join(' / ') : `${R.mc.jis} JIS 記号 / ${R.mc.codes} 社内記号`);
ok('JIS 記号にも重複が無い', R.mc.dupJis.length === 0,
   R.mc.dupJis.length ? R.mc.dupJis.join(' / ') : `${R.mc.jis} 件`);
ok('社内記号 → JIS → 社内記号 と往復できる', R.mc.roundTrip === R.mc.codes,
   `${R.mc.roundTrip} / ${R.mc.codes} 件で往復`);
ok('対応表に無い記号では «作らない»（null と空を返す）',
   R.mc.unknownJis === null && R.mc.unknownCodes === 0, `jisOf('zzz') → ${R.mc.unknownJis} ／ codesFor('9999') → ${R.mc.unknownCodes} 件`);
ok('本アプリの材質すべてに社内材質記号が引ける（«引けない» が無くなった）',
   R.mc.perAlloy.every(a => a.codes > 0),
   R.mc.perAlloy.map(a => `${a.key} ${a.codes}`).join(' / '));
ok('材質 → 社内記号 → 代表材 → 操業パターン と辿れる（A5083 は F 操業へ）',
   R.mc.perAlloy.find(a => a.key === 'A5083')?.auto.includes('F') === true
   && R.mc.perAlloy.find(a => a.key === 'A5052')?.auto.length > 0,
   R.mc.perAlloy.map(a => `${a.key} → ${a.samples.join(',') || '代表材なし'} → ${a.auto.join(',') || '一般材'}`).join(' ／ '));
ok('代表材で引けない材質は «一般材»（E 操業）へ落ちる（推測で別の操業へ振らない）',
   R.mc.noSample.every(k => R.mc.currentOf[k] === 'E') && R.mc.general === 'E',
   `代表材なし: ${R.mc.noSample.join(' / ') || 'なし'} ／ 行き先 ${R.mc.general}`);
/* 較正の基準ロットの操業パターンはご指定（2026-09-12）。そこから出る持ちかかり温度の
 * 見込みと実機の実測が合わないことは分かっている（README 0-3 の 23）ので、
 * «合う» ことではなく «差が出ていることを隠していない» ことを毎回数値で出す。 */
ok('較正の基準ロットの操業パターンがご指定どおり（E 操業）', R.mc.lotPattern === 'E',
   `既定の SOAK_PATTERN = ${R.mc.lotPattern}`);
ok('（参考）操業から出る持ちかかり温度の見込みと、実機の持ちかかりの差', true,
   R.mc.pick
     ? `E 操業 炉出 ${R.mc.pick.fromC} ℃ → ${R.mc.pick.minutes} 分で ${R.mc.pick.toC.toFixed(0)} ℃`
       + `（−${R.mc.pick.dropC.toFixed(0)} K）／ 実機の持ちかかり ${R.mc.lotTempC} ℃ ／ 差 `
       + `${(R.mc.pick.toC - R.mc.lotTempC).toFixed(0)} K —— 説明できていない（素材の温度は入力値のまま）`
     : '引けません', true);
ok('（参考）自然放熱だけで実機の持ちかかり温度まで落ちるのに要る時間', true,
   R.mc.needMin === null ? '落ちません'
     : `${R.mc.needMin.toFixed(0)} 分 ＝ ${(R.mc.needMin / 60).toFixed(1)} 時間`
       + `（いま置いている待ち時間は ${R.mc.holdMin} 分）`, true);

console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
