// 75 mm シャーの下台が上がるとき、板がテーブルロールへ «めり込まない» ことを測る。
//
// 下台（下刃付きの昇降テーブル。長さ BED_L ＝ 640 mm）は刃の上流側にあり、板を載せたまま
// 最大 UPPER_CLR + OVERTRAVEL ＝ 150 mm 持ち上げて固定上刃に押し当てる。板はそこだけが
// 上がるので、上流は浮いてテーブルロールから離れる —— 離れるのは正しい。
// ロールの «中» へ入っていくのが誤り。
//
// 【直した不具合】上流で 150.0 mm（＝持ち上げ量そのもの）めり込んでいた。
// 原因は «据わり» の計算と «頂点» の計算で違う持ち上げ形を使っていたこと ——
// 据わり（SlabView._restPose）には全ロールへ持ち上げ量を «全量» 渡し、頂点には
// 2 m で減衰させた量を与えていた。据わりはその差を «板全体が持ち上がった» と読んで
// 同じだけ押し下げるので、減衰しきった上流でちょうど持ち上げ量ぶん沈んでいた。
// いまは Rolling.bedLiftAt の 1 式を両方が見る。
//
// 【入れた剛性挙動】上流の戻り方も «剛体が 2 m で戻る» から «自重でたわむ梁» にした。
// 接地点では高さ・傾き・曲げモーメントの 3 つが連続し、下台の縁は線接触なので
// モーメント 0 —— これを EI·y'''' = −q で解くと
//     浮き上がり長 L = (24·(EI/q)·δ)^(1/4)、  形 y(s) = δ·t³·(2−t)（t = s/L）
// 実測で 65 mm・δ 150 mm のとき L ＝ 7.0 m。以前置いていた 2 m とは桁が違う。
//
// 測り方は «見えているもの» そのもの —— 板メッシュの頂点をそのまま読み、テーブルロールが
// 在る X ごとに «板の下面がロール上面（パスライン）よりどれだけ下か» を出す。
//
//   node tools/shearbed.mjs
import { openApp, installHelpers } from './harness.mjs';

const LOT = { cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052' };
const TOL = 1.0;                         // めり込みの許容 [mm]（描画の丸め程度）
/* 下台を使う場面は 2 つ —— 端部切断（コイル材でも板材でも通る）と、板材の切り分け。
 * 板厚 40 mm の板材は 75 mm シャーで定尺に切り分けるので、下台が何度も上下する。 */
const CASES = [{ name: 'コイル材 8 mm（端部切断）', target: 8 },
               { name: '板材 40 mm（75 mm シャーで切り分け）', target: 40 }];

const measure = async ({ target }) => {
  const { browser, page } = await openApp({ viewport: { width: 1280, height: 720 }, quiet: true });
  await installHelpers(page);
  const r = await page.evaluate(({ LOT, target }) => new Promise(res => setTimeout(async () => {
    const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, sc = K.SCALE;
    const SV = W.slabView, R = window.__ROLL, F = K.FLIP;

    /** 板メッシュの頂点から «X ごとの下面の高さ»[mm]（世界の高さ）を作る。
     *  頂点はシーン単位なので mm へ戻し、X を 50 mm の枡に丸めて枡ごとの最小 y を取る。 */
    const bottomByX = () => {
      const pos = SV.mesh.geometry.attributes.position, n = pos.count, m = new Map();
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i) / sc, y = pos.getY(i) / sc, k = Math.round(x / 50);
        const q = m.get(k);
        if (q === undefined || y < q) m.set(k, y);
      }
      return m;
    };

    /* 目標板厚はロットの一部（仕上げ形態もここで決まる）。スライダだけ動かして
     * そのあと slab.reset を呼ぶと既定へ戻ってしまうので、ロットごと与える。 */
    A.bus.emit('CMD_SET_SLAB', { ...LOT, target,
                                 mode: target > K.SLAB.FINISH.COIL_MAX_TH ? 'PLATE' : 'COIL' });
    await new Promise(q => setTimeout(q, 80));
    window.__startAuto(false);

    const rollX = window.__LAYOUT.rolls().map(r => r.x);
    let worst = null, samples = 0, beam = null, peak = null;
    const byStage = {};

    window.__ff((p) => {
      const s = p.slab, f = p.finish;
      const delta = f.bedLift || 0;                        // 下台の持ち上げ量 [mm]
      if (!(delta > 0) || !s.onLine) return f.done || !!p.tripped;
      /* 評価器は描画ループを止めてあるので、測る前にこのコマの姿勢を自分で作らせる。
       * mesh.visible は update の中で決まるので、判定は update の «あと» に置く。 */
      SV.update(s, p.mill, f);
      if (!SV.mesh.visible) return f.done || !!p.tripped;
      const bot = bottomByX(), PL = p.mill.passLine;
      samples++;

      for (const rx of rollX) {
        if (rx < s.xMin - 1 || rx > s.xMax + 1) continue;   // 板の下に無いロールは関係ない
        const q = bot.get(Math.round(rx / 50));
        if (q === undefined) continue;
        const dep = PL - q;                                 // ＋ ならロール上面より下 ＝ めり込み
        /* 端部切断が終わっても cropStage は DONE のまま残るので、切り分け中は
         * plateStage で見分ける（そうしないと切り分けの標本まで crop/DONE になる）。 */
        const st = (f.plateStage === 'DIVIDE' && f.divideStage)
                 ? `divide/${f.divideStage}` : `crop/${f.cropStage}`;
        if (!byStage[st] || dep > byStage[st].dep) byStage[st] = { dep, x: rx };
        if (!worst || dep > worst.dep) worst = { dep, x: rx, delta, stage: st, th: s.thickness };
      }

      /* 下台の «上» に板の断面が在るコマだけを、姿勢の標本にする。
       * 端部を切り終えたあとの下台には端材しか載っておらず、板は離れている ——
       * そのコマまで «板が下台に追随しているか» に数えると、追随していないのが
       * 当たり前なのに不合格になる（最初その作りで、回によって結果が変わっていた）。 */
      const a = K.CROP_SHEAR.X, b = K.CROP_SHEAR.X - F * K.CROP_SHEAR.BED_L;
      const bedLo = Math.min(a, b) + 50, bedHi = Math.max(a, b) - 50;   // 刃の面は含めない
      let onBedUp = -Infinity;
      for (const [k, y] of bot) { const x = k * 50;
                                  if (x >= bedLo && x <= bedHi) onBedUp = Math.max(onBedUp, y - PL); }
      if (onBedUp > -Infinity && (!peak || delta >= peak.delta)) {
        /* 持ち上げが最大のコマの «梁としての姿»。
         *   L      浮き上がり長（下台の縁からテーブルに着くまで）
         *   σ_bend 最大曲げ応力（梁の中央 s = L/2）
         *   σ_flow その温度・その «曲げのひずみ速度» での変形抵抗
         * σ_bend が σ_flow を超えるなら、持ち上げは弾性では済まず永久の曲がりが残る。 */
        const al = K.ALLOYS[s.alloy] || R.alloy();
        const sp = R.bedLiftSpan(delta, s.thickness, s.width, al);
        const eps = sp.sigma / (al.E * 1000);               // 表面の曲げひずみ [-]
        const rate = eps / K.CROP_SHEAR.T_CUT;              // その曲げが付くまでのひずみ速度 [1/s]
        beam = { delta, L: sp.L, sigma: sp.sigma, eps, rate, th: s.thickness, wid: s.width,
                 stage: (f.plateStage === 'DIVIDE' && f.divideStage)
                      ? `divide/${f.divideStage}` : `crop/${f.cropStage}`,
                 T: s.temperature, kf: R.flowStress(s.temperature, rate, al),
                 kf1: R.flowStress(s.temperature, 1, al),
                 kappa: sp.sigma / (al.E * 1000 * s.thickness / 2) };
        /* 下台の縁から «上流へ» 1 m 刻みの下面の高さ（梁の形がそのまま出る）。 */
        const edge = K.CROP_SHEAR.X - F * K.CROP_SHEAR.BED_L;
        const prof = [];
        for (let d = 0; d <= 9000; d += 1000) {
          const xm = edge - F * d;                          // d は上流向きの距離
          let best = null, bd = 400;
          for (const [k, y] of bot) { const dx = Math.abs(k * 50 - xm);
                                      if (dx < bd) { bd = dx; best = y - PL; } }
          prof.push({ d, y: best });
        }
        peak = { delta, up: onBedUp, prof };
      }
      return f.done || !!p.tripped;
    }, 120 * 3000, 0);

    res({ worst, samples, byStage, beam, peak, mode: P.finish.mode, th: P.slab.thickness });
  }, 400)), { LOT, target });
  await browser.close();
  return r;
};

const checks = [];
const ok = (n, pass, got, ref = false) => checks.push({ name: n, pass: !!pass, got, ref });
const CS = { X: -30600, BED_L: 640, LIFT: 150 };

for (const c of CASES) {
  const o = await measure(c);
  console.log(`\n■ ${c.name} —— 下台が上がっているあいだの標本 ${o.samples} コマ`);
  if (o.worst) {
    console.log(`  いちばん深いめり込み ${o.worst.dep.toFixed(1)} mm`
      + `（X ${o.worst.x} mm・下台 ${o.worst.delta.toFixed(0)} mm 上昇・板厚 ${o.worst.th.toFixed(1)} mm）`);
    for (const [st, q] of Object.entries(o.byStage))
      console.log(`    ${st.padEnd(16)} 最大 ${q.dep.toFixed(1)} mm（X ${q.x} mm）`);
  }
  if (o.beam) {
    const b = o.beam;
    console.log(`  梁としての姿（${b.stage}・板厚 ${b.th.toFixed(1)} mm × 幅 ${b.wid.toFixed(0)} mm・${b.T.toFixed(0)} ℃・δ ${b.delta.toFixed(0)} mm）`);
    console.log(`    浮き上がり長 L      ${(b.L / 1000).toFixed(2)} m     L ＝ (24·(EI/q)·δ)^(1/4)`);
    console.log(`    最大曲げ応力 σ_bend ${b.sigma.toFixed(1)} MPa    板厚にも板幅にも依らず (3/4)·√(2δEρg)`);
    console.log(`    曲げひずみ          ${(b.eps * 1e6).toFixed(0)} µ（ひずみ速度 ${b.rate.toExponential(1)} /s）`);
    console.log(`    そのときの変形抵抗  ${b.kf.toFixed(1)} MPa（同じ温度・ひずみ速度 1/s なら ${b.kf1.toFixed(1)} MPa）`);
    console.log(`    σ_bend / 変形抵抗   ${(b.sigma / Math.max(b.kf, 1e-6)).toFixed(2)}`
      + `   曲率 ${(b.kappa * 1e6).toFixed(1)}×10⁻⁶ /mm ＝ 定尺 1 m で ${(b.kappa * 1e6 / 8).toFixed(2)} mm`);
  }
  if (o.peak?.prof)
    console.log('  最大持ち上げ時の板の下面（下台の縁から上流へ / パスラインからの高さ mm）\n    '
      + o.peak.prof.map(q => `${(q.d / 1000).toFixed(0)}m:${q.y === null ? '—' : q.y.toFixed(0)}`).join('  '));

  ok(`${c.name}: 下台が上がる場面が測れている`, o.samples > 0, `${o.samples} コマ`);
  ok(`${c.name}: 板がテーブルロールへめり込まない（${TOL} mm 以内）`,
     o.worst ? o.worst.dep <= TOL : false,
     o.worst ? `最大 ${o.worst.dep.toFixed(1)} mm（X ${o.worst.x} mm）` : '標本なし');
  ok(`${c.name}: 下台に載っている側は下台と一緒に持ち上がる`,
     o.peak ? o.peak.up >= o.peak.delta - 1 : false,
     o.peak ? `下台 ${o.peak.delta.toFixed(0)} mm に対し下台の上の板 ${o.peak.up.toFixed(0)} mm` : '標本なし');
  ok(`${c.name}: 浮き上がり長が下台より長く、出側テーブルに収まる`,
     o.beam ? o.beam.L > CS.BED_L && o.beam.L < 80000 : false,
     o.beam ? `${(o.beam.L / 1000).toFixed(2)} m` : '標本なし');
  /* 【参考】曲げ応力が変形抵抗を超えるかは «超えたら永久の曲がりが残る» という別の話。
   * 実測すると比は 1 のすぐ近くで、しきい値の実測の裏づけも無いので合否には数えず、
   * 数値だけを毎回出す（README 0-4 の «下台の持ち上げが永久の曲がりを残すか»）。 */
  ok(`（参考）${c.name}: 持ち上げの曲げ応力 vs 変形抵抗`, true,
     o.beam ? `σ_bend ${o.beam.sigma.toFixed(1)} MPa ／ 変形抵抗 ${o.beam.kf.toFixed(1)} MPa`
            + `（比 ${(o.beam.sigma / Math.max(o.beam.kf, 1e-6)).toFixed(2)}`
            + `${o.beam.sigma > o.beam.kf ? '・超えている' : '・弾性の範囲'}）` : '標本なし', true);
}

console.log('');
for (const c of checks) console.log(`${c.ref ? '??  ' : c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass && !c.ref), nRef = checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${bad.length ? 'FAIL' : 'PASS'} (${checks.length - nRef - bad.length}/${checks.length - nRef}`
  + `、参考 ${nRef} 件)`);
process.exit(bad.length ? 1 : 0);
