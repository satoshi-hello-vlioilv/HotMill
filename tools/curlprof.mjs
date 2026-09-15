// 反りの «長手プロファイル»（SlabState.kProf）を測る。
//
// 板全体で 1 つの曲率（kNew）しか持っていなかった反りを、材料座標の配列（板厚・温度と同じ
// 仕組み）で持つようにした。ここで見るのは 4 つ。
//   ① 配列の平均が従来の «板全体の平均»（kNew）と一致すること（新しい持ち方が古い読みを壊さない）
//   ② 頭と尻の反りが平均と «違う» こと（違わないなら配列にした意味が無い）。温度（dTProf）も
//      AGC の収束も頭尻で違うので、同じパスでも端の反りは同じにならないはず
//   ③ 端を切ったとき（cropProfile）、残った材料の反りが «動かない» こと（張り直しで壊れない）
//   ④ 75 mm シャーの下台が残す «7 m の区間だけの曲がり»（Rolling.bedLiftSet）が
//      切ったあとの配列に載り、次のパスで消えること（圧延で伸ばされる）
//
//   node tools/curlprof.mjs
import { openApp, installHelpers } from './harness.mjs';

const LOT = { cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052' };

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(({ LOT }) => new Promise(res => setTimeout(async () => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, F = K.FLIP;
  A.bus.emit('CMD_SET_SLAB', { ...LOT, target: 8, mode: 'COIL' });
  await new Promise(q => setTimeout(q, 80));
  window.__startAuto(false);

  const s = P.slab, m = P.mill, fin = P.finish, N = s.kProf.length;
  const mean = (a, i0 = 0, i1 = a.length) => { let t = 0, n = 0; for (let i = i0; i < i1; i++) { t += a[i]; n++; } return n ? t / n : 0; };
  const passes = [];                       // パスごとの {no, kNew, mean, head, tail, min, max}
  let last = -1, cropSeen = null, afterCrop = null, nextPassAfterCrop = null;
  let wasRolling = false, cropPass = -1, prevProf = null;
  window.__ff((p) => {
    const rolling = s.rollingActive;
    if (fin.cropStage === 'CUT') prevProf = Float64Array.from(s.kProfile.prof);   // 上死点の直前
    if (fin.cropStage === 'RETURN' && !cropSeen && prevProf) {
      /* 下台が上死点に達した直後。«切る直前との差» が下台の曲がりそのもの ——
       * 配列には圧延の反りが先に載っているので、絶対値では読めない。 */
      const kp = s.kProfile, bs = fin.bedSet || {};
      let dMax = 0, iMax = 0;
      for (let i = 0; i < N; i++) { const d = kp.prof[i] - prevProf[i]; if (d > dMax) { dMax = d; iMax = i; } }
      cropSeen = { pass: m.passIndex + 1, th: s.thickness, len: s.length, min: kp.min, max: kp.max,
                   bed: bs, dMax, uMax: iMax / (N - 1) };
      cropPass = m.passIndex;
    }
    if (wasRolling && !rolling) {                        // パスの終わり
      const kp = s.kProfile;
      passes.push({ no: m.passIndex + 1, kNew: s.kNew, mean: mean(kp.prof), head: kp.head, tail: kp.tail,
                    min: kp.min, max: kp.max, th: s.thickness });
      if (cropSeen && m.passIndex === cropPass) afterCrop = { max: kp.max, min: kp.min, prof: Array.from(kp.prof) };
      if (cropSeen && m.passIndex === cropPass + 1 && !nextPassAfterCrop)
        nextPassAfterCrop = { max: kp.max, min: kp.min, kNew: s.kNew, prof: Array.from(kp.prof) };
    }
    wasRolling = rolling;
    return fin.done || !!p.tripped;
  }, 120 * 3000, 0);

  /* ③ 端を切っても残った材料の反りが動かないこと —— 直接、切る前後の配列を比べる。
   *    運転の中では切る直前のコマを取りづらいので、ここで «同じ配列» を切って確かめる。 */
  const cropKeep = (() => {
    const s2 = s, N2 = N, saved = { k: Float64Array.from(s2.kProf), kn: Float64Array.from(s2._kNext),
      h: Float32Array.from(s2.hProf), hn: Float32Array.from(s2._hNext), d: Float64Array.from(s2.dTProf),
      q: Float64Array.from(s2._qProf), cov: Float64Array.from(s2._hCov), acc: Float64Array.from(s2._hAcc),
      ks: Float64Array.from(s2._kSum), wLo: s2._wLo, wHi: s2._wHi, uPrev: s2._uPrev, qLo: s2._qLo, qHi: s2._qHi };
    for (let i = 0; i < N2; i++) s2.kProf[i] = 1e-6 * Math.sin(i / N2 * Math.PI * 3);  // 目立つ形を入れる
    s2._hCov.fill(0);                                     // 全部 «入側» の状態で切る
    const frac = 0.2, before = Array.from(s2.kProf);
    s2.cropProfile(+1, frac);                              // xMax 側を 20 % 切る
    /* 新しい座標 i は古い座標 i·(1−frac) に当たる。そこを線形補間した値と比べる。 */
    let err = 0;
    for (let i = 0; i < N2; i++) {
      const p = i / (N2 - 1) * (1 - frac) * (N2 - 1), a = Math.floor(p), b = Math.min(a + 1, N2 - 1), w = p - a;
      const ref = before[a] * (1 - w) + before[b] * w;
      err = Math.max(err, Math.abs(s2.kProf[i] - ref));
    }
    // 戻す
    s2.kProf.set(saved.k); s2._kNext.set(saved.kn); s2.hProf.set(saved.h); s2._hNext.set(saved.hn);
    s2.dTProf.set(saved.d); s2._qProf.set(saved.q); s2._hCov.set(saved.cov); s2._hAcc.set(saved.acc);
    s2._kSum.set(saved.ks); s2._wLo = saved.wLo; s2._wHi = saved.wHi; s2._uPrev = saved.uPrev; s2._qLo = saved.qLo; s2._qHi = saved.qHi;
    return { err, amp: 1e-6 };
  })();

  res({ passes, cropSeen, afterCrop, nextPassAfterCrop, cropKeep, N,
        bedSetOn: K.CROP_SHEAR.BED_SET_ON, gauge: K.SHAPE.WARP_GAUGE });
}, 400)), { LOT });
await browser.close();

const checks = [];
const ok = (n, pass, got, ref = false) => checks.push({ name: n, pass: !!pass, got, ref });
const G = out.gauge, rise = (k) => k * G * G / 8;
const f3 = (k) => (k * 1e6).toFixed(2);

console.log('パス / 出側 / 反り（定尺 1 m の隙間 mm）: 平均(kNew)  配列の平均   頭    尻   最小   最大');
for (const q of out.passes)
  console.log(`  P${String(q.no).padStart(2)} ${String(q.th.toFixed(1)).padStart(6)} mm   `
    + `${rise(q.kNew).toFixed(3).padStart(7)} ${rise(q.mean).toFixed(3).padStart(8)} ${rise(q.head).toFixed(3).padStart(7)} `
    + `${rise(q.tail).toFixed(3).padStart(7)} ${rise(q.min).toFixed(3).padStart(7)} ${rise(q.max).toFixed(3).padStart(7)}`);

/* ① 配列の平均 ≈ kNew。重みの取り方が違う（kNew は時間、配列は材料）ので厳密には一致しない。
 *    差は «反りの大きさ» に対する比で見る。 */
/* 巻取パスは板の一部がリールに載っていて材料座標（体積比）が行きつ戻りつする（writeHeat の
 * 注記と同じ）。配列の «材料の重み» と kNew の «時間の重み» がそこで離れるので、合否からは
 * 外して参考で出す。 */
const lastNo = Math.max(...out.passes.map(q => q.no));
/* 反りが «ほぼ 0» のパス（定尺 1 m で 0.01 mm 未満）は比の分母が消えるので数えない。 */
const sig = out.passes.filter(q => Math.abs(q.kNew) > 1e-7 && q.no < lastNo);
const coil = out.passes.find(q => q.no === lastNo);
const worst1 = sig.reduce((w, q) => Math.max(w, Math.abs(q.mean - q.kNew) / Math.abs(q.kNew)), 0);
ok('配列の平均が板全体の平均（kNew）と合う（反りのあるパス・巻取以外で 10 % 以内）', sig.length && worst1 <= 0.10,
   `最大差 ${(worst1 * 100).toFixed(1) } %（${sig.length} パス）`);
ok('（参考）巻取パスの配列の平均と kNew の差', true,
   coil ? `${(Math.abs(coil.mean - coil.kNew) / Math.max(Math.abs(coil.kNew), 1e-12) * 100).toFixed(1)} %（材料座標が行きつ戻りつする）` : '—', true);
/* ② 頭と尻が違う。«最大の差» が平均の 5 % 以上あれば、配列にした意味がある。 */
const spread = sig.reduce((w, q) => Math.max(w, Math.abs(q.head - q.tail) / Math.abs(q.kNew)), 0);
ok('頭と尻の反りが違う（配列で持つ意味がある）', spread >= 0.05, `頭尻の差 最大 ${(spread * 100).toFixed(0)} %（平均に対して）`);
/* ③ 切っても残った材料の反りが動かない */
ok('端を切っても残った材料の反りが動かない（cropProfile の張り直し）', out.cropKeep.err <= out.cropKeep.amp * 0.02,
   `最大ずれ ${(out.cropKeep.err / out.cropKeep.amp * 100).toFixed(2)} %（形の振幅に対して）`);
/* ④ 下台の曲がり。切った直後は 7 m の区間に κ_perm が載り、次のパスで消える。 */
if (out.cropSeen) {
  const b = out.cropSeen.bed, kMax = b.kMax || 0;
  console.log(`\n75 mm シャー（P${out.cropSeen.pass}・${out.cropSeen.th.toFixed(1)} mm）の下台: 浮き上がり長 ${(b.L / 1000).toFixed(2)} m`
    + ` ／ 曲げ応力 ${b.sigma.toFixed(1)} MPa ／ 保持 ${(+b.hold).toFixed(1)} s ／ 残る割合 f ${(b.f * 100).toFixed(0)} %`
    + ` ／ 残る曲率の最大 ${f3(kMax)}×10⁻⁶ /mm（定尺 1 m で ${rise(kMax).toFixed(2)} mm）`);
  const bumpNext = out.nextPassAfterCrop ? Math.max(Math.abs(out.nextPassAfterCrop.max - out.nextPassAfterCrop.kNew), Math.abs(out.nextPassAfterCrop.min - out.nextPassAfterCrop.kNew)) : 0;
  ok('下台の曲がりが切った直後の配列に載る（切る前後の差の最大 ≈ f·3δ/L²）',
     out.bedSetOn ? Math.abs(out.cropSeen.dMax - kMax) <= 0.2 * kMax : true,
     `差の最大 ${f3(out.cropSeen.dMax)}（材料座標 ${out.cropSeen.uMax.toFixed(2)}）／ 予測 ${f3(kMax)} ×10⁻⁶ /mm`);
  ok('次のパスで下台の曲がりが消える（圧延で書き直される）', bumpNext < 0.5 * kMax || !out.bedSetOn,
     `次パスの平均からの外れ 最大 ${f3(bumpNext)} ／ 下台の曲がり ${f3(kMax)} ×10⁻⁶ /mm`);
  ok('（参考）曲げ応力と、その保持時間で流れるひずみ速度', true,
     `σ ${b.sigma.toFixed(1)} MPa → ε̇ ${b.rate.toExponential(1)} /s ／ 保持中に残る割合 ${(b.f * 100).toFixed(0)} %`, true);
} else ok('75 mm シャーの端部切断が測れている', false, '切断が起きなかった');

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}、参考 ${nRef} 件)`);
process.exit(bad.length ? 1 : 0);
