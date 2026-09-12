// 上下の冷却バランスが «反り» をどれだけ動かすかを測る。
//
// 反りを作るのは «上下の温度差» であって、冷却の強さそのものではない。上面ヘッダと
// 下面スプレーを同時に使うと、上面をいくら冷やしても下面も同じだけ冷えるので
// 上下差が付かず、反りが出ない —— «入側冷却を入れても反らない» の正体がこれ。
//
// 冷却は 4 系統（入側上面 ET / 出側上面 XT / 入側下面 EB / 出側下面 XB）。«入側» は
// 上面ヘッダと下面スプレーの 2 つに分かれるので、どちらを入れるかで向きが逆になる。
//
// 表の数字は走らせれば毎回出る（ここには書かない —— 手で書いた数値は必ず古くなる）。
// 読み方だけ書いておく:
//   ・入側の «上面だけ» を足す → 上下差が開く → 反りが増える
//   ・入側を «上下とも» 足す   → 差が付かない → 反りは変わらない
//     （旧モデルの «入側 ON» はこちらで、それが «入れても反らない» の正体だった）
//   ・下面を切る               → 差がいちばん開く → 反りがいちばん大きい
// 実機で下面スプレーをどう使っているかは «常時 ON» とご回答をいただいている。
//
//   node tools/curlbal.mjs
import { openApp, installHelpers } from './harness.mjs';

const LOT = { cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052' };

const run = async (z) => {
  const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
  await installHelpers(page);
  const out = await page.evaluate(({ LOT, z }) => new Promise(res => setTimeout(() => {
    const P = window.__app.physics, K = window.__CFG, R = window.__ROLL;
    /* 冷却は 4 系統（入側上面 ET / 出側上面 XT / 入側下面 EB / 出側下面 XB）。
     * ENTRY / BOT は «4 系統から導いた読み取り専用» なので、そこへ代入しても何も
     * 起きない（以前ここで代入していて、4 通りが全部同じ結果になっていた）。
     *   entry … 入側の «上面» ヘッダ（反りを作るのはこちら）
     *   bot   … 下面スプレー（入側・出側とも） */
    const Z = K.MATERIAL.STRIP_COOL.ZONES;
    Z.ET.on = z.ET; Z.XT.on = z.XT; Z.EB.on = z.EB; Z.XB.on = z.XB;
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
  }, 400)), { LOT, z });
  await browser.close();
  const mx = (a, k) => a.length ? Math.max(...a.map(q => Math.abs(q[k]))) : 0;
  const thick = out.filter(q => q.th > 100), thin = out.filter(q => q.th <= 100);
  return { dTBthick: mx(thick, 'dTB'), dTBthin: mx(thin, 'dTB'),
           tipThick: mx(thick, 'tip'), tipThin: mx(thin, 'tip') };
};

/* 4 系統（入側上面 ET / 出側上面 XT / 入側下面 EB / 出側下面 XB）の組み合わせ。
 * «入側» は上面ヘッダと下面スプレーの 2 つに分かれるので、どちらを入れるかで向きが逆になる。
 * 打ち消しを見るための基準は «入側に何も無い» 状態（B）で、そこへ何を足すかで比べる。 */
const CASES = [
  { name: '既定（入側なし・下面は上下とも）',     z: { ET: false, XT: true, EB: true,  XB: true  } },
  { name: 'B 基準（入側なし・入側下面もなし）',   z: { ET: false, XT: true, EB: false, XB: true  } },
  { name: 'B ＋ 入側の «上面だけ»',               z: { ET: true,  XT: true, EB: false, XB: true  } },
  { name: 'B ＋ 入側を «上下とも»（旧 入側 ON）', z: { ET: true,  XT: true, EB: true,  XB: true  } },
  { name: '下面をすべて切る',                     z: { ET: false, XT: true, EB: false, XB: false } },
  { name: '入側上面あり・下面なし',               z: { ET: true,  XT: true, EB: false, XB: false } },
];
const R = [];
for (const c of CASES) R.push({ ...c, ...(await run(c.z)) });

const P = (x, n) => String(x).padStart(n);
console.log('冷却の組み合わせ                        上下差 厚板  薄板 │ 先端の浮き 厚板   薄板');
for (const r of R)
  console.log(`${r.name.padEnd(34)}${P(r.dTBthick.toFixed(1), 8)} K${P(r.dTBthin.toFixed(1), 6)} K │`
    + `${P(r.tipThick.toFixed(0), 10)} mm${P(r.tipThin.toFixed(0), 6)} mm`);

const [dflt, B, topOnly, bothSides, botOff, topNoBot] = R;
const checks = [];
const ok = (n, c, g, ref = false) => checks.push({ name: n, pass: !!c, got: g, ref });

ok('反りのモデルが生きている（上下差が付けば反る）', botOff.tipThick > dflt.tipThick * 1.5,
   `下面を切ると先端の浮きが ${dflt.tipThick.toFixed(0)} → ${botOff.tipThick.toFixed(0)} mm`);
ok('上下の «差» が反りを決める（差が大きいほど反る）',
   R.every(r => (r.dTBthick > dflt.dTBthick) === (r.tipThick > dflt.tipThick) || r === dflt),
   R.map(r => `${r.dTBthick.toFixed(1)}K→${r.tipThick.toFixed(0)}mm`).join(' '));
/* «入側冷却を入れても反らない» は、旧モデルが入側の上面と下面を一緒に入れていたせいだった。
 * 同じ基準（B）から、上面だけ足したときと上下とも足したときを比べれば、それが見える。 */
ok('入側の «上面だけ» を足すと上下差が付いて反りが増える',
   topOnly.tipThick > B.tipThick && topOnly.dTBthick > B.dTBthick,
   `B ${B.tipThick.toFixed(0)} mm（${B.dTBthick.toFixed(1)} K）→ 上面のみ ${topOnly.tipThick.toFixed(0)} mm（${topOnly.dTBthick.toFixed(1)} K）`);
ok('入側を «上下とも» 足すと、その増分が打ち消される',
   Math.abs(bothSides.tipThick - B.tipThick) < Math.abs(topOnly.tipThick - B.tipThick),
   `上面のみ ${(topOnly.tipThick - B.tipThick).toFixed(0)} mm 増 ／ 上下とも ${(bothSides.tipThick - B.tipThick).toFixed(0)} mm 増`);
ok('薄板は板厚方向に均されるので上下差が残りにくい', dflt.dTBthin < dflt.dTBthick / 3,
   `厚板 ${dflt.dTBthick.toFixed(1)} K / 薄板 ${dflt.dTBthin.toFixed(1)} K`);
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
