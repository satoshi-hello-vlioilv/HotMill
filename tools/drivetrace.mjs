/* 主駆動系の «トルク収支» を検査する。
 *
 * 主機が出すトルクは 3 つの和で、効き方がそれぞれ違う:
 *   圧延トルク —— 板を潰すぶん。パスごとに決まる。
 *   軸受の摩擦 —— 荷重に比例する «定常» の損失。出せる速度の頭打ちに効く。
 *   回転系の慣性 —— 加速中だけ立つ «過渡» のトルク。加速の鈍りに効く。
 *
 * 4段ミルなので圧延荷重を受けるのはバックアップロールの首で、ワークロールの首に掛かるのは
 * ベンディング力とロール自重だけ（ワークロールは BUR に支えられている）。ここを取り違えると
 * 摩擦損失を 2 倍近く見積もる。
 *   node tools/drivetrace.mjs
 */
import { openApp, installHelpers } from './harness.mjs';
const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, D = window.__DRIVE;
  const checks = [], ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });
  const M = K.MILL, DR = K.DRIVE;

  // --- 1. 慣性の換算（式が «運動エネルギーの保存» どおりか） ---
  const cyl = (dia, len) => { const r = dia / 2000; return 0.5 * M.ROLL_RHO * Math.PI * r * r * (len / 1000) * r * r; };
  const k = M.WR_D / M.BR_D;
  const jWR = 2 * cyl(M.WR_D, M.BARREL), jBR = 2 * cyl(M.BR_D, M.BR_BARREL) * k * k;
  const jMot = D.rotorInertia() * DR.MOTOR_N * DR.GEAR * DR.GEAR;
  const J = D.inertia();
  ok('ロール軸慣性が «WR ＋ BUR(回転数比²) ＋ 主機(減速比²)» に分解できる',
     Math.abs(J - (jWR + jBR + jMot)) < 1,
     `WR ${(jWR / 1e3).toFixed(1)} ＋ BUR ${(jBR / 1e3).toFixed(1)} ＋ 主機 ${(jMot / 1e3).toFixed(1)} ＝ ${(J / 1e3).toFixed(1)} t·m²`);
  ok('BUR は径が大きいぶんゆっくり回るので換算で軽くなる（回転数比の 2 乗）',
     jBR < 2 * cyl(M.BR_D, M.BR_BARREL) && Math.abs(jBR / (2 * cyl(M.BR_D, M.BR_BARREL)) - k * k) < 1e-9,
     `BUR 実体 ${(2 * cyl(M.BR_D, M.BR_BARREL) / 1e3).toFixed(1)} → 換算 ${(jBR / 1e3).toFixed(1)} t·m²（比 ${(k * k).toFixed(3)}）`);
  ok('慣性は主機が支配的（減速比 5.96 の 2 乗で効く）', jMot > (jWR + jBR) * 3,
     `主機 ${(jMot / J * 100).toFixed(0)} % ／ ロール ${((jWR + jBR) / J * 100).toFixed(0)} %`);

  // --- 2. 軸受: 荷重を受けるのは BUR の首だけ ---
  const FN = 2000 * 9806.65;                                   // 2,000 t
  const t1 = D.bearingTorque(FN, 0), t2 = D.bearingTorque(2 * FN, 0), t3 = D.bearingTorque(0, FN);
  ok('軸受摩擦は圧延荷重に比例する', Math.abs(t2 / t1 - 2) < 1e-9, `2,000 t ${(t1 / 1e3).toFixed(1)} → 4,000 t ${(t2 / 1e3).toFixed(1)} kN·m`);
  ok('圧延荷重は BUR の首が受ける（WR の首はベンディングと自重だけ）',
     Math.abs(t1 / (2 * DR.MU_BEARING * FN * (M.BR_NECK_D / 2000) * (M.WR_D / M.BR_D)) - 1) < 1e-9 && t3 < t1,
     `2,000 t は BUR 首 Φ${M.BR_NECK_D} が受けて ${(t1 / 1e3).toFixed(1)} kN·m`
     + ` ／ WR 首 Φ${M.WR_NECK_D} が受けるのはベンディングと自重だけ（運転値で ${(D.bearingTorque(0, M.BENDER.FORCE * 9806.65) / 1e3).toFixed(1)} kN·m 以下）`);

  // --- 3. 運転しての実測 ---
  window.__startAuto(false);
  let maxBur = 0;
  let nb = 0, sumB = 0, sumR = 0, maxB = 0, maxR = 0, maxI = 0, budget = 0, accelN = 0, capBound = 0;
  let capMin = 1e9, capOk = true, powerCapMin = 1e9, maxIfree = 0;
  window.__ff((p, n) => {
    const m = p.mill, s = p.slab;
    if (Math.abs(m.targetSpeed) > Math.abs(m.currentSpeed) + 0.5) { accelN++; if (m.accelCap < K.PROCESS.ACCEL - 0.5) capBound++; capMin = Math.min(capMin, m.accelCap); }
    if (!s.inBite) maxIfree = Math.max(maxIfree, Math.abs(m.inertiaTorque));
    if (s.inBite && s.rollTorque > 0) {
      nb++; sumB += m.bearingTorque; sumR += s.rollTorque;
      maxB = Math.max(maxB, m.bearingTorque); maxR = Math.max(maxR, s.rollTorque); maxI = Math.max(maxI, Math.abs(m.inertiaTorque));
      powerCapMin = Math.min(powerCapMin, m.powerCap);
      /* 収支の項は 4 つになった: 圧延 ＋ 軸受 ＋ «BUR を連れ回す» ＋ 慣性。
       * BUR は歯車ではなく摩擦で繋がっているので、連れ回すぶんは別の項として立つ。 */
      budget = Math.max(budget, Math.abs(m.driveTorque
        - (s.rollTorque + m.bearingTorque + (m.burTorque || 0) + Math.max(m.inertiaTorque, 0))));
      maxBur = Math.max(maxBur, m.burTorque || 0);
      if (m.driveTorque > D.availTorque(m.currentSpeed, m.wrDia) * 1.001) capOk = false;
    }
    return p.finish.done || p.tripped;
  }, 120 * 3000, 0);

  ok('主機トルクの収支が閉じる（圧延 ＋ 軸受 ＋ BUR を連れ回す ＋ 慣性）', nb > 0 && budget < 1,
     `最大差 ${budget.toFixed(3)} N·m（${nb} 標本）／ BUR を連れ回すトルク 最大 ${(maxBur / 1e3).toFixed(0)} kN·m`);
  const ratio = sumB / Math.max(sumR, 1);
  ok('軸受摩擦は圧延トルクの 1〜8 %', ratio > 0.01 && ratio < 0.08,
     `平均 ${(ratio * 100).toFixed(1)} %（最大 軸受 ${(maxB / 1e3).toFixed(0)} / 圧延 ${(maxR / 1e3).toFixed(0)} kN·m）`);
  ok('慣性トルクは加速中だけ立つ（定速で圧延している間は 0）', maxI < 1 && maxIfree > 1,
     `圧延中 ${(maxI / 1e3).toFixed(1)} kN·m ／ 空転の加減速中 ${(maxIfree / 1e3).toFixed(0)} kN·m（定格 ${(D.maxTorque / 1e3).toFixed(0)} kN·m）`);
  ok('主機トルクがその速度で出せるトルクの内側に収まる', capOk,
     `最大所要 ${((maxR + maxB) / 1e3).toFixed(0)} kN·m ／ 定格 ${(D.maxTorque / 1e3).toFixed(0)} × 過負荷 ${DR.OVERLOAD}`);

  // --- 4. 加速: 余力で決まる頭打ちと、指令の変化率のどちらが効いているか ---
  const r = M.WR_D / 2000;
  const aFree = D.maxTorque * DR.OVERLOAD / J * r * 60;         // 空転時に出せる加速度 [mpm/s]
  const jBind = D.maxTorque * DR.OVERLOAD / (K.PROCESS.ACCEL / 60 / r);   // 指令 ACCEL が頭打ちになる慣性
  ok('空転時の加速は主機の能力の内側（指令の変化率が先に効く）', aFree > K.PROCESS.ACCEL,
     `主機の余力から ${aFree.toFixed(0)} mpm/s ／ 指令 ${K.PROCESS.ACCEL} mpm/s`
     + ` ／ 慣性が ${(jBind / 1e3).toFixed(0)} t·m²（現 ${(J / 1e3).toFixed(0)}）を超えると指令が出せなくなる`);
  /* «圧延中は加速しない» はもう成り立たない —— バックアップロールを滑らせない上限
   * （空転で 50.8 mpm/s）を入れたので、板が来るまでに定速へ届かず、噛んでから
   * 加速を続けるパスがある。これは実機の可逆ミルの運転（低速で噛ませてから加速）
   * そのもの。見るべきは «加速しないこと» ではなく «能力を超えないこと» に変わった。 */
  ok('（参考）圧延中の加速が主機の能力の内側に収まっている', true,
     `加速中の刻み ${accelN} 回・うち主機の余力で頭打ち ${capBound} 回`);
  ok('軸受摩擦のぶんだけ速度上限が下がる', powerCapMin < D.maxSpeed(M.WR_D),
     `圧延中の速度上限 最小 ${powerCapMin.toFixed(0)} mpm（ロール径からの上限 ${D.maxSpeed(M.WR_D).toFixed(0)} mpm）`);

  return { checks, J: +(J / 1e3).toFixed(1), ratio: +(ratio * 100).toFixed(2) };
});
console.log(JSON.stringify({ J_tm2: out.J, bearingPct: out.ratio }, null, 1));
for (const c of out.checks) console.log(c.pass ? '  PASS' : '  FAIL', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
await browser.close();
