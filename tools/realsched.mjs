// 実機のパススケジュールをそのまま流し、本アプリの圧延モデルと突き合わせるパス表を出す。
// 実機データと共通ランナーは tools/reallot.mjs、採点は tools/calib.mjs。
//   node tools/realsched.mjs [--temp=433] [--set=PROCESS.MU=0.25 ...]
import { openApp, installHelpers } from './harness.mjs';
import { REAL, runReal, parseSets } from './reallot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const TEMP = +opt('temp', REAL.lot.temp), sets = parseSets(args);
if (opt('mu', null)) sets.push({ path: 'PROCESS.MU', value: +opt('mu') });   // 旧オプションの互換
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await runReal(page, { temp: TEMP, sets });
await browser.close();

const f0 = (x, w = 6) => (x == null || !Number.isFinite(x) ? '–' : Math.round(x)).toString().padStart(w);
const f1 = (x, w = 6) => (x == null || !Number.isFinite(x) ? '–' : (+x).toFixed(1)).toString().padStart(w);
console.log(`炉出し ${TEMP} ℃ / 完走 ${out.done} / 停止 ${out.tripped || 'なし'} / 総時間 ${f0(out.total)} s / 板長 ${f1(out.outLen / 1000, 0)} m`);
console.log('pass 出側  圧下率  速度 噛込角 | 荷重max  荷重avg  予測  動力MW | 入温 出側温 出温 | 板長 m  所要 s  圧延 s | 上下ΔT  κ_bite     反り R[m]  先端 mm | 頭 t / 尻 t  尻局所℃');
for (const p of out.passes) {
  console.log(`${String(p.no).padStart(3)} ${f0(p.hOut, 5)} ${f1(p.red, 6)}% ${f0(p.vMax, 4)} ${f1(p.plan?.bite, 5)}° | ` +
    `${f0(p.fMax, 7)} ${f0(p.fAvg, 8)} ${f0(out.gen[p.no - 1]?.steady, 6)} ${f1(p.pMax, 6)} | ${f0(p.tIn, 4)} ${f0(p.tExit, 6)} ${f0(p.tOut, 4)} | ` +
    `${f1(p.len / 1000, 6)} ${f1(p.sec, 6)} ${f1(p.len / (p.vMax / 60 * 1000), 6)} | ${f1(p.bot - p.top, 6)} ${(p.kb ?? 0).toExponential(1).padStart(9)} ${f1(p.R_m, 9)} ${f0(p.tip, 8)} | ${f0(p.fHead, 5)} / ${f0(p.fTail, 5)} ${f0(p.Ttail, 5)}`);
}
console.log('\n区間時間（実機 vs 本アプリ）:');
for (const sg of out.segs) console.log(`  ${sg.name}（パス ${sg.a + 1}〜${sg.b}）: 実機 ${sg.sec} s / 本アプリ ${f0(sg.simSec)} s / 実機荷重 ${sg.band[0]}〜${sg.band[1]} t`);
console.log('\n本アプリの自動生成スケジュール（同じ素材）:');
console.log('  ' + out.gen.map(q => `${q.gap}@${q.speed}`).join(' → ') + `  （${out.gen.length} パス）`);
