/* ピット炉の «仕様» と «スラブの置き方（パターン A / B / C）» を検査する。
 *
 * 実機の手順:
 *   ① 幅の大きい順に 1 … n と番号を振る（1 が最も幅の大きいスラブ）
 *   ② 1 番（最大）と n 番（最小）の幅を足し、2,660 mm 以下なら «組める»
 *   ③ 2 番と n−1 番 …… と (n/2) 組まで、すべての組を個別に見る
 *      （組の和は番号順に増減するとは限らないので途中で打ち切らない）
 *   ④ 組める組の数で並べ方が決まる。図の A は 7 組・B は 3 組・C は 0 組を要るので、
 *      満たせる中でいちばん組の多いパターンを選ぶ
 *   node tools/pitplan.mjs
 */
import { openApp, installHelpers } from './harness.mjs';
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const K = window.__CFG, L = window.__LAYOUT, F = K.FURNACE;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });

  // --- 1. 仕様表（実機の値どおりか） ---
  {
    const want = [
      [1, 90, 3810, 4760, 4050, '半直火炉'], [2, 90, 3810, 4760, 4050, '半直火炉'],
      [3, 90, 3810, 4760, 4050, '半直火炉'], [4, 90, 3810, 4760, 4050, '半直火炉'],
      [5, 90, 3810, 4760, 4050, '半直火炉'], [6, 90, 3810, 4760, 4050, '半直火炉'],
      [7, 100, 4600, 4300, 4800, '半直火炉'], [8, 100, 4600, 4300, 4800, '半直火炉'],
    ];
    const bad = [];
    for (const [no, cap, l, w, h, fire] of want) {
      const q = F.SPEC[no - 1];
      if (!q || q.no !== no || q.cap !== cap || q.L !== l || q.W !== w || q.H !== h || q.fire !== fire)
        bad.push(`${no} 号: ${q ? `${q.cap}t ${q.L}×${q.W}×${q.H} ${q.fire}` : '無し'}`);
    }
    ok('1〜8 号炉の仕様が実機の表どおり（能力・内法・燃焼方式）', bad.length === 0,
       bad.join(' ／ ') || '90 t 3810×4760×4050 ×6 ／ 100 t 4600×4300×4800 ×2');
    const p9 = F.SPEC[8];
    ok('9 号炉は 18 t・間接型（サイズは表に無いので推定と分かる印を持つ）',
       p9.cap === 18 && p9.fire === '間接型' && p9.est === true,
       `${p9.cap} t ／ ${p9.fire} ／ ${p9.L}×${p9.W}×${p9.H}（推定）`);
    ok('炉は 9 基', F.N === 9 && F.SPEC.length === 9, `${F.SPEC.length} 基`);
  }
  // --- 2. 内法と収容能力の整合（段数 × 列数 × 1 本の質量） ---
  {
    const AL = K.ALLOYS[K.MATERIAL.ALLOY], th = 530, len = 3450, wid = 1330;
    const one = len * wid * th * 1e-9 * AL.RHO / 1000;                 // 1 本の質量 [t]
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const sp = L.pitSpec(i), n = L.pitRows(i, th) * 2;
      rows.push({ no: sp.no, rows: L.pitRows(i, th), n, t: +(n * one).toFixed(0), cap: sp.cap });
    }
    const bad = rows.filter(r => Math.abs(r.t - r.cap) / r.cap > 0.12);
    ok('内法から数えた収容本数が表の能力と合う（±12 %）', bad.length === 0,
       rows.map(r => `${r.no} 号 ${r.rows} 段 × 2 列 ＝ ${r.n} 本 ${r.t} t（表 ${r.cap} t）`).slice(0, 2).join(' ／ ')
       + (bad.length ? ` ／ 外れ: ${bad.map(r => `${r.no} 号 ${r.t}/${r.cap} t`).join()}` : ''));
    ok('立てたスラブが炉の深さに収まる（最長 4,200 mm）',
       F.SPEC.slice(0, 8).every(q => q.H >= 3450) && F.SPEC[6].H >= 4200,
       `1〜6 号 H ${F.SPEC[0].H}（最長 3,450 まで）／ 7〜8 号 H ${F.SPEC[6].H}（4,200 まで）`);
  }
  // --- 3. パターンの判定 ---
  {
    const p = ws => L.pitPattern(ws);
    // 全部 1,330 mm（和 2,660 ＝ しきい値ちょうど）→ 全部組める → A
    const a = p(Array(14).fill(1330));
    ok('全幅 1,330 mm（和がしきい値ちょうど）は組めて パターン A', a.key === 'A' && a.pairs === 7,
       `${a.pairs} 組 → ${a.key}`);
    // 全部 1,400 mm（和 2,800）→ 1 組も組めない → C
    const c = p(Array(14).fill(1400));
    ok('全幅 1,400 mm（和 2,800）は 1 組も組めず パターン C', c.key === 'C' && c.pairs === 0,
       `${c.pairs} 組 → ${c.key}`);
    // 3 組だけ組める → B
    const mix = [2200, 2200, 2200, 2200, 1400, 1400, 1400, 1300, 1300, 1300, 400, 400, 400, 400];
    const b = p(mix);
    ok('組める数が 3〜6 組なら パターン B', b.pairs >= 3 && b.pairs < 7 && b.key === 'B',
       `${b.pairs} 組 → ${b.key} ／ 組の和 ${b.sums.map(q => q.sum).join(',')}`);
    /* 5 組・6 組のときも B でよい（ご確認済み）。B は 3 組しか使わないので 2〜3 組は
     * 余るが、それが実機の運用。«組める数がちょうど何組か» で分岐を増やさない。 */
    {
      const mk = (nPair) => {                       // nPair 組だけが 2,660 以下になる並びを作る
        const w = [];
        for (let i = 0; i < nPair; i++) { w.push(1330); w.push(1330); }        // 和 2,660（組める）
        for (let i = nPair; i < 7; i++) { w.push(2200); w.push(1000); }        // 和 3,200（組めない）
        return w;
      };
      const bad = [];
      for (const n of [3, 4, 5, 6]) { const q = p(mk(n)); if (!(q.pairs === n && q.key === 'B')) bad.push(`${n} 組 → ${q.pairs} 組 / ${q.key}`); }
      ok('5 組・6 組でも パターン B（余る組は使わない）', bad.length === 0,
         bad.join(' ／ ') || '3 / 4 / 5 / 6 組 いずれも B');
    }
    // 組の和は番号順に増減しない —— 途中で打ち切らずに全部見ていること
    /* 幅の大きい順に並べると [2600, 2500, 1300, 1300, 1200, 100, 100, 60]。
     * 組の和は 2660 / 2600 / 1400 / 2500 と «増えたり減ったり» する ——
     * 番号順に打ち切ると 3 番で判断を誤るので、全部見ていることを確かめる。 */
    const zig = [2600, 1200, 2500, 1300, 1300, 100, 100, 60];
    const z = p(zig);
    const want = [2660, 2600, 1400, 2500];
    ok('組の和を番号順に打ち切らず、すべての組を見ている',
       z.sums.length === 4 && z.sums.every((q, i) => q.sum === want[i]) && z.pairs === 4,
       z.sums.map(q => `${q.no} 番 ${q.big}+${q.small}=${q.sum}${q.ok ? '' : ' ✕'}`).join(' ／ '));
    // しきい値の «超える» 側
    const edge = p([1331, 1330]);
    ok('しきい値は «以下» が組める（2,661 は組めない）', edge.pairs === 0 && p([1330, 1330]).pairs === 1,
       `1331+1330 = 2661 → ${edge.pairs} 組 ／ 1330+1330 = 2660 → 1 組`);
  }
  // --- 4. 置き場所（図の数字順） ---
  {
    const pat = k => F.PATTERNS.find(q => q.key === k);
    const ws14 = Array(14).fill(1330), ws11 = Array(11).fill(1400), TH = 530;
    const sA = L.pitSlots(pat('A'), 0, ws14, TH), sB = L.pitSlots(pat('B'), 0, ws14, TH), sC = L.pitSlots(pat('C'), 0, ws11, TH);
    const rows = L.pitRows(0, TH);
    ok(`パターン A は 2 列 × ${rows} 段（縦置き無し）`,
       sA.length === rows * 2 && sA.every(q => !q.rot) && new Set(sA.map(q => Math.round(q.z))).size === 2,
       `${sA.length} 枠 ／ 縦置き ${sA.filter(q => q.rot).length}`);
    ok('パターン B は縦置き 2 本 ＋ 段', sB.filter(q => q.rot).length === 2 && sB.length > 2,
       `${sB.length} 枠（縦置き 2・横置き ${sB.length - 2}）`);
    ok('パターン C は縦置き 4 本 ＋ 1 列', sC.filter(q => q.rot).length === 4
       && sC.filter(q => !q.rot).every(q => Math.abs(q.z) < 1),
       `${sC.length} 枠（縦置き 4・横置き ${sC.length - 4}）`);
    ok('番号が 1 から抜けなく振られている（図の数字順）',
       [sA, sB, sC].every(a => a.every((q, i) => q.no === i + 1)),
       `A ${sA.length} / B ${sB.length} / C ${sC.length}`);
    ok('縦置きは番号の若い（幅の大きい）スラブに割り当てられる',
       sB.slice(0, 2).every(q => q.rot) && sC.slice(0, 4).every(q => q.rot),
       `B の 1,2 番 ／ C の 1〜4 番`);
    // 枠が炉の内法からはみ出さない
    const sp = L.pitSpec(0), bad = [];
    for (const [k, a] of [['A', sA], ['B', sB], ['C', sC]])
      for (const q of a) {
        const dx = q.rot ? (q.w || 1330) / 2 : 530 / 2, dz = q.rot ? 530 / 2 : (q.w || 1330) / 2;
        if (Math.abs(q.x) + dx > sp.L / 2 + 1 || Math.abs(q.z) + dz > sp.W / 2 + 1)
          bad.push(`${k} の ${q.no} 番`);
      }
    ok('どの枠も炉の内法に収まる', bad.length === 0, bad.slice(0, 4).join(' ／ ') || `内法 ${sp.L}×${sp.W} mm`);
  }
  return { checks };
});
for (const c of out.checks) console.log(c.pass ? '  PASS' : '  FAIL', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
await browser.close();
