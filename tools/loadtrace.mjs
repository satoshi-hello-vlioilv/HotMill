// 圧延荷重の «パスの中での形» を全パスにわたって実測する評価器。
//
// なぜ要るか: これまでの評価器は «パスごとの最大・平均荷重» しか見ておらず、
// «1 パスの中で荷重がどう動くか» を問う検査がどこにも無かった。実機では
//   ・噛み込んだ瞬間に荷重が跳ねる（圧下はミルの伸びを見込んで締めてあり、
//     荷重が立つまでその無負荷ギャップがそのまま材料に当たるため）
//   ・頭と尻で荷重が高い（端部が冷えていて硬い）
// という形になる。ここではその 3 つを «そのすぐ内側» と比べて測る。
//
// 位置の取り方: いまロールバイトに入っている材料が «板の頭 / 尻» から何 mm かは、
// 入側（未圧延）座標で測る。入側の端までの距離はそのまま、出側の端までの距離は
// 伸びの逆比（gap/hIn）で入側座標へ戻す。
//
// 効果の強さは板厚で変わる（噛み込み衝撃は伸び F/M が圧下量に占める割合で決まり、
// 端部の冷えは板厚に反比例する）。厚い前段パスでは弱く、薄い後段パスで強く出る。
// また板長が端部冷却域より短いパスでは «頭・中央・尻» の区別がそもそも付かない。
// そこで «薄いパス（出側 60 mm 以下）では必ず出ること» を合格条件にしている。
import { openApp, installHelpers, DEFAULT_TARGET } from './harness.mjs';

const TARGET = process.argv[2] || DEFAULT_TARGET;
const { browser, page } = await openApp({ target: TARGET, viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG;
  /* ref を立てた判定は «参考» —— しきい値に実測の裏づけが無いものは合否に数えず、
   * 数値だけを毎回出す（CLAUDE.md の決め）。 */
  const R = { checks: [], passes: [] },
    ok = (n, p, d = '', ref = false) => R.checks.push({ name: n, pass: !!p, detail: d, ref });
  const ZONE = 1500, REF = 6000;                 // 端部として見る範囲 ／ その基準にする範囲
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  window.__startAuto(false);
  const s = P.slab, m = P.mill;
  let cur = null, rec = [], t = 0;
  const finish = () => {
    if (!cur || rec.length < 40) { cur = null; rec = []; return; }
    /* 弧が満ちていて、かつ «所定の速度で走っている» 標本だけで比べる。
     * 75 mm シャーの端部切断はパスの途中でラインを止めるので、その前後の低速区間を
     * 混ぜると «尻の荷重が低い» という別の理由（ひずみ速度が低い）が入ってしまう。 */
    const vRun = Math.max(...rec.map(q => q.v)) * 0.5;
    const full = rec.filter(q => q.fill >= 0.999 && q.v >= vRun);
    if (full.length < 20) { cur = null; rec = []; return; }
    const pick = (key, lo, hi) => full.filter(q => q[key] >= lo && q[key] < hi).map(q => q.f);
    const headF = avg(pick('dHead', 0, ZONE)), headRef = avg(pick('dHead', ZONE, REF));
    const tailF = avg(pick('dTail', 0, ZONE)), tailRef = avg(pick('dTail', ZONE, REF));
    const t0 = rec[0].t, early = rec.filter(q => q.t - t0 < 1.0);
    const spike = Math.max(...early.map(q => q.f));
    // 定常域（頭の端部帯と尻 10 % を除く）。巻取パスの尻は待って冷えた材料で荷重が立ち、
    // ミルの伸びを AGC が追い切れずに厚くなる（実機でも尻は厚い）。それは «発振» ではない
    // 過渡は «噛み込みから 3 s»（スタンドの伸びの 2 次応答が収まるまで）も除く。50 mpm の巻取パスでは
    // 端部帯 1.5 m を 1.8 s で通り過ぎるので、距離だけでは過渡を含んでしまう
    // 巻取パスはベルトラッパーが先端を掴んで張力が立つまで（十数 s）荷重が動くので、そこも過渡に含める
    const tTr = K.SCHEDULE[cur.pass - 1]?.coil ? 15 : 3;
    const late = full.filter(q => q.dHead > ZONE && q.dTail > cur.len * 0.1 && q.t - t0 > tTr).map(q => q.gap);
    /* «発振» と «ゆっくりしたずれ» を分ける。実ギャップ h ＝ S ＋ δ(F) なので、パス中に
     * 荷重が動けばギャップも動く —— 巻取パスは尻へ向かって荷重が 2,400 → 2,900 t 上がり、
     * 実機のミル定数（226〜296 t/mm）ではそれだけで 1.7 mm 伸びる。これは追従の «遅れ» で
     * あって発振ではない。振れ幅（band）だけを見るとこの 2 つが混ざる。
     * 発振は «往復» なので、隣り合う 3 点の «曲がり» x[i] − (x[i−1] + x[i+1])/2 を取れば
     * 直線的なずれは消えて往復だけが残る。その RMS を ripple とする。 */
    const ripple = (() => {
      if (late.length < 5) return 0;
      let sum = 0, n2 = 0;
      for (let i = 1; i < late.length - 1; i++) {
        const c = late[i] - (late[i - 1] + late[i + 1]) / 2;
        sum += c * c; n2++;
      }
      return n2 ? Math.sqrt(sum / n2) : 0;
    })();
    /* «往復しているか» は符号の反転で見る。単調に増えるだけのずれ（尻が冷えて荷重が
     * 立つ、など）は反転しない。標本 100 点あたりの反転数で出す —— 発振なら 50 に近づき、
     * ゆっくりしたずれなら 0 に近い。 */
    const flips = (() => {
      if (late.length < 5) return 0;
      let f = 0, prev = 0;
      for (let i = 1; i < late.length; i++) {
        const d = late[i] - late[i - 1];
        if (Math.abs(d) < 1e-9) continue;
        const sg = Math.sign(d);
        if (prev && sg !== prev) f++;
        prev = sg;
      }
      return f / (late.length - 1) * 100;
    })();
    // 頭からの距離で前 1/4 と後 1/4 の平均荷重（巻取パスの «尻へ向かって上がる» を見る）
    const q1 = avg(full.filter(q => q.dHead < cur.len * 0.25).map(q => q.f));
    const q4 = avg(full.filter(q => q.dHead > cur.len * 0.75).map(q => q.f));
    R.passes.push({
      pass: cur.pass, gap: cur.gap, len: Math.round(cur.len / 1000),
      ripple: +ripple.toFixed(4), flips: +flips.toFixed(1),
      spike: Math.round(spike), headRef: Math.round(headRef),
      spikeR: +(spike / Math.max(headRef, 1)).toFixed(3),
      headR: +(headF / Math.max(headRef, 1)).toFixed(3),
      tailR: +(tailF / Math.max(tailRef, 1)).toFixed(3),
      band: +(late.length ? Math.max(...late) - Math.min(...late) : 0).toFixed(2),
      hOut: +full[full.length - 1].gap.toFixed(2),
      dTend: +cur.dTend.toFixed(1), dTmid: +cur.dTmid.toFixed(1),
      coil: !!K.SCHEDULE[cur.pass - 1]?.coil, q1, q4,
    });
    cur = null; rec = [];
  };
  while (t < 4000 && !P.finish.done && !P.tripped) {
    P.step(1 / 120); t += 1 / 120;
    const i = m.passIndex;
    if (s.inBite && i >= 0) {
      if (!cur || cur.pass !== i + 1) { finish(); cur = { pass: i + 1, gap: K.SCHEDULE[i]?.gap ?? 0, len: s.length }; }
      const gap = m.gap, hIn = s.thickness;
      rec.push({ t: +t.toFixed(3), f: m.forceMeas ?? s.rollForce, fill: s.biteFill, gap, v: Math.abs(m.currentSpeed),
                 dHead: (s.dir > 0 ? s.xMax : -s.xMin) * gap / Math.max(hIn, 1e-6),
                 dTail: s.dir > 0 ? -s.xMin : s.xMax });
      const D = s.dTProf, N = D.length;
      const c = Math.max(1, Math.round(ZONE / Math.max(s.length / (N - 1), 1)));
      let e = 0; for (let j = 0; j < c; j++) e += D[j] + D[N - 1 - j];
      cur.dTend = e / (2 * c);
      cur.dTmid = (D[(N >> 1) - 2] + D[N >> 1] + D[(N >> 1) + 2]) / 3;
    } else if (cur) finish();
  }
  finish();
  R.done = P.finish.done; R.tripped = P.tripped;
  const ps = R.passes, thin = ps.filter(q => q.gap <= 60);

  ok('全パスを過負荷停止せずに通せる', !!R.done && !R.tripped, R.tripped || `${ps.length} パス完走`);
  ok('薄いパス（出側 60 mm 以下）は必ず噛み込みのピークが立つ',
     thin.length > 0 && thin.every(q => q.spikeR >= 1.03),
     thin.map(q => `P${q.pass} ${q.spikeR}`).join(' '));
  /* 端部の割増は «頭と尻の平均» で見る。可逆圧延は 1 パスごとに向きが変わるので、
   * このパスの頭は前のパスの尻で、切断（30 mm / 75 mm シャー）を受けた側も交互に入れ替わる。
   * どちらの端がより効くかはパスによって入れ替わるのが実機どおりで（実測: 第 7 パスは
   * 尻 +11.5 %／頭 +1.6 %、第 11 パスは頭 +16.1 %／尻 +0.9 %）、片方ずつに同じ下限を
   * 課すのは «端部の効き» ではなく «その回の向き» を測っていることになる。
   * 平均に下限を置き、そのうえで «どちらの端も内側を下回らない» ことを別に問う。 */
  const endR = (q) => (q.headR + q.tailR) / 2;
  /* 閾値 2 %: クロップ後の端は角が立っていて薄くない（端部の割増は張り出しがある厚板段だけ）ので、
   * 残る端部効果は端面からの放熱と炉出し時の端の冷え（END_CHILL.T0 = 15 K）だけ。実測 2.2〜5 %。 */
  ok('薄いパスは端部（頭と尻の平均）の荷重が内側より 2 % 以上高い',
     thin.length > 0 && thin.every(q => endR(q) >= 1.02),
     thin.map(q => `P${q.pass} ${endR(q).toFixed(3)}`).join(' '));
  ok('薄いパスはどちらの端も内側を下回らない',
     thin.length > 0 && thin.every(q => q.headR >= 1.0 && q.tailR >= 1.0),
     thin.map(q => `P${q.pass} ${q.headR}/${q.tailR}`).join(' '));
  /* 板長が «基準帯の 2 倍»（12 m）に満たないパスでは、端部帯（0〜1.5 m）と基準帯
   * （1.5〜6 m）が板の反対側と重なってしまい、頭・中央・尻の区別がそもそも付かない
   * （このファイル冒頭の断り書きのとおり）。区別が付くパスだけで «端は内側より高い» を問う。 */
  const longP = ps.filter(q => q.len >= 12);
  ok('板長が足りるパスでは頭・尻とも内側より高い',
     longP.length > 0 && longP.every(q => q.headR >= 1.0 && q.tailR >= 1.0),
     `${longP.length} パス中 ${longP.filter(q => q.headR >= 1.0 && q.tailR >= 1.0).length} パス`);
  /* 巻取パスは尻が入側で 4 分待つあいだに冷える（巻かれた頭はコイルの中で断熱）ので、荷重は
   * 頭から尻へ単調に上がる —— 実機 16 → 8 mm で頭 2,400 → 尻 2,900 t。板長の «後ろ 1/4» の
   * 平均が «前 1/4» より 10 % 以上高いことを問う（旧 «薄いほど端部が強い» は張り出しの薄さを
   * 前提にしており、クロップ後の端には当てはまらないので置き換えた）。 */
  const coilP = ps.find(q => q.coil);
  ok('巻取パスは尻へ向かって荷重が上がる（後 1/4 が前 1/4 より 10 % 以上高い）',
     !!coilP && coilP.q4 / Math.max(coilP.q1, 1) >= 1.10,
     coilP ? `前 1/4 ${Math.round(coilP.q1)} t → 後 1/4 ${Math.round(coilP.q4)} t（${(coilP.q4 / coilP.q1).toFixed(2)} 倍）` : '巻取パス無し');
  // 巻取パスは頭がコイルの中で断熱され（+40 K）、尻だけが冷えるので «両端が冷たい» の対象外
  ok('頭・尻が中央より冷えている（長手方向の温度偏差。巻取パスを除く）', ps.filter(q => !q.coil).every(q => q.dTend < q.dTmid - 3),
     ps.map(q => `P${q.pass} ${q.dTend}/${q.dTmid}`).slice(0, 4).join(' '));
  ok('板厚制御が発振しない（往復成分 ripple が目標板厚の 1 % 以内）',
     ps.every(q => q.ripple <= q.gap * 0.01), ps.map(q => `P${q.pass} ${q.ripple}`).join(' '));
  ok('（参考）ギャップが «往復» しているか（標本 100 点あたりの向きの反転数）', true,
     ps.map(q => `P${q.pass} ${q.flips}`).join(' '), true);
  /* 振れ幅そのものは «荷重が動いたぶんミルが伸びる» を含むので、合否には数えず参考に出す。
   * 実機のミル定数を入れてから巻取パスでは 0.5 mm 級になる —— それが実機の姿。 */
  ok('（参考）過渡後のギャップの振れ幅', ps.every(q => q.band <= q.gap * 0.05),
     ps.map(q => `P${q.pass} ${q.band}`).join(' '), true);
  ok('出側板厚が目標に収まる（±3 %）', ps.every(q => Math.abs(q.hOut - q.gap) <= q.gap * 0.03),
     ps.map(q => `P${q.pass} ${q.hOut}/${q.gap}`).join(' '));
  ok('ピークが非常最大を超えない', ps.every(q => q.spike <= K.MILL.LIMIT_FORCE_T),
     `最大 ${Math.max(...ps.map(q => q.spike))} t / 非常最大 ${K.MILL.LIMIT_FORCE_T} t`);

  R.failed = R.checks.filter(c => !c.pass && !c.ref).length;
  return R;
});

for (const c of out.checks) console.log(`  ${c.ref ? '??  ' : c.pass ? 'ok  ' : 'NG  '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
console.log('\npass 別:');
for (const q of out.passes)
  console.log(`  P${String(q.pass).padStart(2)} 出側 ${String(q.gap).padStart(6)} mm  板長 ${String(q.len).padStart(3)} m  ` +
    `衝撃 ${q.spikeR}  頭 ${q.headR}  尻 ${q.tailR}  振れ ${q.band} mm（往復 ${q.ripple} mm・反転 ${q.flips}/100）  端部 ${q.dTend} K`);
const nRef = out.checks.filter(c => c.ref).length;
console.log(`\nRESULT: ${out.failed ? 'FAIL' : 'PASS'} (${out.checks.length - nRef - out.failed}/${out.checks.length - nRef}`
  + `${nRef ? `、参考 ${nRef} 件` : ''})`);
await browser.close();
process.exit(out.failed ? 1 : 0);
