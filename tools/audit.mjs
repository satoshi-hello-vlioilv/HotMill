// 物理実装の «独立検証»。式を別実装で解き直したり、極限・保存則で確かめる。
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL;
  const rep = [];
  const say = (t, v) => rep.push({ t, v });

  // --- 1) 変形抵抗の «上限キャップ» が常用域でどれだけ効いているか ---
  {
    const rows = [];
    for (const key of Object.keys(K.ALLOYS)) {
      const al = K.ALLOYS[key];
      const st = R.stParams(al);
      // キャップ前の生の値を式から復元する
      const raw = (T, e) => { const Z = R.zener(T, e, al);
        const X = Math.sinh(st.alpha * al.C) * Math.pow(Z / st.Zref, 1 / st.n);
        return Math.asinh(X) / st.alpha; };
      let worst = 0, at = null;
      for (const T of [330, 350, 380, 400, 450, 500]) for (const e of [1, 5, 20, 60, 120, 300]) {
        const r0 = raw(T, e), c = R.flowStress(T, e, al);
        const d = (r0 - c) / r0;
        if (d > worst) { worst = d; at = `${T}℃ ${e}/s: ${r0.toFixed(0)}→${c.toFixed(0)} MPa`; }
      }
      rows.push({ key, cap: al.KF_MAX, worst: +(worst * 100).toFixed(1), at });
    }
    say('変形抵抗キャップの効き（熱間域での最大低減率）', rows);
  }

  // --- 2) キャンバーの符号: «幅方向の伸び差 → 平面内の曲率» の向き ---
  {
    // OS（+z）側のギャップを広げる（wedge > 0）。OS は厚い＝伸びない＝短い辺
    const kc = R.camber(60, 45, +0.05, 1500);
    // 短い辺の側へ曲がる（曲率の中心が OS 側）＝ +z 方向へ進路が曲がるはず
    say('くさび +0.05 mm（OS のギャップが広い）のときのキャンバー', {
      camber: kc, 符号: kc > 0 ? '+z（OS）へ曲がる' : '−z（DS）へ曲がる',
      理論: 'OS が厚い→OS が短い→短い側（OS, +z）へ曲がるので κ>0 が正しい',
    });
  }

  // --- 3) 蛇行の帰還が «発散» か «収束» か（ゼロ点誤差と制御を切って初期ずれだけ与える） ---
  {
    const save = { err: K.MILL.LEVEL_ERR, kp: K.MILL.LEVEL.KP };
    K.MILL.LEVEL_ERR = 0; K.MILL.LEVEL.KP = 0;
    const F = 2500, w = 1500;
    const step = (z, psi, dL, n) => {
      for (let i = 0; i < n; i++) {
        const wg = R.gapWedge(F, w, z, 0);
        const kc = R.camber(60, 45, wg, w);
        psi += kc * dL; z += psi * dL;
      }
      return { z, psi };
    };
    const a = step(10, 0, 1000, 30);      // 初期ずれ +10 mm
    K.MILL.LEVEL_ERR = save.err; K.MILL.LEVEL.KP = save.kp;
    say('初期ずれ +10 mm を与えて 30 km 進めたとき（ゼロ点誤差・制御なし）', {
      z: +a.z.toFixed(3), psi: a.psi, 判定: Math.abs(a.z) > 10 ? '発散（自己増幅）' : '収束（自己求心）',
      実機: '蛇行は自己増幅（一度始まると止まらない）',
    });
  }

  // --- 4) 反りの浮き上がり長・先端高さの解析解との一致 ---
  {
    const al = K.ALLOYS.A5052, h = 200, w = 1500, k = 2e-5;
    const sp = R.curlSpan(k, h, w, al);
    const EI = al.E * 1000 * w * h * h * h / 12, q = al.RHO * 1e-9 * 9.81 * h * w;
    const ell = Math.sqrt(2 * EI / q * k);
    say('反りの浮き上がり長（qℓ²/2 = EIκ の解析解と一致するか）', {
      code: +sp.liftOff.toFixed(3), 解析: +ell.toFixed(3), 差: +(sp.liftOff - ell).toExponential(2),
      先端: +sp.tip.toFixed(1), '解析 κℓ²/4': +(k * ell * ell / 4).toFixed(1),
    });
  }

  // --- 5) 摩擦丘 Qp の極限（μ→0 で 1、既知の値と一致するか）---
  {
    const q0 = R.frictionHill(100, 50, 1e-9), q1 = R.frictionHill(100, 50, 0.25);
    const x = 0.25 * 100 / 50;
    say('摩擦丘 Qp = (e^x − 1)/x', { 'μ→0': +q0.toFixed(6), 'μ=0.25': +q1.toFixed(4),
      解析: +((Math.exp(x) - 1) / x).toFixed(4), x });
  }

  // --- 6) 接触弧長の厳密解 ---
  {
    const R0 = K.MILL.WR_D / 2, hIn = 60, hOut = 45, dh = 15;
    const Ld = R.contactLength(hIn, hOut);
    // 幾何: 弦の水平投影。cosα = 1 − dh/(2R)、Ld = R·sinα
    const alpha = Math.acos(1 - dh / (2 * R0)), exact = R0 * Math.sin(alpha);
    say('接触弧長（R·sinα との一致）', { code: +Ld.toFixed(4), 厳密: +exact.toFixed(4),
      差: +(Ld - exact).toExponential(2) });
  }

  // --- 7) バイト内の熱: 抜熱の板厚平均が dTavg と一致するか（保存） ---
  {
    P.slab.reset({ cast: 560, scalp: 12, width: 1500, length: 2400, temp: 500, alloy: 'A5052' });
    const s = P.slab, before = s.temperature;
    const T0 = Array.from(s.T);
    P._biteThermal(0, 0.05, 400, 1.0);          // 加工発熱 0、抜熱だけ
    const after = s.temperature;
    say('バイト内の抜熱（板厚平均の一致）', {
      平均低下: +(before - after).toFixed(3),
      表層: +(T0[0] - s.T[0]).toFixed(3), 芯: +(T0[3] - s.T[3]).toFixed(3),
      注: '表層ほど大きく下がり、板厚平均は集中定数解と一致するはず',
    });
  }

  // --- 8) 平坦度の «比例クラウンなら平坦» ---
  {
    const n = 21, hIn = 60, hOut = 45;
    const x = new Float64Array(n), xIn = new Float64Array(n);
    for (let i = 0; i < n; i++) { const t = (i / (n - 1) - 0.5) * 2;
      x[i] = 0.05 * (1 - t * t) - 0.05 * 2 / 3; xIn[i] = x[i] * hIn / hOut; }
    const f = R.flatness(x, hOut, xIn, hIn, 1500);
    say('比例クラウン（C/h 一定）なら平坦', { iUnit: +f.iUnit.toExponential(2), mode: f.modeName });
  }
  // --- 9) 圧延の体積保存（幅広がりを入れたあとも保つか）---
  {
    return new Promise(res => setTimeout(() => {
      window.__startAuto(false);
      const rec = [];
      let last = -1, v0 = null;
      window.__ff((p) => {
        const s = p.slab, m = p.mill;
        if (m.passIndex !== last) {
          last = m.passIndex;
          // 板は長手に一様ではない。«代表板厚 × 長さ» と «長手プロファイルの平均 × 長さ» を分けて見る
          let hm = 0; for (let i = 0; i < s.hProf.length; i++) hm += s.hProf[i];
          hm /= s.hProf.length;
          const V = s.thickness * s.width * s.length, Vp = hm * s.width * s.length;
          // クロップで落ちた屑の体積（板と同じ幅・その時の板厚で切っている）
          const cropV = p.finish.scraps.reduce((a, q) => a + q.len * q.th * q.w, 0);
          if (v0 === null) v0 = V;
          rec.push({ pass: m.passIndex + 1, h: +s.thickness.toFixed(2), w: +s.width.toFixed(1),
                     L: +(s.length / 1000).toFixed(2), hProf: +hm.toFixed(2),
                     err: +((V / v0 - 1) * 100).toFixed(2),
                     屑込み: +(((V + cropV) / v0 - 1) * 100).toFixed(2),
                     屑: +(cropV / 1e9).toFixed(4) });
        }
        return p.finish.done || !!p.tripped;
      }, 120 * 3000, 0);
      say('圧延中の体積保存（素材体積に対する誤差 %）', rec);
      res(rep);
    }, 400));
  }
  return rep;
});
for (const r of out) { console.log('■', r.t); console.log('   ', JSON.stringify(r.v)); }
if (errors.length) console.log('errors:', errors);
await browser.close();
