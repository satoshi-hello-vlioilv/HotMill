// 板面冷却の «液流束» を上がり温度で合わせ直すための測り。
//
// 液流束（COOLANT.SPRAY.TOP/BOT.FLUX）は実機の流量が未提供で、«上がり温度が実機に合うように»
// 合わせ込んだ値。合わせ込んだときの既定は «下面の入側は OFF» だったが、実機では下面は常時
// ON とのご回答があり既定を変えたため、同じ値のままでは冷え過ぎる。
// ここは «どの組み合わせで上がり温度がいくつになるか» を並べて出し、選んだ値の根拠を残す。
//
// 合否に数えるのは «いまの設定で上がり温度が実機の帯に入る» の 1 件だけ。
// 表そのものは参考（実機の流量が分かれば、合わせ込みではなく実測値を入れる）。
//   node tools/coolfit.mjs
import { openApp, installHelpers } from './harness.mjs';
import { runReal, REAL } from './reallot.mjs';

const BAND = 15;                                   // 実機の上がり温度の帯 [K]
const CASES = [
  { nm: 'いまの設定',                     sets: [] },
  { nm: '下面入側 OFF（合わせ込み当時）', sets: [{ path: 'MATERIAL.STRIP_COOL.ZONES.EB.on', value: false }] },
  { nm: '下面流束 1.1（いま 1.4）',       sets: [{ path: 'MATERIAL.COOLANT.SPRAY.BOT.FLUX', value: 1.1 }] },
  { nm: '下面流束 0.9',                   sets: [{ path: 'MATERIAL.COOLANT.SPRAY.BOT.FLUX', value: 0.9 }] },
  { nm: '下面流束 0.7',                   sets: [{ path: 'MATERIAL.COOLANT.SPRAY.BOT.FLUX', value: 0.7 }] },
];

const rows = [];
for (const c of CASES) {
  const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
  await installHelpers(page);
  const r = await runReal(page, { sets: c.sets });
  const last = r.passes[r.passes.length - 1];
  rows.push({ nm: c.nm, tExit: last?.tExit, len: r.outLen / 1000,
              dT: (last?.top ?? 0) - (last?.bot ?? 0), tip: last?.tip, lift: last?.lift });
  await browser.close();
}
const f = (v, n = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(n));
console.log('\n条件                       上がり温度   実機との差   板長      最終パスの上下差   先端の浮き');
for (const r of rows)
  console.log(`  ${r.nm.padEnd(24)} ${f(r.tExit, 0).padStart(5)} ℃ ${f(r.tExit - REAL.tEnd, 0).padStart(9)} K `
            + `${f(r.len, 1).padStart(8)} m ${f(r.dT, 1).padStart(14)} K ${f(r.lift, 0).padStart(12)} mm`);

let failed = 0;
const ok = (n, p, d = '', ref = false) => {
  console.log(`  ${ref ? '??  ' : p ? 'ok  ' : 'NG  '} ${n}${d ? ' — ' + d : ''}`);
  if (!p && !ref) failed++;
};
console.log('');
const now = rows[0];
ok(`いまの設定で上がり温度が実機 ${REAL.tEnd} ℃ ±${BAND} に入る`,
   now.tExit != null && Math.abs(now.tExit - REAL.tEnd) <= BAND,
   `${f(now.tExit, 0)} ℃（差 ${f(now.tExit - REAL.tEnd, 0)} K）`);
ok('下面の液流束を下げると上がり温度が上がり、上下差も開く（反りの駆動力になる）',
   rows.slice(2).every((r, i, a) => i === 0 || (r.tExit >= a[i - 1].tExit - 0.5)),
   rows.slice(2).map(r => `${r.nm.replace(/下面流束 /, '')}→${f(r.tExit, 0)} ℃ / 上下差 ${f(r.dT, 1)} K`).join(' ／ '), true);
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
