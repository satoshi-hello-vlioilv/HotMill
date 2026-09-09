// 設備ラベル（タグ）のアンカーが «実物のメッシュ» の上にあるかの実測。
//   node labeltrace.mjs [--dump]
// ラベル文言 → シーン中のメッシュ名（前方一致）を対応づけ、そのメッシュ群のワールド AABB を
// 出して «アンカーが AABB からどれだけ外れているか» を測る。判定は軸ごと:
//   ・X / Z は AABB の中に入っていること（タグが指すものの真上に来る）
//   ・Y は AABB の中か、上へ TOP_MARGIN 以内（«上に浮かせて置く» のは許す）
import { openApp, installHelpers } from './harness.mjs';
const DUMP = process.argv.includes('--dump');
const TOP = 1600;                     // 上へ逃がしてよい高さ [mm]
const CFLIP = -1;                     // 正準向き（第 1 パスが +X）→ 世界 X の符号。CONFIG.FLIP と一致させる

// ラベル文言（前方一致）→ 実物のメッシュ名（前方一致。複数可）
const MAP = [
  ['圧延スタンド',       ['ハウジング', 'スタンド構造']],
  ['ワークロール',       ['ワークロール']],
  ['バックアップロール',  ['バックアップロール']],
  ['油圧圧下シリンダ',    ['圧下シリンダ', '圧下ロッド']],
  ['ロールチョック',     ['WRチョック', 'BRチョック']],
  ['パスライン調整ウェッジ', ['パスライン調整ウェッジ']],
  ['ユニバーサルスピンドル', ['スピンドル平頭', '駆動系']],
  ['サイドガイド',       ['サイドガイドバー', 'サイドガイド架台']],
  ['入側 板面冷却',      ['板面クーラント架台', '板面クーラント梁', '板面クーラントヘッダ']],
  ['出側 板面冷却',      ['板面クーラント架台', '板面クーラント梁', '板面クーラントヘッダ']],
  ['転倒装置',          ['転倒装置基部', '転倒アーム']],
  ['トランスファークレーン', ['トランスファークレーン走行路', 'トランスファークレーン桁']],
  ['装入クレーン（ワイヤ吊り）', ['クレーン走行路', '装入クレーン桁']],
  ['サイドトリマー',      ['トリマー刃', 'サイドトリマー架構']],
  ['75 mm クロップシャー', ['75mmシャー架構(OS)', '75mmシャー架構(DS)']],
  ['クロップ屑コンベア',   ['屑傾斜コンベア架構', '屑箱']],
  ['30 mm シャー',      ['30mmシャー架構(OS)', '30mmシャー架構(DS)']],
  ['パイラー',          ['パイラー']],
  // 駆動系は «スピンドル〜ピニオン〜主電動機» を 1 つに束ねたメッシュなので、
  // ピニオンスタンドと主電動機はその中に入っているかだけを見る
  ['ピニオンスタンド',    ['駆動系']],
  ['主電動機',          ['駆動系']],
  // 入側／出側テーブルはライン全長に渡るので、«正しい側にあるか»（世界 X の符号）で見る
  ['入側テーブル',       ['テーブルローラ', 'テーブル架台'], -CFLIP],
  ['出側テーブル',       ['テーブルローラ', 'テーブル架台'],  CFLIP],
  ['板置き場',          ['板置き場スキッド']],
  ['スリーロール',       ['スリーロール架構']],
  ['巻取リール',         ['マンドレル芯', 'マンドレルセグメント']],
  ['ピット炉',          ['ピット炉', '炉蓋']],
  ['スラブヤード',       ['ヤードスラブ', 'ヤードスキッド']],
  ['装入クレーン',       ['装入クレーン桁', 'クレーン走行路']],
];

const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate((MAP) => {
  const A = window.__app, K = window.__CFG, S = K.SCALE;
  const boxes = {};
  const grow = (b, x, y, z) => { const v = [x / S, y / S, z / S];
    for (let i = 0; i < 3; i++) { if (v[i] < b.lo[i]) b.lo[i] = v[i]; if (v[i] > b.hi[i]) b.hi[i] = v[i]; } };
  A.world.scene.traverse(o => {
    if (!o.isMesh || !o.name || !o.geometry) return;
    o.updateWorldMatrix(true, false);
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox; if (!bb) return;
    const b = boxes[o.name] ||= { lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] };
    const corners = [];
    for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) corners.push([x, y, z]);
    const apply = (E) => { for (const [x, y, z] of corners)
      grow(b, E[0]*x + E[4]*y + E[8]*z + E[12], E[1]*x + E[5]*y + E[9]*z + E[13], E[2]*x + E[6]*y + E[10]*z + E[14]); };
    // インスタンスは «実際に置かれた 1 本ずつ» を見る（原点にある素のメッシュは数えない）
    if (o.isInstancedMesh) { const m = new o.matrixWorld.constructor();
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); m.premultiply(o.matrixWorld); apply(m.elements); } }
    else apply(o.matrixWorld.elements);
  });
  const names = Object.keys(boxes);
  const labels = A.world.labels.items.map(it => ({ t: it.el.textContent, p: [it.v.x / S, it.v.y / S, it.v.z / S] }));
  const rows = [];
  for (const l of labels) {
    const ent = MAP.find(([pre]) => l.t.startsWith(pre));
    if (!ent) { rows.push({ t: l.t, p: l.p, miss: true }); continue; }
    const box = { lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] };
    let n = 0;
    for (const pre of ent[1]) for (const nm of names) if (nm.startsWith(pre)) { n++;
      for (let i = 0; i < 3; i++) { box.lo[i] = Math.min(box.lo[i], boxes[nm].lo[i]); box.hi[i] = Math.max(box.hi[i], boxes[nm].hi[i]); } }
    if (!n) { rows.push({ t: l.t, p: l.p, nomesh: ent[1].join('/') }); continue; }
    const d = [0, 1, 2].map(i => l.p[i] < box.lo[i] ? box.lo[i] - l.p[i] : l.p[i] > box.hi[i] ? l.p[i] - box.hi[i] : 0);
    const side = ent[2] ? Math.sign(l.p[0]) === Math.sign(ent[2]) : true;
    rows.push({ t: l.t, p: l.p, box, d, above: l.p[1] > box.hi[1], side, wantSide: ent[2] ?? 0 });
  }
  return { rows, names };
}, MAP);

if (DUMP) for (const n of out.names.sort()) console.log('  ' + n);
let ng = 0;
for (const r of out.rows) {
  const P = `(${r.p.map(v => v.toFixed(0)).join(', ')})`;
  if (r.miss) { console.log(`  --   ${r.t.padEnd(26)} ${P}  対応するメッシュ名を MAP に登録していない`); continue; }
  if (r.nomesh) { ng++; console.log(`  NG   ${r.t.padEnd(26)} ${P}  «${r.nomesh}» がシーンに無い`); continue; }
  const [dx, dy, dz] = r.d;
  const okY = dy === 0 || (r.above && dy <= TOP);
  const ok = dx === 0 && dz === 0 && okY && r.side;
  if (!ok) ng++;
  const B = `x[${r.box.lo[0].toFixed(0)}, ${r.box.hi[0].toFixed(0)}] y[${r.box.lo[1].toFixed(0)}, ${r.box.hi[1].toFixed(0)}] z[${r.box.lo[2].toFixed(0)}, ${r.box.hi[2].toFixed(0)}]`;
  const sd = r.wantSide ? `／ 側 ${r.side ? 'ok' : 'NG'}（要 X ${r.wantSide > 0 ? '＞' : '＜'} 0）` : '';
  console.log(`  ${ok ? 'ok ' : 'NG '}  ${r.t.padEnd(26)} ${P} はみ出し ΔX ${dx.toFixed(0)} / ΔY ${dy.toFixed(0)}${r.above ? '(上)' : ''} / ΔZ ${dz.toFixed(0)} ${sd} 実物 ${B}`);
}
console.log(`RESULT: ${ng === 0 ? 'PASS' : 'FAIL'} (${out.rows.length - ng}/${out.rows.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
