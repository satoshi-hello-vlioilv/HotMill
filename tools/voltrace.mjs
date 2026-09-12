// 圧延で «体積が保たれるか» を素材長を変えて実測する。
//
// 圧延は体積一定の加工なので、素材の体積（板厚 × 板幅 × 素材長）と、
// 圧延後の «板 ＋ クロップ屑» の体積は一致しなければならない。ここが合わないなら、
// 板長・コイル外径・コイル質量・所要時間のどれかが必ず狂っている。
//
// 合否に数えるのは «板 ＋ 切り落とした材料 ＝ 素材» —— これが体積保存の法。
// «板だけの体積» はクロップで落ちたぶん必ず減るので、合否には数えず参考に出す。
//
// 板の材料体積は «長手プロファイルの積分»（SlabState.matVolume）で数える。
// «板厚 × 板長» はパスが終わっているときしか正しくない —— 過負荷などでパスの途中で
// 止まると、もう圧延した部分まで入側の厚みで数えてしまう。
//
// 【直した不具合】素材長 3,000 / 2,000 で体積が «作られて» いた（+21.8 % / +134.7 %）。
// 原因は SlabState.cropProfile —— 端を切ったときの材料座標の張り直しで、そのパスが
// そこまで書いた «出側» の板厚（_hNext）を «入側»（hProf）から作り直していた。
// パスの途中で切ると、もう圧延した区間が «入側の厚いまま» に戻り、そこは材料座標が
// 一方向にしか進まないのでそのパスでは二度と書かれない。次のパスはそれを入側として
// 読むので、質量流の比 gap/h_in が小さくなりすぎて入側の端が進まず、板が伸びすぎる。
// 実測（素材長 2,000・パス 20 の途中で切ったとき）:
//     _hNext[0] が 26.3 → 36.2 に戻り、プロファイルの 0..180 番が 36.1 のまま残った
//     → 次のパス（26 → 16 mm）で板長が 40.2 → 85.3 m（正しくは 65.4 m）
// 出側バッファは «出側バッファのまま» 張り直し、重み・書けた範囲・材料座標も
// 一緒に動かすようにして直した。
//
//   node tools/voltrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const LOT = { cast: 560, scalp: 15, width: 1330, temp: 433, alloy: 'A5052' };
/* --only=3450 のように渡すと、その素材長だけを測る（原因を追うときに速く回すため）。 */
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7)
  .split(',').filter(Boolean).map(Number);
const LENGTHS = (ONLY.length ? ONLY : [3450, 3000, 2600, 2400, 2000]);
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
    /* «切り落とした材料» を板の側から数える。屑ピースの len は張り出しの先端までの
     * 距離なので、そのまま体積にすると張り出し（中身の詰まっていない形）を
     * 満杯の角材として数えてしまう。板の論理長がカットの前後でどれだけ減ったかを
     * 積むほうが、材料の勘定としては正しい。 */
    let cutV = 0, cutLen = 0, cuts = 0, prevLen = null, prevTh = null, prevCuts = 0;
    /* 板の材料体積は «長手プロファイルの積分»（SlabState.matVolume）で数える。
     * «板厚 × 板長» はパスが終わっているときしか正しくない —— 過負荷などで途中で
     * 止まると、もう圧延した部分まで入側の厚みで数えてしまう（実測: 素材長 2,000 で
     * +86 % のずれに «見えて» いた。材料そのものは保たれていた）。 */
    window.__ff((p) => {
      const s = p.slab, m = p.mill;
      const V = s.matVolume;
      if (v0 === null) v0 = V;
      if (prevLen !== null && p.finish.cropCutsAll > prevCuts) {
        const d = prevLen - s.length;                 // このカットで板が短くなった長さ
        if (d > 0) { cutLen += d; cutV += d * prevTh * s.width; }   // 切った端の厚みは «そのときの» 板厚
        cuts = p.finish.cropCutsAll;
      }
      prevCuts = p.finish.cropCutsAll; prevLen = s.length; prevTh = s.thickness;
      if (m.passIndex !== last) {
        last = m.passIndex;
        end = { pass: m.passIndex + 1, th: s.thickness, len: s.length, wid: s.width, V,
                cutV, cutLen, cuts,
                cropV: p.finish.scraps.reduce((a, q) => a + q.len * q.th * q.w, 0) };
      }
      if (p.tripped) tripped = true;
      return p.finish.done || !!p.tripped;
    }, 120 * 3000, 0);
    if (end) { end.cutV = cutV; end.cutLen = cutLen; end.cuts = cuts; }
    res({ v0, end, tripped, sched: window.__CFG.SCHEDULE.length });
  }, 400)), { LOT, length });
  await browser.close();
  return r;
};

const checks = [];
/* ref を立てた判定は «参考» —— 合否に数えず、数値だけを毎回出す（CLAUDE.md の決め）。 */
const ok = (name, pass, got, ref = false) => checks.push({ name, pass: !!pass, got, ref });
const rows = [];

for (const length of LENGTHS) {
  const { v0, end, tripped, sched } = await measure(length);
  // 板だけのずれ（屑は別に数える）。«板 ＋ 屑» が素材と合うのが本来。
  const dStrip = (end.V / v0 - 1) * 100;
  const dTotal = ((end.V + end.cropV) / v0 - 1) * 100;
  // «板 ＋ 切り落とした材料» が素材と合うか（これが本来の体積保存）
  const dCut = ((end.V + end.cutV) / v0 - 1) * 100;
  // 体積が保たれていれば、板長は «素材長 × 素材板厚 / 出側板厚» になるはず
  const lenIdeal = length * (LOT.cast - 2 * LOT.scalp) / end.th;
  rows.push({ length, sched, tripped, th: +end.th.toFixed(2), len_m: +(end.len / 1000).toFixed(1),
              ideal_m: +(lenIdeal / 1000).toFixed(1), dStrip: +dStrip.toFixed(1), dTotal: +dTotal.toFixed(1),
              dCut: +dCut.toFixed(1), cutLen: Math.round(end.cutLen), cuts: end.cuts });
  /* 体積保存はどの素材長でも成り立たなければならない。素材長で «たまたま» 通るのを
   * 見逃さないよう、全部を合否に数える（ここが 3,000 / 2,000 で壊れていた）。 */
  ok(`素材長 ${length} で «板 ＋ 切り落とした材料» が素材と合う（±${TOL} %）`,
     Math.abs(dCut) <= TOL, `${dCut.toFixed(1)} %（板長 ${(end.len / 1000).toFixed(1)} m・`
     + `出側 ${end.th.toFixed(2)} mm・切り落とし ${end.cuts} 回 計 ${Math.round(end.cutLen)} mm`
     + `${tripped ? '・過負荷で途中停止' : ''}）`);
  if (length === SHIP) {
    /* 体積保存の «法» は «板 ＋ 切り落とした材料 ＝ 素材» であって、«板だけ» ではない。
     * クロップで落とした材料は板から消えるのが正しいので、板だけを見る判定は
     * «どれだけクロップしたか» を測っているにすぎない（クロップ長は実機の実測が
     * まだ無く、いまは長すぎることが分かっている —— README の残件「実機のクロップ長」）。
     * そこで合否に数えるのは «板 ＋ 切り落とし» のほうにし、板だけのずれは参考に回す。 */
    ok(`出荷時のロットが過負荷で止まらない`, !tripped, tripped ? '停止' : '完走');
    ok(`（参考）板だけのずれ ＝ クロップで落ちた割合`, Math.abs(dStrip) <= TOL,
       `${dStrip.toFixed(1)} %／板長 ${(end.len / 1000).toFixed(1)} m・クロップ前の理論 ${(lenIdeal / 1000).toFixed(1)} m`
       + `（クロップ長の実機値が未提供。README の残件「実機のクロップ長」）`, true);
  }
}

console.log('素材長 [mm] / スケジュール / 出側板厚 / 板長（実測 → クロップ前の理論）/ 板だけのずれ ／ 内訳');
for (const r of rows) {
  const bad = Math.abs(r.dCut) > TOL;
  console.log(`  ${bad ? '★' : '  '} ${String(r.length).padStart(4)}  ${String(r.sched).padStart(2)} パス`
    + `  ${r.th.toFixed(2)} mm  ${String(r.len_m).padStart(6)} → ${String(r.ideal_m).padStart(6)} m`
    + `  ${r.dStrip > 0 ? '+' : ''}${r.dStrip} %  (板＋切り落とし ${r.dCut > 0 ? '+' : ''}${r.dCut} % ／ 切り落とし ${r.cuts} 回 計 ${r.cutLen} mm ／ 屑ピースの見かけ ${r.dTotal > 0 ? '+' : ''}${r.dTotal} %)`
    + `${r.tripped ? '  ※過負荷停止' : ''}`);
}
/* «板だけ» のずれはクロップで落ちたぶんなので、不具合の印にはならない。
 * 体積が本当に壊れているのは «板 ＋ 切り落とし» が素材と合わない素材長だけ。 */
/* 過負荷でパスの途中で止まった素材長は «参考» として毎回出す。体積は保たれていても、
 * そのスケジュールがこのラインで通らないことは別の問題として見えていたほうがよい。 */
const trip = rows.filter(r => r.tripped);
if (trip.length) {
  console.log(`\n参考: 素材長 ${trip.map(r => r.length).join(' / ')} は過負荷で途中停止します`
    + `（${trip.map(r => `${r.th.toFixed(2)} mm・${r.len_m} m`).join(' / ')}）。`);
  console.log('  体積は保たれているので «材料の勘定» の不具合ではありません。スケジュールがこのラインの能力に');
  console.log('  収まっていない、という別の話です（残件«短い素材のスケジュール»）。');
}

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref);
const nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}`
  + `、参考 ${nRef} 件)`);
process.exit(bad.length ? 1 : 0);
