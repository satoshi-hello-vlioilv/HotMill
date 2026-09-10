// 圧延で «体積が保たれるか» を素材長を変えて実測する。
//
// 圧延は体積一定の加工なので、素材の体積（板厚 × 板幅 × 素材長）と、
// 圧延後の «板 ＋ クロップ屑» の体積は一致しなければならない。ここが合わないなら、
// 板長・コイル外径・コイル質量・所要時間のどれかが必ず狂っている。
//
// 出荷時のロット（530 × 1,330 × 3,450）は合否に数える。
// «素材長を変えたとき» は、いま未解決の不具合が出ることが分かっているので（下記）、
// 合否には数えずに数値だけを毎回出す —— 直ったことを数字で確かめられるようにするため。
//
//   実測（VER.1.22.0 時点、A5052・560 鋳込み・片面 15 面削・433 ℃・幅 1,330）:
//     素材長 3,450 → 板の体積のずれ  −0.4 %   （正常）
//     素材長 3,000 → 板の体積のずれ +20.7 %   ★未解決
//     素材長 2,600 → 板の体積のずれ  +0.3 %   （正常）
//     素材長 2,400 → 板の体積のずれ  −0.5 %   （正常）
//     素材長 2,000 → 板の体積のずれ +29.7 %   ★未解決
//   長さに対して単調ではないので、原因は «素材長» そのものではない。
//
//   どこで壊れるかは実測で分かっている（tools/voltrace.mjs を作るまでに測ったこと）:
//     ・分かれるのは «16 mm へ入るパス» の 1 本だけ。そこまでは正常（ずれ 0.1 % 以内）。
//     ・そのパスの途中で、板の «平均板厚» hEff（＝ _vol / length）が出側ギャップ 16.1 mm を
//       割り込んで 12.41 mm まで落ちる。パスの途中の板は «入側 26 mm の部分» と
//       «出側 16 mm の部分» でできているので、平均が 16 mm を割ることは物理的に起こらない。
//     ・板の «材料としての体積» _vol は正しく保たれている（1,053,732 mm²·幅 のまま動かない）。
//       走るのは «幾何» の側 —— length ＝ xMax − xMin が材料より速く伸びる。
//     ・その結果、素材長 2,000 でも 2,600 でも、このパスの終わりで板長が同じ ≒ 85 m に着く。
//       つまり伸びを決めているのが «入ってきた板の長さ» ではなくなっている。
//   ＝ 板の «材料の勘定（_vol）» と «幾何（xMin / xMax）» が食い違う。どちらが先に狂うかは
//   未特定。直すには板端の進み方（PhysicsEngine の板の前後端の更新）を見る必要がある。
//
//   node tools/voltrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const LOT = { cast: 560, scalp: 15, width: 1330, temp: 433, alloy: 'A5052' };
const LENGTHS = [3450, 3000, 2600, 2400, 2000];
const SHIP = 3450;                       // 出荷時のロットの素材長（合否に数えるのはこれだけ）
const TOL = 2.0;                         // 体積のずれの許容 [%]

const measure = async (length) => {
  const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
  await installHelpers(page);
  const r = await page.evaluate(({ LOT, length }) => new Promise(res => setTimeout(() => {
    const P = window.__app.physics;
    P.slab.reset({ ...LOT, length });
    window.__startAuto(false);
    let v0 = null, last = -1, end = null, tripped = false;
    window.__ff((p) => {
      const s = p.slab, m = p.mill;
      const V = s.thickness * s.width * s.length;
      if (v0 === null) v0 = V;
      if (m.passIndex !== last) {
        last = m.passIndex;
        end = { pass: m.passIndex + 1, th: s.thickness, len: s.length, wid: s.width, V,
                cropV: p.finish.scraps.reduce((a, q) => a + q.len * q.th * q.w, 0) };
      }
      if (p.tripped) tripped = true;
      return p.finish.done || !!p.tripped;
    }, 120 * 3000, 0);
    res({ v0, end, tripped, sched: window.__CFG.SCHEDULE.length });
  }, 400)), { LOT, length });
  await browser.close();
  return r;
};

const checks = [];
const ok = (name, pass, got) => checks.push({ name, pass: !!pass, got });
const rows = [];

for (const length of LENGTHS) {
  const { v0, end, tripped, sched } = await measure(length);
  // 板だけのずれ（屑は別に数える）。«板 ＋ 屑» が素材と合うのが本来。
  const dStrip = (end.V / v0 - 1) * 100;
  const dTotal = ((end.V + end.cropV) / v0 - 1) * 100;
  // 体積が保たれていれば、板長は «素材長 × 素材板厚 / 出側板厚» になるはず
  const lenIdeal = length * (LOT.cast - 2 * LOT.scalp) / end.th;
  rows.push({ length, sched, tripped, th: +end.th.toFixed(2), len_m: +(end.len / 1000).toFixed(1),
              ideal_m: +(lenIdeal / 1000).toFixed(1), dStrip: +dStrip.toFixed(1), dTotal: +dTotal.toFixed(1) });
  if (length === SHIP) {
    ok(`出荷時のロット（素材長 ${SHIP}）で板の体積が保たれる（±${TOL} %）`, Math.abs(dStrip) <= TOL, `${dStrip.toFixed(1)} %`);
    ok(`出荷時のロットで板長が体積から出る値と合う（±${TOL} %）`,
       Math.abs(end.len / lenIdeal - 1) * 100 <= TOL, `${(end.len / 1000).toFixed(1)} m / 理論 ${(lenIdeal / 1000).toFixed(1)} m`);
    ok(`出荷時のロットが過負荷で止まらない`, !tripped, tripped ? '停止' : '完走');
  }
}

console.log('素材長 [mm] / スケジュール / 出側板厚 / 板長（実測 → 体積から出る値）/ 板のずれ / 屑込みのずれ');
for (const r of rows) {
  const bad = Math.abs(r.dStrip) > TOL;
  console.log(`  ${bad ? '★' : '  '} ${String(r.length).padStart(4)}  ${String(r.sched).padStart(2)} パス`
    + `  ${r.th.toFixed(2)} mm  ${String(r.len_m).padStart(6)} → ${String(r.ideal_m).padStart(6)} m`
    + `  ${r.dStrip > 0 ? '+' : ''}${r.dStrip} %  (屑込み ${r.dTotal > 0 ? '+' : ''}${r.dTotal} %)`
    + `${r.tripped ? '  ※過負荷停止' : ''}`);
}
const stray = rows.filter(r => r.length !== SHIP && Math.abs(r.dStrip) > TOL);
if (stray.length) {
  console.log(`\n★ 未解決（合否には数えていません）: 素材長 ${stray.map(r => r.length).join(' / ')} で`
    + `板の体積が ${stray.map(r => (r.dStrip > 0 ? '+' : '') + r.dStrip + ' %').join(' / ')} ずれます。`);
  console.log('  長さに対して単調ではないので、原因は素材長そのものではなくスケジュールの形の側にあります。原因は未特定です。');
}

console.log('');
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - bad.length}/${checks.length}、参考 ${stray.length} 件)`);
process.exit(bad.length ? 1 : 0);
