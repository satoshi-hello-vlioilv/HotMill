// ワークロールのクーラントヘッダとゾーンコントロール（MILL.ROLL_COOL）を測る。
//
//   ① 既定（全ヘッダ定格・全ゾーン開）では、ロールが待機温度へ戻る時定数が従来の較正値
//      ROLL_TAU と一致する（新しい持ち方が実機ロットの較正を壊さない）
//   ② ゾーンを 1 つ閉じると、そのゾーンだけロールが熱くなり、熱クラウンが幅方向で偏る
//   ③ 全ヘッダの水量を半分にすると、時定数は 2^FLOW_K 倍に伸びる（効きは流量のべき乗）
//   ④ 板からの熱は «板の幅の下のゾーン» にだけ入る（胴長より狭い板では端のゾーンが冷たいまま）
//   ⑤ ノズルが 4 ヘッダぶんあり、WR の軸心を向いている
//   ⑥ 参考: 総流量（4 本 × 4,000 L/min）
//
//   node tools/rollcool.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => new Promise(res => setTimeout(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, M = K.MILL, RC = M.ROLL_COOL;
  const m = P.mill, n = RC.ZONES.N;
  const reset = () => { for (const h of Object.values(RC.HEADERS)) { h.on = true; h.flow = 1; }
                        for (const q of RC.ZONES.STATE) { q.on = true; q.flow = 1; } };
  reset();
  /* ① 既定の時定数 */
  const tau0 = RC.ZONES.STATE.map((_, i) => R.rollCoolTau(i));
  /* «熱いロールが 1 ステップでどれだけ冷えるか» を従来の式（Num.approach(…, ROLL_TAU)）と比べる。
   * BUR への逃げは両方に同じだけ入るので、BUR を同温にして切る。 */
  const T0 = M.ROLL_T0, hot = T0 + 100;
  m.rollTempZ.fill(hot); m.rollTemp = hot; m.brTemp = hot;         // BUR も同温 → 交換 0
  P._rollCool(1.0);
  const after = m.rollTemp, ref = T0 + (hot - T0) * Math.exp(-1 / M.ROLL_TAU);
  /* ③ 半分の水量 */
  for (const h of Object.values(RC.HEADERS)) h.flow = 0.5;
  const tauHalf = R.rollCoolTau(3);
  reset();
  /* ② ゾーンを閉じる: 熱い状態から冷やすと、閉じたゾーンだけ残る */
  RC.ZONES.STATE[1].on = false;                                       // DS
  m.rollTempZ.fill(hot); m.rollTemp = hot; m.brTemp = T0;
  for (let i = 0; i < 120 * 60; i++) P._rollCool(1 / 120);           // 60 s
  const zoneT = Array.from(m.rollTempZ);
  const cr = R.rollCrown(Float64Array.from({ length: 21 }, (_, i) => -1100 + 110 * i), 2200, m.rollTemp, 0, m.rollTempZ);
  const crNo = R.rollCrown(Float64Array.from({ length: 21 }, (_, i) => -1100 + 110 * i), 2200, m.rollTemp, 0, null);
  const skew = (() => { const p = cr.prof; let a = 0, b = 0; for (let i = 0; i < 10; i++) { a += p[i]; b += p[20 - i]; } return (a - b) / 10 * 1000; })();   // DS 側 − OS 側 [µm]
  const skewNo = (() => { const p = crNo.prof; let a = 0, b = 0; for (let i = 0; i < 10; i++) { a += p[i]; b += p[20 - i]; } return (a - b) / 10 * 1000; })();
  reset();
  /* ④ 板からの熱は板の幅の下だけ */
  m.rollTempZ.fill(T0); m.rollTemp = T0; m.brTemp = T0;
  P.slab.width = 1330; P.slab.zOff = 0; P.slab.thickness = 20; P.slab.length = 30000;
  P._rollHeat(10, P.slab.alloy.RHO * P.slab.alloy.CP);              // 板が平均 10 K 冷えたぶんの熱
  const heat = Array.from(m.rollTempZ), spans = RC.ZONES.STATE.map((_, i) => R.rollZoneSpan(i));
  const under = spans.map(([a, b]) => Math.max(0, Math.min(b, 665) - Math.max(a, -665)) > 0);
  /* ⑤ ノズル */
  const MV = A.world.millView, nz = MV.nozzles, cnt = nz.mesh.count;
  const T = window.__T, m4 = new T.Matrix4(), pos = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3();
  const up = new T.Vector3(0, 1, 0);
  let worstDeg = 0;
  MV.update(m);
  for (let i = 0; i < cnt; i++) {
    nz.mesh.getMatrixAt(i, m4); m4.decompose(pos, q, sc);
    const axis = up.clone().applyQuaternion(q);                     // ノズルの向き
    const x = pos.x / K.SCALE, y = pos.y / K.SCALE;
    const top = y > M.PASS_LINE + m.gap / 2, yAxis = top ? m.wrTopY : m.wrBotY;
    const to = new T.Vector3(-x, yAxis - y, 0).normalize();         // WR 軸心へ
    const deg = Math.acos(Math.max(-1, Math.min(1, axis.dot(to)))) * 180 / Math.PI;
    worstDeg = Math.max(worstDeg, deg);
  }
  res({ tau0, after, ref, tauHalf, flowK: RC.FLOW_K, rollTau: M.ROLL_TAU, zoneT, skew, skewNo, crZone: cr.zone,
        heat, under, nozzles: cnt, perHeader: MV.nozzleZs.length, worstDeg,
        lpm: R.rollCoolFlowLpm(), lpmRated: RC.FLOW_LPM * 4, names: RC.ZONES.NAMES });
}, 300)));
await browser.close();

const checks = [];
const ok = (n, pass, got, ref = false) => checks.push({ name: n, pass: !!pass, got, ref });
console.log(`ゾーンの時定数（既定）: ${out.tau0.map(t => t.toFixed(1)).join(' / ')} s（ROLL_TAU ${out.rollTau} s）`);
console.log(`ゾーン «DS» を閉じて 60 s 冷やしたあとの WR 温度: ${out.names.map((nm, i) => `${nm} ${out.zoneT[i].toFixed(0)}℃`).join('  ')}`);
console.log(`板（幅 1,330・中央）が 10 K 冷えた熱の入り方: ${out.names.map((nm, i) => `${nm} +${(out.heat[i] - 60).toFixed(1)}K`).join('  ')}`);

ok('既定（全開）の時定数は従来の較正値 ROLL_TAU に一致する', out.tau0.every(t => Math.abs(t - out.rollTau) < 1e-9),
   `${out.tau0[0].toFixed(2)} s ＝ ${out.rollTau} s`);
ok('既定の 1 ステップの冷え方が従来の式（Num.approach）と一致する', Math.abs(out.after - out.ref) < 1e-6,
   `${out.after.toFixed(4)} ℃ vs ${out.ref.toFixed(4)} ℃`);
ok(`水量を半分にすると時定数は 2^${out.flowK} 倍`, Math.abs(out.tauHalf / out.rollTau - Math.pow(2, out.flowK)) < 1e-9,
   `${out.tauHalf.toFixed(1)} s ／ ${out.rollTau} × ${Math.pow(2, out.flowK).toFixed(3)}`);
const closedHot = out.zoneT[1] > Math.max(...out.zoneT.filter((_, i) => i !== 1)) + 20;
ok('ゾーンを閉じるとそのゾーンだけロールが熱いまま残る', closedHot,
   `閉じた DS ${out.zoneT[1].toFixed(0)} ℃ ／ 他の最大 ${Math.max(...out.zoneT.filter((_, i) => i !== 1)).toFixed(0)} ℃`);
ok('閉じたゾーンの側で熱クラウンが偏る（ゾーン無しでは対称）', Math.abs(out.skew) > 5 && Math.abs(out.skewNo) < 1e-6,
   `DS − OS: ゾーンあり ${out.skew.toFixed(1)} µm ／ ゾーン無し ${out.skewNo.toFixed(2)} µm（ゾーン項の最大 ${out.crZone.toFixed(0)} µm）`);
ok('板からの熱は板の幅の下のゾーンにだけ入る', out.heat.every((t, i) => out.under[i] ? t > 60 + 1e-6 : Math.abs(t - 60) < 1e-9),
   out.names.map((nm, i) => `${nm}${out.under[i] ? '●' : '○'}`).join(' '));
ok('ノズルが 4 ヘッダぶんあり、すべて WR の軸心を向く（5° 以内）', out.nozzles === 4 * out.perHeader && out.worstDeg < 5,
   `${out.nozzles} 本（1 ヘッダ ${out.perHeader}）／ 向きのずれ最大 ${out.worstDeg.toFixed(2)}°`);
ok('（参考）総流量', true, `${out.lpm.toLocaleString()} L/min（定格 4 本 × ${(out.lpmRated / 4).toLocaleString()} ＝ ${out.lpmRated.toLocaleString()} L/min）`, true);

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}、参考 ${nRef} 件)`);
process.exit(bad.length ? 1 : 0);
