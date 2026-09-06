// 圧延実績（ロギング）が «実際に起きたこと» と合っているかを見る評価器。
//
// なぜ要るか: ログは «後から数字だけを見る» ためのものなので、間違っていても画面では
// 気づけない。物理の状態と突き合わせて、記録が現実とずれていないことを機械で縛る。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG;
  const R = { checks: [] }, ok = (n, p, d = '') => R.checks.push({ name: n, pass: !!p, detail: d });
  const L = P.log;

  ok('運転前は記録が空', L.lot === null && L.passes.length === 0, `${L.passes.length} パス`);

  // 全パス走り切らせ、その間の «物理が指した最大値» を独立に拾っておく
  let fPeak = 0, vPeak = 0;
  window.__startAuto(false);
  window.__ff((p) => {
    fPeak = Math.max(fPeak, p.slab.rollForce || 0);
    vPeak = Math.max(vPeak, Math.abs(p.mill.currentSpeed));
    return p.mill.passIndex < 0 && p.log.passes.length >= K.SCHEDULE.length;
  }, 120 * 4000);

  const rows = L.rows, n = K.SCHEDULE.length;
  ok('パス数がスケジュールと一致', rows.length === n, `${rows.length} / ${n} パス`);
  ok('全パスが閉じている（所要時間が入る）', rows.every(r => r.sec !== null && r.sec > 0),
     `所要 ${rows.map(r => (r.sec ?? 0).toFixed(0)).join('/')} s`);

  // 板厚は «前のパスの出厚 = 次のパスの入厚» で繋がる
  const chain = rows.every((r, i) => i === 0 || Math.abs(r.hIn - rows[i - 1].hOut) < 0.05);
  ok('板厚が前のパスから連続している', chain,
     rows.map(r => `${r.hIn?.toFixed(0)}→${r.hOut?.toFixed(0)}`).join(' '));
  ok('入厚が素材の実厚から始まる', Math.abs(rows[0].hIn - L.lot.thick0) < 0.05,
     `${rows[0].hIn?.toFixed(1)} / 素材 ${L.lot.thick0.toFixed(1)} mm`);
  ok('最終の出厚が目標板厚に一致', Math.abs(rows[n - 1].hOut - L.lot.target) < 0.5,
     `${rows[n - 1].hOut?.toFixed(2)} / 目標 ${L.lot.target} mm`);
  ok('圧下率がすべて正（各パスで薄くなる）', rows.every(r => r.red > 0),
     `${rows.map(r => r.red.toFixed(0)).join('/')} %`);

  // 記録した最大値は «物理が指した最大値» を超えない（作り話をしていない）
  const fMax = Math.max(...rows.map(r => r.fMax)), vMax = Math.max(...rows.map(r => r.vMax));
  ok('記録の最大荷重が実際の最大を超えない', fMax <= fPeak + 1, `記録 ${fMax.toFixed(0)} / 実際 ${fPeak.toFixed(0)} t`);
  ok('記録の最大速度が実際の最大を超えない', vMax <= vPeak + 0.5, `記録 ${vMax.toFixed(1)} / 実際 ${vPeak.toFixed(1)} mpm`);
  ok('平均荷重は最大荷重以下（噛んでいる間の平均）', rows.every(r => r.fAvg <= r.fMax + 1e-6 && r.fAvg > 0),
     `最大の差 ${Math.max(...rows.map(r => r.fMax - r.fAvg)).toFixed(0)} t`);

  // 時系列は時間の順に並び、パス番号が飛ばない
  const S = L.series;
  ok('時系列が時間の昇順', S.every((p, i) => i === 0 || p.t >= S[i - 1].t), `${S.length} 点`);
  ok('時系列の間隔が指定のサンプリング周期に収まる',
     S.every((p, i) => i === 0 || (p.t - S[i - 1].t) <= 1 / window.__app.physics.log.constructor.SAMPLE_HZ + 0.05),
     `最大間隔 ${Math.max(...S.map((p, i) => i ? p.t - S[i - 1].t : 0)).toFixed(3)} s`);

  // CSV は «見出し 1 行 + パス数» の行を持つ（メタ行は # で始まる）
  const lines = L.csv().split('\n');
  const body = lines.filter(l => l && !l.startsWith('#'));
  ok('CSV がパス数ぶんの行を持つ', body.length === n + 1, `${body.length - 1} 行 + 見出し`);
  ok('CSV の列数が見出しと揃う', body.every(l => l.split(',').length === body[0].split(',').length),
     `${body[0].split(',').length} 列`);

  // 画面（表）と記録の行数が一致する
  A.ui.toggleLog(true);
  const tr = document.querySelectorAll('#log-table tbody tr');
  ok('画面の表が記録と同じ行数を描く', tr.length === n, `${tr.length} 行`);
  ok('時系列グラフが描かれている', !!document.querySelector('#log-chart svg path'),
     `${document.querySelectorAll('#log-chart svg path').length} 本の折れ線`);
  A.ui.toggleLog(false);
  R.summary = { passes: rows.length, samples: S.length, fMax: +fMax.toFixed(0), t: +L.lot.t.toFixed(0) };
  return R;
});

console.log(`  ロット: ${out.summary.passes} パス / 時系列 ${out.summary.samples} 点 / 最大荷重 ${out.summary.fMax} t / ${out.summary.t} s\n`);
for (const c of out.checks) console.log(`  ${c.pass ? 'ok  ' : 'NG  '} ${c.name} — ${c.detail}`);
const bad = out.checks.filter(c => !c.pass).length;
console.log(`\nRESULT: ${bad ? 'FAIL' : 'PASS'} (${out.checks.length - bad}/${out.checks.length})`);
await browser.close();
process.exit(bad ? 1 : 0);
