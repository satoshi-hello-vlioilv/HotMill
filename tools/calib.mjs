// 実機データとの較正評価器。実機のパススケジュール（tools/reallot.mjs の REAL）をそのまま流し、
// 荷重帯・上がり温度・板長・区間時間・自動生成スケジュールの一致を採点する。
// パスごとの温度収支の内訳（発熱／ロール抜熱／クーラント／ヘッダ／テーブル接触／表面）も出す。
//   node tools/calib.mjs [--temp=433] [--set=PROCESS.MU=0.2] [--set=MATERIAL.H_ROLL=15000] [--quiet]
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';
import { REAL, LOT_A1100, runReal, parseSets } from './reallot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
/* 較正の基準データは 1 つではない（材質も板幅も違う 2 ロットが提供されている）。
 * --lot=A1100 で切り替える。既定は A5052 のロット。 */
const LOTS = { A5052: REAL, A1100: LOT_A1100 };
const LOT = LOTS[opt('lot', 'A5052')] || REAL;
const TEMP = +opt('temp', LOT.lot.temp), sets = parseSets(args), quiet = args.includes('--quiet');
const target = args.find(a => a.endsWith('.html')) || DEFAULT_TARGET;
const { browser, page } = await openApp({ target, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await runReal(page, { temp: TEMP, sets, real: LOT });
await browser.close();

// soft: 合否に数えない «参考» 項目。実機の数値と本アプリの物理が両立しないと分かった点を、
//       隠さずに毎回表示するためのもの。実機の再確認が取れたら通常の項目に戻す（26 → 16 mm がその例だった）。
const checks = [], ok = (n, p, d = '', soft = false) => checks.push({ name: n, pass: !!p, detail: d, soft });
const f0 = (x, w = 6) => (x == null || !Number.isFinite(x) ? '–' : Math.round(x)).toString().padStart(w);
const f1 = (x, w = 6) => (x == null || !Number.isFinite(x) ? '–' : (+x).toFixed(1)).toString().padStart(w);
const P = out.passes;

// 1. 完走
ok('実機スケジュールを過負荷停止せずに完走する', out.done && !out.tripped, out.tripped || `${P.length} パス・${f0(out.total)} s`);
// 2. 荷重帯（区間ごと。平均荷重が帯の ±10 % に、最大荷重が帯の上限 ×1.15 以内に入ること）
for (const sg of out.segs) {
  // 初パス（10 mm の軽圧下）は帯の外で当然なので除く
  const rows = P.slice(sg.a, sg.b).filter((r, i) => r.fAvg > 0 && !(sg.a === 0 && i === 0));
  const [lo, hi] = sg.band;
  // 帯は «定常の読み» なので平均で比べる。頭・尻・噛み込みの峰は別の評価器（loadtrace）が見る
  const bad = rows.filter(r => r.fAvg < lo * 0.9 || r.fAvg > hi * 1.1);
  const rng = rows.length ? `${f0(Math.min(...rows.map(r => r.fAvg)), 0)}〜${f0(Math.max(...rows.map(r => r.fAvg)), 0)} t（最大 ${f0(Math.max(...rows.map(r => r.fMax)), 0)} t）` : 'データ無し';
  /* soft は «実機の値と本アプリの物理が両立しない» と分かった区間を、合否に数えずに表示し続けるための
   * 印（reallot.mjs の seg[].soft）。26 → 16 mm がその例だったが、実機側の誤記（750〜900 → 1,530〜2,000 t）と
   * 確認されて通常項目に戻した。いまは使っていないが、次のデータで同じことが起きたときのために残す。 */
  ok(`荷重 ${sg.name}: 実機 ${lo}〜${hi} t${sg.soft ? '（参考・要確認）' : ''}`, rows.length && bad.length === 0,
     `本アプリ 平均 ${rng}${bad.length ? ' / 外れ: ' + bad.map(r => `#${r.no} ${f0(r.fAvg, 0)}/${f0(r.fMax, 0)} t`).join(', ') : ''}`, !!sg.soft);
}
// 3. 上がり温度。実機の «上がり温度» は最終パスで出側パイロメータが読む板温と解釈し、
//    本アプリでは «バイトを出た材料の温度» のパス平均（log.tExit）と比べる。
//    最終パスの尻は入側テーブルで 4 分待つあいだに冷えるので、巻き終えたコイルの平均（tOut）はこれより低い。
const last = P[P.length - 1];
/* 上がり温度と板長は «提供されているロットだけ» 判定する。A1100 のロットは未提供なので、
 * 数字は出すが合否には数えない（推測で基準を作らない）。 */
if (LOT.tEnd != null)
  ok(`上がり温度（最終パスの出側板温・パス平均）実機 ${LOT.tEnd} ℃ ±15`, last && Math.abs(last.tExit - LOT.tEnd) <= 15,
     `本アプリ ${f0(last?.tExit, 0)} ℃（頭 ${f0(last?.Thead, 0)} → 尻 ${f0(last?.Ttail, 0)} ℃、コイル平均 ${f0(last?.tOut ?? out.outTemp, 0)} ℃）`);
else
  console.log(`  --   上がり温度（実機データ未提供）— 本アプリ ${f0(last?.tExit, 0)} ℃（コイル平均 ${f0(last?.tOut ?? out.outTemp, 0)} ℃）`);
// 4. 板長
if (LOT.lenM != null)
  ok(`${LOT.lot.target} mm 完了時の板長 実機 ${LOT.lenM} m ±3 %`, out.done && Math.abs(out.outLen / 1000 / LOT.lenM - 1) <= 0.03,
     `本アプリ ${f1(out.outLen / 1000, 0)} m（尻の板厚 ${f1(out.outTh, 0)} mm）`);
else
  console.log(`  --   板長（実機データ未提供）— 本アプリ ${f1(out.outLen / 1000, 0)} m（尻の板厚 ${f1(out.outTh, 0)} mm）`);
// 5. 区間時間（±25 %）。65 mm でのクロップは実機では仕上げ段の時間に入り、本アプリでは
//    第 17 パスの終わり（同じパス番号のうち）に入るので、厚板段と仕上げ段は合算で比べる
{
  const [s1, s2, ...rest] = out.segs;
  const sum = (s1.simSec ?? NaN) + (s2.simSec ?? NaN);
  /* 実機の秒が «目安»（頭潰しと加減速を含む）と明示されているロットは soft 扱い。
   * 本アプリの秒は «圧延そのもの» なので短く出るのが正しく、合否には数えない。 */
  const st = !!LOT.softTime;
  ok(`所要時間 ${s1.name} ＋ ${s2.name}（クロップ込み）: 実機 ${s1.sec + s2.sec} s ±25 %${st ? '（参考・目安時間）' : ''}`,
     Number.isFinite(sum) && Math.abs(sum / (s1.sec + s2.sec) - 1) <= 0.25, `本アプリ ${f0(sum, 0)} s（${f0(s1.simSec, 0)} ＋ ${f0(s2.simSec, 0)}）`, st);
  for (const sg of rest) ok(`所要時間 ${sg.name}: 実機 ${sg.sec} s ±25 %${st ? '（参考・目安時間）' : ''}`,
     sg.simSec != null && Math.abs(sg.simSec / sg.sec - 1) <= 0.25, `本アプリ ${f0(sg.simSec, 0)} s`, st);
}
// 6. 自動生成スケジュールが実機の圧下配分・速度を再現する
const gen = out.gen.map(q => `${q.gap}@${q.speed}`), real = out.real.map(q => `${q.gap}@${q.speed}`);
const diff = gen.map((g, i) => g !== real[i] ? `#${i + 1} ${g}≠${real[i] ?? '–'}` : null).filter(Boolean);
/* 自動生成スケジュールの一致は «A5052 のロットで作った» 判定。別のロットは圧下配分の
 * 設計思想そのものが違うので比べない（比べると «違って当たり前» の項目が落ち続ける）。 */
if (!LOT.skipGen)
  ok(`自動生成スケジュールが実機の ${real.length} パス（板厚・速度）と一致する`, gen.length === real.length && diff.length === 0,
     gen.length !== real.length ? `本アプリ ${gen.length} パス` : diff.length ? diff.slice(0, 4).join(', ') : '一致');
// 7. 予測荷重の精度: 自動生成スケジュール（実機と同じ圧下配分）の予測 steady / force が
//    運転の平均 / 最大荷重に ±15 % で一致する（仕上げ段以降。厚板段は初パスを除いて同様に見る）
{
  const cmp = P.map((r, i) => ({ no: r.no, q: out.gen[i] })).filter(x => x.q && x.no > 1 && x.q.gap === P[x.no - 1].plan?.gap)
    .map(x => ({ no: x.no, eA: x.q.steady / P[x.no - 1].fAvg - 1, eM: x.q.force / P[x.no - 1].fMax - 1 }));
  const worstA = [...cmp].sort((a, b) => Math.abs(b.eA) - Math.abs(a.eA))[0], worstM = [...cmp].sort((a, b) => Math.abs(b.eM) - Math.abs(a.eM))[0];
  ok('予測の定常荷重が運転の平均荷重に ±15 % で一致する（全パス）', cmp.length && Math.abs(worstA.eA) <= 0.15,
     worstA ? `最大差 #${worstA.no} ${(worstA.eA * 100).toFixed(1)} %（${cmp.length} パス比較）` : 'データ無し');
  // 最大は噛み込み衝撃の当たりどころで ±数 % 揺れる（実測 max/avg 1.12〜1.22）ので ±20 %
  ok('予測の最大荷重が運転の最大荷重に ±20 % で一致する（全パス）', cmp.length && Math.abs(worstM.eM) <= 0.20,
     worstM ? `最大差 #${worstM.no} ${(worstM.eM * 100).toFixed(1)} %` : 'データ無し');
}
// 8. 予測と運転の整合: 予測 net と運転の温度変化が各パスで 10 K 以内
const worstB = P.filter(r => r.budget).map(r => ({ no: r.no, d: r.budget.net - r.budget.sim })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
ok('予測の温度収支（tempBudget）と運転の温度変化が各パスで 10 K 以内', worstB && Math.abs(worstB.d) <= 10,
   worstB ? `最大差 #${worstB.no} ${f1(worstB.d, 0)} K` : 'データ無し');

if (!quiet) {
  console.log(`炉出し ${TEMP} ℃ / 完走 ${out.done} / 停止 ${out.tripped || 'なし'} / 総時間 ${f0(out.total)} s / μ ${out.config.MU} / H_ROLL ${out.config.H_ROLL}` +
              (sets.length ? ' / ' + sets.map(x => `${x.path}=${x.value}`).join(' ') : ''));
  console.log('pass 出側 速度 | 荷重avg 荷重max  頭 t   尻 t 予測avg 予測max | 入温 出温 ΔT実 出側温 尻局所 | 発熱 −ロール −ｸｰﾗﾝﾄ −ヘッダ −接触 −表面 = 予測ΔT | 所要 s');
  for (const r of P) {
    const b = r.budget || {};
    console.log(`${String(r.no).padStart(3)} ${f0(r.hOut, 5)} ${f0(r.vMax, 4)} | ${f0(r.fAvg, 7)} ${f0(r.fMax, 7)} ${f0(r.fHead, 6)} ${f0(r.fTail, 6)} ${f0(out.gen[r.no - 1]?.steady, 7)} ${f0(out.gen[r.no - 1]?.force, 7)} | ${f0(r.tIn, 4)} ${f0(r.tOut, 4)} ${f1(b.sim, 5)} ${f0(r.tExit, 6)} ${f0(r.Ttail, 6)} | ` +
      `${f1(b.heat, 4)} ${f1(b.chill, 6)} ${f1(b.cool, 7)} ${f1(b.guide, 6)} ${f1(b.touch, 5)} ${f1(b.surface, 5)} = ${f1(b.net, 6)} | ${f1(b.secs, 6)}`);
  }
  console.log('');
}
for (const c of checks) console.log(`  ${c.pass ? 'ok  ' : c.soft ? '??  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
const hard = checks.filter(c => !c.soft), failed = hard.filter(c => !c.pass).length, soft = checks.filter(c => c.soft && !c.pass).length;
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'} (${hard.length - failed}/${hard.length}${soft ? `、参考 ${soft} 件は未一致` : ''})`);
