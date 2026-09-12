// 上下の冷却バランスが «反り» をどれだけ動かすかを測る。
//
// 反りを作るのは «上下の温度差» であって、冷却の強さそのものではない。上面ヘッダと
// 下面スプレーを同時に使うと、上面をいくら冷やしても下面も同じだけ冷えるので
// 上下差が付かず、反りが出ない —— «入側冷却を入れても反らない» の正体がこれ。
//
// 実測（A5052・530 × 1,330 × 3,450・433 ℃・8 mm コイル）:
//   入側なし・下面あり（既定） 上下差 厚板 14.5 K / 薄板 1.9 K   先端の浮き 22 / 2 mm
//   入側あり・下面あり         上下差 厚板 14.5 K / 薄板 1.8 K   先端の浮き 21 / 1 mm
//   入側あり・下面なし         上下差 厚板 18.7 K / 薄板 5.5 K   先端の浮き 72 / 17 mm
//
// つまり «入側を入れる» より «下面を切る» ほうが 3 倍効く。実機で下面スプレーを
// どう使っているか（常時か、反り対策で切るか）は README の残件（上下ロールの径差と反りの実測）。
//
//   node tools/curlbal.mjs
import { openApp, installHelpers } from './harness.mjs';

const LOT = { cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052' };

const run = async (entry, bot) => {
  const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
  await installHelpers(page);
  const out = await page.evaluate(({ LOT, entry, bot }) => new Promise(res => setTimeout(() => {
    const P = window.__app.physics, K = window.__CFG, R = window.__ROLL;
    K.MATERIAL.STRIP_COOL.ENTRY = entry;
    K.MATERIAL.STRIP_COOL.BOT = bot;
    P.slab.reset({ ...LOT });
    window.__startAuto(false);
    const rows = []; let was = false;
    window.__ff((p) => {
      const s = p.slab, m = p.mill, now = s.rollingActive;
      if (was && !now) {
        const sp = R.curlSpan(s.kNew, s.thickness, s.width, s.alloy);
        rows.push({ th: +s.thickness.toFixed(1), dTB: +(s.tTop - s.tBot).toFixed(1),
                    k: s.kNew, tip: +sp.tip.toFixed(0) });
      }
      was = now;
      return p.finish.done || !!p.tripped;
    }, 120 * 3000, 0);
    res(rows);
  }, 400)), { LOT, entry, bot });
  await browser.close();
  const mx = (a, k) => a.length ? Math.max(...a.map(q => Math.abs(q[k]))) : 0;
  const thick = out.filter(q => q.th > 100), thin = out.filter(q => q.th <= 100);
  return { dTBthick: mx(thick, 'dTB'), dTBthin: mx(thin, 'dTB'),
           tipThick: mx(thick, 'tip'), tipThin: mx(thin, 'tip') };
};

const CASES = [
  { entry: false, bot: true,  name: '入側なし・下面あり（既定）' },
  { entry: true,  bot: true,  name: '入側あり・下面あり' },
  { entry: false, bot: false, name: '入側なし・下面なし' },
  { entry: true,  bot: false, name: '入側あり・下面なし' },
];
const R = [];
for (const c of CASES) R.push({ ...c, ...(await run(c.entry, c.bot)) });

const P = (x, n) => String(x).padStart(n);
console.log('冷却の組み合わせ              上下差 厚板  薄板 │ 先端の浮き 厚板   薄板');
for (const r of R)
  console.log(`${r.name.padEnd(26)}${P(r.dTBthick.toFixed(1), 8)} K${P(r.dTBthin.toFixed(1), 6)} K │`
    + `${P(r.tipThick.toFixed(0), 10)} mm${P(r.tipThin.toFixed(0), 6)} mm`);

const base = R[0], entryOn = R[1], botOff = R[2];
const checks = [];
const ok = (n, c, g, ref = false) => checks.push({ name: n, pass: !!c, got: g, ref });

ok('反りのモデルが生きている（上下差が付けば反る）', botOff.tipThick > base.tipThick * 1.5,
   `下面を切ると先端の浮きが ${base.tipThick.toFixed(0)} → ${botOff.tipThick.toFixed(0)} mm`);
ok('上下の «差» が反りを決める（差が大きいほど反る）',
   R.every(r => (r.dTBthick > base.dTBthick) === (r.tipThick > base.tipThick) || r === base),
   R.map(r => `${r.dTBthick.toFixed(1)}K→${r.tipThick.toFixed(0)}mm`).join(' '));
ok('下面スプレーは上面冷却を打ち消す（入側を入れても反りが増えない）',
   Math.abs(entryOn.tipThick - base.tipThick) <= Math.max(base.tipThick * 0.15, 3),
   `入側 OFF ${base.tipThick.toFixed(0)} mm → ON ${entryOn.tipThick.toFixed(0)} mm（差 ${(entryOn.tipThick - base.tipThick).toFixed(0)} mm）`);
ok('薄板は板厚方向に均されるので上下差が残りにくい', base.dTBthin < base.dTBthick / 3,
   `厚板 ${base.dTBthick.toFixed(1)} K / 薄板 ${base.dTBthin.toFixed(1)} K`);
/* 実機の «反り量» の実測が無いので、どの組み合わせが実機かは決められない。
 * 数値だけを毎回出して、実測をいただいたときに合わせられるようにしておく。 */
ok('（参考）実機の先端の浮き（厚板で 50〜1,500 mm）に入る組み合わせ',
   R.some(r => r.tipThick >= 50), R.map(r => `${r.name} ${r.tipThick.toFixed(0)} mm`).join(' ／ '), true);

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}`
  + `${nRef ? `、参考 ${nRef} 件` : ''})`);
process.exit(bad.length ? 1 : 0);
