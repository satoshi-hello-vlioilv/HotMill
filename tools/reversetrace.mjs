// 主駆動系の «逆転» を実測する。可逆ミルは 1 パスごとにロールを止めて逆へ回すので、
// そこに掛かる時間と、そのとき主機が出さなければならないトルクが現実的かを見る。
//
// 見るのは 4 つ:
//   ① 全速 → 停止（制動）に掛かる時間と、そのとき必要な制動トルク
//   ② 停止 → 逆向き全速（加速）に掛かる時間と、そのとき必要な加速トルク
//   ③ そのトルクが主機の能力（連続定格 × 短時間過負荷）に収まっているか
//   ④ 制動側と加速側の勾配が揃っているか（片方だけ «能力を無視して» 速くないか）
//
// 大きな配列は持たない（速度の山ごとにその場でまとめる。以前 OOM で落ちた）。
//   node tools/reversetrace.mjs
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const P = window.__app.physics, D = window.__DRIVE, K = window.__CFG;
  window.__startAuto(false);
  const spans = [];
  let prevV = 0, cur = null, peak = 0, n = 0;
  window.__ff((p) => {
    const m = p.mill, v = m.currentSpeed, dt = 1 / 120, a = (v - prevV) / dt;
    n++;
    if (Math.abs(v) > Math.abs(peak) && (peak === 0 || Math.sign(v) === Math.sign(peak))) peak = v;
    // 定速から «減り始めた» ところが逆転の始まり
    if (cur === null && Math.abs(peak) > 20 && Math.abs(v) < Math.abs(peak) - 1 && a * peak < 0) {
      cur = { vIn: peak, n0: n, aB: 0, aA: 0, nZero: null, nEnd: null, iq: 0, cap: 1e9, dead: 0,
              slip: 0, slipped: false };
    }
    if (cur) {
      cur.iq = Math.max(cur.iq, Math.abs(m.inertiaTorque));
      if (Math.abs(m.brSlip) > Math.abs(cur.slip)) cur.slip = m.brSlip;
      if (m.burSlipping) cur.slipped = true;
      if (cur.nZero === null) {
        cur.aB = Math.max(cur.aB, Math.abs(a));
        if (Math.abs(v) < 1e-9) cur.nZero = n;
      } else if (Math.abs(v) < 1e-9) {
        cur.dead++;                                     // 止まっている（パス間の死に時間）
      } else {
        cur.aA = Math.max(cur.aA, Math.abs(a));
        cur.cap = Math.min(cur.cap, m.accelCap);
        if (Math.abs(a) < 0.5 && Math.abs(v) > 20) {    // 逆向きの定速に乗った
          spans.push({ pass: m.passIndex + 1, vIn: +cur.vIn.toFixed(1), vOut: +v.toFixed(1),
                       tBrake: +((cur.nZero - cur.n0) / 120).toFixed(2),
                       tDead: +(cur.dead / 120).toFixed(2),
                       tAccel: +((n - cur.nZero - cur.dead) / 120).toFixed(2),
                       tTotal: +((n - cur.n0) / 120).toFixed(2),
                       aBrake: +cur.aB.toFixed(0), aAccel: +cur.aA.toFixed(0),
                       iqMax: +(cur.iq / 1000).toFixed(0),
                       capMin: +(cur.cap === 1e9 ? 0 : cur.cap).toFixed(1),
                       slipMax: +cur.slip.toFixed(1), slipped: cur.slipped });
          cur = null; peak = v;
        }
      }
    }
    prevV = v;
    return p.finish.done || !!p.tripped || spans.length >= 5;
  }, 120 * 900, 0);
  return { spans, J: +(D.inertia(P.mill.wrDia, P.mill.brDia) / 1000).toFixed(1),
           maxTorque: +(D.maxTorque / 1000).toFixed(0), overload: K.DRIVE.OVERLOAD,
           accelCfg: K.PROCESS.ACCEL, wrDia: P.mill.wrDia, brDia: P.mill.brDia,
           passDead: K.PROCESS.PASS_DEAD, motorKw: K.DRIVE.MOTOR_KW * K.DRIVE.MOTOR_N };
});
await browser.close();

const r = out.wrDia / 2000;
const tqOf = a => out.J * 1000 * (a / 60 / r) / 1000;      // mpm/s → kN·m
const lim = out.maxTorque * out.overload;
console.log(`慣性 ${out.J} t·m²（ロール軸換算）／ 主機 ${out.motorKw} kW・定格トルク ${out.maxTorque} kN·m`
  + `・短時間過負荷 ×${out.overload} ＝ ${lim.toFixed(0)} kN·m ／ 指令の加速度 ${out.accelCfg} mpm/s`);
console.log(`パス間の死に時間の設定 ${out.passDead} s`);
console.log('パス  入速 → 出速   制動 s  停止 s  加速 s  合計 s  制動勾配  加速勾配  必要制動トルク  必要加速トルク  余力   BUR 滑り');
for (const s of out.spans)
  console.log(`${String(s.pass).padStart(3)} ${String(s.vIn).padStart(7)} →${String(s.vOut).padStart(7)} mpm`
    + `${String(s.tBrake).padStart(8)}${String(s.tDead).padStart(8)}${String(s.tAccel).padStart(8)}${String(s.tTotal).padStart(8)}`
    + `${String(s.aBrake).padStart(9)}${String(s.aAccel).padStart(10)} mpm/s`
    + `${tqOf(s.aBrake).toFixed(0).padStart(12)}${tqOf(s.aAccel).toFixed(0).padStart(15)} kN·m`
    + `${String(s.capMin).padStart(8)} mpm/s`
    + `${String(s.slipMax).padStart(8)} mpm${s.slipped ? ' ★滑った' : ''}`);

const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
ok('逆転が実測できた（1 回以上）', out.spans.length > 0, `${out.spans.length} 回`);
/* バックアップロールは歯車ではなく «摩擦» で連れ回される。空転中は押しつけが
 * 下ワークロールの自重（13.3 t）しかないので、主機の能力どおり 110 mpm/s で振ると
 * BUR が滑る。実機がそれを避けるのは、滑らせるとロール表面が擦れ、アルミでは
 * それがそのまま板の表面品質になるから。指令をこの上限で頭打ちにしている。 */
ok('逆転の勾配が «BUR を滑らせない上限» で決まっている（主機の能力より先に効く）',
   out.spans.every(s => s.capMin < out.accelCfg - 1),
   `上限 ${out.spans[0] ? out.spans[0].capMin : '?'} mpm/s ／ 指令 ${out.accelCfg} mpm/s`);
/* 上限ちょうどで振ると、接線力は毎刻み Fmax に «張り付く»（Coulomb なので当然）。
 * それを «滑った» と数えると常に真になるので、見るのは «実際にずれた量»。
 * 上限を守っているかぎり、ずれは積み上がらない。 */
ok('その上限を守れば BUR は実質ずれない（ずれ < 1 mpm）',
   out.spans.every(s => Math.abs(s.slipMax) < 1),
   `最大ずれ ${Math.max(...out.spans.map(s => Math.abs(s.slipMax))).toFixed(1)} mpm`);
for (const s of out.spans) {
  const tqB = tqOf(s.aBrake), tqA = tqOf(s.aAccel);
  ok(`パス ${s.pass}: 制動に要るトルク ${tqB.toFixed(0)} kN·m が主機の能力 ${lim.toFixed(0)} 以内`, tqB <= lim * 1.02, `${tqB.toFixed(0)} kN·m`);
  ok(`パス ${s.pass}: 加速に要るトルク ${tqA.toFixed(0)} kN·m が主機の能力 ${lim.toFixed(0)} 以内`, tqA <= lim * 1.02, `${tqA.toFixed(0)} kN·m`);
  ok(`パス ${s.pass}: 制動と加速の勾配が揃う（片方だけ能力を無視していない）`,
     Math.abs(s.aBrake - s.aAccel) <= Math.max(s.aBrake, s.aAccel) * 0.25,
     `制動 ${s.aBrake} / 加速 ${s.aAccel} mpm/s`);
}
console.log('');
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - bad.length}/${checks.length})`);
process.exit(bad.length ? 1 : 0);
