/* ロールコーティングとブラシロールの検査。
 *
 * アルミの熱間圧延では、ロールと材料の摩擦で «アルミ ＋ その酸化物 ＋ 圧延油» が
 * 高温高圧下でワークロールに凝着して層（ロールコーティング）を作る。あると摩擦が上がって
 * 噛み込みが良くなるが、厚すぎ／不均一だと板へ移着して表面欠陥になり、薄すぎるとスリップ・
 * 噛み込み失敗で圧延が不安定になる（古河スカイ技術解説「アルミニウム板圧延技術」）。
 * それを «ちょうど良い» に保つのがワークロールに押し付けるブラシロールで、
 * 除去能力は砥粒の選定と回転数（ノッチ）で決まる。
 *   node tools/brushtrace.mjs
 */
import { openApp, installHelpers } from './harness.mjs';
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, B = K.BRUSH;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });

  // --- 1. 実機の仕様表どおりか ---
  {
    const want = {
      HN: ['13S-80-K', 'SiC',   'チャンネル', '小'],
      SN: ['10S-80-K', 'Al₂O₃', 'チャンネル', '小'],
      MN: ['6R-240-3H', 'SiC',  'ディスク',  '大'],
    };
    const bad = [];
    for (const [k, w] of Object.entries(want)) {
      const sp = B.SPEC[k];
      if (!sp) { bad.push(`${k} が無い`); continue; }
      if (sp.code !== w[0] || sp.grit !== w[1] || sp.type !== w[2] || sp.dens !== w[3])
        bad.push(`${k}: ${sp.code}/${sp.grit}/${sp.type}/${sp.dens}`);
    }
    ok('ブラシ 3 種の仕様が実機の表どおり（名称・砥粒・タイプ・植毛密度）', bad.length === 0,
       bad.join(' ／ ') || Object.values(B.SPEC).map(s => `${s.key} ${s.code}/${s.grit}/${s.type}/${s.dens}`).join(' ／ '));
    // 番手が粗く太いものほど削り、細かく密なディスク型ほど均す
    ok('除去力は HN > SN > MN、均一化は MN > SN > HN',
       B.SPEC.HN.REM > B.SPEC.SN.REM && B.SPEC.SN.REM > B.SPEC.MN.REM
       && B.SPEC.MN.EVEN > B.SPEC.SN.EVEN && B.SPEC.SN.EVEN > B.SPEC.HN.EVEN,
       `除去 ${B.SPEC.HN.REM}/${B.SPEC.SN.REM}/${B.SPEC.MN.REM} ／ 均一化 ${B.SPEC.HN.EVEN}/${B.SPEC.SN.EVEN}/${B.SPEC.MN.EVEN}`);
  }
  // --- 2. ノッチ（5 ノッチだけ 15 Hz というイレギュラー設定） ---
  {
    const hz = [1, 2, 3, 4, 5, 6].map(n => R.brushHz(n));
    ok('ノッチは 6 段・10〜60 Hz の 10 Hz 刻み、ただし 5 ノッチだけ 15 Hz',
       hz.join() === [10, 20, 30, 40, 15, 60].join(), `1〜6 ノッチ = ${hz.join(' / ')} Hz`);
    ok('ノッチの範囲外は端で頭打ちになる', R.brushHz(0) === 10 && R.brushHz(9) === 60,
       `0 → ${R.brushHz(0)} Hz ／ 9 → ${R.brushHz(9)} Hz`);
  }
  // --- 3. 既定のブラシ条件（5000 系の実機例） ---
  {
    const plan = R.brushPlan('A5052');
    const row = a => plan.find(r => r.at === a);
    ok('既定は F-5〜F-3 が SN 全長、F-2 が SN 半分、F-1 と F は無し',
       [5, 4, 3].every(a => row(a) && row(a).brush === 'SN' && row(a).cov === 1)
       && row(2) && row(2).brush === 'SN' && row(2).cov === 0.5
       && row(1) && !row(1).brush && row(0) && !row(0).brush,
       plan.map(r => `F${r.at ? '-' + r.at : ''}: ${r.brush || '—'}${r.brush ? ` ${r.cov * 100}% N${r.notch}` : ''}`).join(' ／ '));
    // 全材質が同じ既定（材質別の上書きはまだ入れていない）
    const keys = Object.keys(K.ALLOYS);
    ok('いまは全材質が同じ既定条件（材質別に上書きできる）',
       keys.every(k => R.brushPlan(k) === B.DEFAULT), `${keys.length} 材質 ／ 上書き ${Object.keys(B.BY_ALLOY).length} 件`);
    // 上書きが効くこと
    B.BY_ALLOY.__T = [{ at: 3, brush: 'HN', cov: 1, notch: 6 }];
    const hit = R.brushAt(K.SCHEDULE.length - 4, K.SCHEDULE.length, '__T');
    const miss = R.brushAt(K.SCHEDULE.length - 6, K.SCHEDULE.length, '__T');
    delete B.BY_ALLOY.__T;
    ok('材質ごとの上書きが効き、書いていないパスには掛からない', hit && hit.brush === 'HN' && miss === null,
       hit ? `F-3 → ${hit.brush} N${hit.notch} ／ F-5 → ${miss ? miss.brush : '掛けない'}` : '上書きが効かない');
  }
  // --- 4. パスの指定が «最終パスから数えて» になっているか ---
  {
    const n = K.SCHEDULE.length;
    const at = i => { const r = R.brushAt(i, n, 'A5052'); return r ? `${r.brush}${r.cov * 100}` : '—'; };
    ok('ブラシは最終パスから数えて掛かる（F-5〜F-2）',
       at(n - 1) === '—' && at(n - 2) === '—' && at(n - 3) === 'SN50' && at(n - 4) === 'SN100'
       && at(n - 6) === 'SN100' && at(n - 7) === '—',
       `F ${at(n - 1)} ／ F-1 ${at(n - 2)} ／ F-2 ${at(n - 3)} ／ F-3 ${at(n - 4)} ／ F-5 ${at(n - 6)} ／ F-6 ${at(n - 7)}`);
  }
  // --- 5. 摩擦係数への効き ---
  {
    const lo = R.coatMu(B.C_LO), nom = R.coatMu(B.C_NOM), hi = R.coatMu(B.C_HI);
    ok('コーティングが厚いほど摩擦が上がる（標準の厚みで 1.00）',
       Math.abs(nom - 1) < 1e-9 && lo < 1 && hi > 1,
       `薄い ${B.C_LO} µm → ${lo.toFixed(3)} ／ 標準 ${B.C_NOM} → ${nom.toFixed(3)} ／ 厚い ${B.C_HI} → ${hi.toFixed(3)}`);
    /* 頭打ちは «式が暴れないための安全弁»。健全域（C_LO〜C_HI）の中では効かず、
     * そこを大きく外れたときだけ効く —— それを両方確かめる。 */
    const span = [B.C_LO, B.C_HI].map(c => R.coatMu(c));
    ok('摩擦への効きに頭打ちがあり、健全域の中では効かない',
       R.coatMu(-1e6) === B.MU_MIN && R.coatMu(1e6) === B.MU_MAX
       && span.every(v => v > B.MU_MIN && v < B.MU_MAX),
       `頭打ち ${B.MU_MIN}〜${B.MU_MAX} ／ 健全域 ${B.C_LO}〜${B.C_HI} µm で ${span[0].toFixed(3)}〜${span[1].toFixed(3)}`);
  }

  // --- 6. 1 ロット流して «積もる → 削る» の循環を見る ---
  window.__startAuto(false);
  const rows = [];
  let last = -1, coatMin = 1e9, coatMax = 0, sdMax = 0, brushedPasses = new Set(), onFrames = 0;
  window.__ff((p, n) => {
    const m = p.mill, s = p.slab;
    if (m.passIndex >= 0 && s.inBite) { coatMin = Math.min(coatMin, m.coat); coatMax = Math.max(coatMax, m.coat); sdMax = Math.max(sdMax, m.coatSd); }
    if (m.brushOn) { brushedPasses.add(m.passIndex); onFrames++; }
    if (m.passIndex !== last && last >= 0)
      rows.push({ pass: last + 1, coat: +m.coat.toFixed(2), sd: +m.coatSd.toFixed(3), mu: +R.coatMu(m.coat).toFixed(3) });
    last = m.passIndex;
    return p.finish.done || p.tripped;
  }, 120 * 3000, 0);

  const nP = K.SCHEDULE.length;
  ok('ブラシが掛かったのは F-5〜F-2 の 4 パスだけ',
     brushedPasses.size === 4 && [...brushedPasses].every(i => nP - 1 - i >= 2 && nP - 1 - i <= 5),
     [...brushedPasses].sort((a, b) => a - b).map(i => `#${i + 1}(F-${nP - 1 - i})`).join(' ') || 'ブラシが当たっていない');
  ok('圧延するとコーティングが積もる（ブラシ前が標準より厚い）', coatMax > B.C_NOM,
     `最大 ${coatMax.toFixed(2)} µm（標準 ${B.C_NOM}）`);
  ok('ブラシで削れる（掛けたあとが掛ける前より薄い）', coatMin < B.C_NOM,
     `最小 ${coatMin.toFixed(2)} µm`);
  ok(`ロットを通してコーティングが健全域（${B.C_LO}〜${B.C_HI} µm）に収まる`,
     coatMin >= B.C_LO && coatMax <= B.C_HI, `${coatMin.toFixed(2)} 〜 ${coatMax.toFixed(2)} µm`);
  ok('ムラが移着を疑う目安を超えない', sdMax <= B.SD_WARN, `最大 ${sdMax.toFixed(3)} µm（目安 ${B.SD_WARN}）`);
  {
    const mus = rows.map(r => r.mu);
    const dev = Math.max(...mus.map(v => Math.abs(v - 1)));
    ok('摩擦係数の振れが 10 % 以内（荷重の較正を崩さない）', dev <= 0.10,
       `最大 ${(dev * 100).toFixed(1)} %（${Math.min(...mus).toFixed(3)} 〜 ${Math.max(...mus).toFixed(3)}）`);
  }
  return { checks, rows, coatMin: +coatMin.toFixed(2), coatMax: +coatMax.toFixed(2) };
});
// --- 7. 登録ダイアログ（材質を選ぶ → 6 行を書き替える → 登録する） ---
const ui = await page.evaluate(async () => {
  const A = window.__app, K = window.__CFG, R = window.__ROLL, $ = (id) => document.getElementById(id);
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  const U = A.ui;
  U.openBrushDialog();
  const dlg = $('dlg-brush');
  ok('ブラシ条件のダイアログが開く', dlg.open, `open=${dlg.open}`);
  const rows = $('brush-tb').tBodies[0].rows;
  ok('パスの行が F-5 から F まで 6 行', rows.length === 6 && rows[0].cells[0].textContent.startsWith('F-5')
     && rows[5].cells[0].textContent.startsWith('F'),
     [...rows].map(r => r.cells[0].firstChild.textContent).join(' / '));
  ok('掛けないパスは薄く出て、長さとノッチが選べない', rows[5].classList.contains('off')
     && rows[5].querySelectorAll('select')[1].disabled,
     `F 行 off=${rows[5].classList.contains('off')}`);
  // 材質 A1100 に «F-3 だけ HN・全長・6 ノッチ» を登録する
  $('brush-alloy').value = 'A1100'; $('brush-alloy').oninput();
  for (const tr of rows) {
    const [br, cov, nt] = tr.querySelectorAll('select');
    const isF3 = tr.cells[0].firstChild.textContent === 'F-3';
    br.value = isF3 ? 'HN' : ''; br.oninput();
    if (isF3) { cov.value = '1'; nt.value = '6'; }
  }
  U._brushCommit();
  const plan = R.brushPlan('A1100');
  ok('材質ごとの条件が登録される（A1100 に F-3 だけ HN・6 ノッチ）',
     plan !== K.BRUSH.DEFAULT && plan.filter(r => r.brush).length === 1
     && plan.find(r => r.at === 3).brush === 'HN' && plan.find(r => r.at === 3).notch === 6,
     plan.filter(r => r.brush).map(r => `F-${r.at} ${r.brush} ${r.cov * 100}% N${r.notch}`).join(' ／ ') || '登録されていない');
  ok('ほかの材質は既定のまま', R.brushPlan('A5052') === K.BRUSH.DEFAULT,
     `A5052 は上書き ${K.BRUSH.BY_ALLOY.A5052 ? 'あり' : 'なし'}`);
  // 既定に戻すと上書きが消える
  U._brushWrite(K.BRUSH.DEFAULT); U._brushCommit();
  ok('既定と同じ内容を登録すると上書きが消える', R.brushPlan('A1100') === K.BRUSH.DEFAULT,
     `上書き ${Object.keys(K.BRUSH.BY_ALLOY).length} 件`);
  ok('条件の強さが «既定を 100 %» として出る', /除去の強さ/.test($('brush-est').textContent),
     $('brush-est').textContent.replace(/\s+/g, ' ').trim().slice(0, 90));
  dlg.close();
  return checks;
});
out.checks.push(...ui);
// --- 8. 3D のブラシロール（当たりの位置と逃げ） ---
const geo = await page.evaluate(() => {
  const A = window.__app, W = A.world, K = window.__CFG, S = K.SCALE, T = window.__T, B = K.BRUSH;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
  const M = A.physics.mill, V = W.millView;
  ok('ブラシロールが上下に 1 本ずつある', V.brushes && V.brushes.length === 2,
     (V.brushes || []).map(b => b.g.name).join(' / '));
  const at = (on) => { M.brushOn = on; V.update(M); W.render(A.physics, 0.1);
    return V.brushes.map(b => {
      const cy = b.sy > 0 ? M.wrTopY : M.wrBotY, wr = (b.sy > 0 ? M.wrDiaTop : M.wrDiaBot) / 2;
      const d = Math.hypot(b.g.position.x / S, b.g.position.y / S - cy);
      return +(d - wr - B.ROLL_D / 2).toFixed(1);                 // ワークロール面との隙間 [mm]
    }); };
  const press = at(true), lift = at(false);
  M.brushOn = false;
  ok('当てているときワークロール面に接する', press.every(v => Math.abs(v) < 1), `隙間 ${press.join(' / ')} mm`);
  ok('当てていないときは半径方向へ逃げる', lift.every(v => Math.abs(v - B.LIFT) < 1), `隙間 ${lift.join(' / ')} mm（逃げ ${B.LIFT}）`);
  // バックアップロール（真上・真下）と板（パスライン）を避けた位置に居ること
  const box = o => { const b = new T.Box3().setFromObject(o); return { y: [b.min.y / S, b.max.y / S], x: [b.min.x / S, b.max.x / S] }; };
  V.update(M);
  const bad = [];
  for (const b of V.brushes) {
    const bb = box(b.hair), other = box(b.sy > 0 ? V.rolls.backupTop : V.rolls.backupBot);
    if (bb.y[0] < other.y[1] && bb.y[1] > other.y[0] && bb.x[0] < 0 && bb.x[1] > 0) bad.push(`${b.g.name} が BUR と重なる`);
  }
  ok('ブラシがバックアップロールと取り合わない', bad.length === 0, bad.join(' ／ ') || '上下とも入側寄りの斜め上に居る');
  ok('面長がワークロールの胴長と同じ', B.BARREL === K.MILL.BARREL, `${B.BARREL} / ロール胴 ${K.MILL.BARREL} mm`);
  return checks;
});
out.checks.push(...geo);
console.log('パス  厚み  ムラ  摩擦倍率');
for (const r of out.rows) console.log(String(r.pass).padStart(3), String(r.coat).padStart(6), String(r.sd).padStart(6), String(r.mu).padStart(7));
for (const c of out.checks) console.log(c.pass ? '  PASS' : '  FAIL', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
await browser.close();
