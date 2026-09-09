// 実機ロット（較正の基準データ）と、それを本アプリで «そのまま流す» 共通ランナー。
// realsched.mjs（パス表を眺める）と calib.mjs（採点する）が同じ 1 か所を見る。
//
// 実機データ（2026-09 提供）:
//   材質 A5052、鋳造厚 560・片面 15 面削 → 530、1,330 W × 3,450 L
//   炉出し（持ちかかり）433 ℃ → 上がり 360 ℃、クーラント液温 64 ℃・濃度 4.8 %
//   入側の板面冷却なし・出側のみ
//   120 mpm 530 → 65（17 パス、65 でクロップ）約 3 分        荷重 1,000〜1,800 t
//   120 mpm  65 → 26（4 パス）                 約 4 分 30 秒   荷重   800〜1,200 t
//    80 mpm  26 → 16（1 パス）                 約 1 分 30 秒   荷重   750〜  900 t
//    50 mpm  16 →  8（1 パス・巻取）           約 4 分         荷重 2,400〜2,900 t
//   8 mm 圧延完了時の板長 219.4 m
export const REAL = {
  lot: { cast: 560, scalp: 15, width: 1330, length: 3450, temp: 433, alloy: 'A5052', target: 8, trim: 15, mode: 'COIL' },
  gaps: [520, 490, 460, 430, 400, 370, 340, 310, 280, 250, 220, 190, 160, 130, 105, 85, 65, 56, 46, 36, 26, 16, 8],
  speed: (i) => i < 21 ? 120 : i === 21 ? 80 : 50,
  // 区間: [先頭パス index, 末尾パス index(排他), 実機の秒, 荷重帯 [t]]
  seg: [{ a: 0, b: 17, sec: 180, band: [1000, 1800], name: '厚板段 530→65' },
        { a: 17, b: 21, sec: 270, band: [800, 1200], name: '仕上げ 65→26' },
        // 26 → 16 mm の 750〜900 t は前段（800〜1,200 t）より軽く、摩擦ゼロでも変形抵抗から 1,000 t を
        // 下回れない。実機の再確認が取れるまで «参考»（soft）にする —— calib.mjs は合否に数えない
        { a: 21, b: 22, sec: 90, band: [750, 900], name: '26→16 (80 mpm)', soft: true },
        { a: 22, b: 23, sec: 240, band: [2400, 2900], name: '16→8 巻取 (50 mpm)' }],
  tEnd: 360, lenM: 219.4, coolant: { T: 64, conc: 4.8 },
};

/** `--set=PATH=value` を CONFIG へ当てる（PATH は CONFIG からのドット区切り）。較正のノブ。 */
export function parseSets(args) {
  return args.filter(a => a.startsWith('--set=')).map(a => {
    const [k, v] = a.slice(6).split('='); return { path: k, value: isNaN(+v) ? v : +v };
  });
}

/**
 * 実機スケジュールを本アプリで流し、パスごとの実績と温度収支の内訳を返す。
 * page には harness.installHelpers 済みのページを渡す。
 */
export async function runReal(page, { temp = REAL.lot.temp, sets = [], useApp = false } = {}) {
  return page.evaluate(async ({ REAL, temp, sets, useApp }) => {
    const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL, F = K.FLIP;
    for (const { path, value } of sets) {
      const ks = path.split('.'); let o = K; for (const k of ks.slice(0, -1)) o = o[k]; o[ks[ks.length - 1]] = value;
    }
    const d = { ...REAL.lot, temp };
    const c = document.getElementById('chk-supply-anim'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change')); }
    A.bus.emit('CMD_SET_SLAB', d);
    await new Promise(r => setTimeout(r, 50));
    const h0 = d.cast - 2 * d.scalp, al = K.ALLOYS[d.alloy];
    const gen = R.buildSchedule(h0, d.target, d.width, temp, { coil: true, length: d.length, alloy: d.alloy });
    let h = h0;
    const real = REAL.gaps.map((g, i) => {
      const v = REAL.speedTable[i], st = R.solve(h, g, d.width, v, temp, 0, al).forceTon;
      const row = { pass: i + 1, gap: g, dir: F * (i % 2 === 0 ? 1 : -1), coil: i === REAL.gaps.length - 1,
                    speed: v, force: Math.round(st * K.PROCESS.PEAK_K), steady: Math.round(st), tEnd: temp,
                    bite: +(Math.acos(1 - (h - g) / K.MILL.WR_D) * 180 / Math.PI).toFixed(1) };
      h = g; return row;
    });
    if (!useApp) { K.SCHEDULE = real; A.ui.renderSchedule?.(); }
    document.getElementById('btn-start').click();
    const s = P.slab, m = P.mill, rows = [], budgets = [];
    let t = 0, wasRolling = false, hd = null, tl = {}, rollT0 = m.rollTemp, lastIdx = -1;
    while (t < 6000 && !P.finish.done && !P.tripped) {
      P.step(1 / 120); t += 1 / 120;
      if (m.passIndex !== lastIdx) { lastIdx = m.passIndex; rollT0 = m.rollTemp; hd = null; }
      if (s.inBite && s.biteFill > 0.99) {
        const u = s.uBite(m.gap), T = s.temperature + s.dTEntry(u);
        if (!hd) hd = { f: m.forceMeas, T };                 // 弧が満ちた直後 ＝ 頭
        tl = { f: m.forceMeas, T };                          // 最後の標本 ＝ 尻
      }
      const endOfPass = wasRolling && !s.rollingActive; wasRolling = s.rollingActive;
      if (endOfPass && m.passIndex >= 0) {
        const sp = R.curlSpan(s.kNew, s.thickness, s.width, s.alloy);
        rows[m.passIndex] = { k: s.kNew, R_m: Math.abs(s.kNew) > 1e-9 ? 1 / Math.abs(s.kNew) / 1000 : Infinity,
                              kb: s.kBite, tip: sp.tip, lift: sp.liftOff, top: s.tTop, bot: s.tBot, Tm: s.temperature, len: s.length,
                              fHead: hd?.f, fTail: tl.f, Thead: hd?.T, Ttail: tl.T, rollT0 };
      }
    }
    // 各パスの温度収支の内訳（予測式を «そのパスの実績条件» で評価したもの）
    const log = P.log.rows, lp = P.log.passes;
    log.forEach((r, i) => {
      const q = lp[i]; if (!q || r.hIn == null || r.tIn == null) return;
      const secs = q.t1 != null ? q.t1 - q.t0 : 0;
      const b = R.tempBudget(r.hIn, r.hOut ?? r.gap, r.vMax || 1, r.tIn, secs, al, s.width,
                             (r.len ?? s.length) / 2 + 4000, rows[i]?.rollT0 ?? K.MILL.ROLL_T0, !!(K.SCHEDULE[i]?.coil));
      budgets[i] = { ...b, sim: (r.tOut ?? r.tIn) - r.tIn, secs };
    });
    const passes = log.map((r, i) => ({ ...r, ...(rows[i] || {}), plan: K.SCHEDULE[i], budget: budgets[i] }));
    const t0 = (i) => lp[i]?.t0, t1 = (i) => lp[i]?.t1;
    const segs = REAL.seg.map(sg => ({ ...sg, n: log.slice(sg.a, sg.b).length,
      simSec: (t0(sg.a) !== undefined && t1(sg.b - 1) != null) ? t1(sg.b - 1) - t0(sg.a) : null }));
    return { passes, gen, real, segs, done: P.finish.done, tripped: P.tripped, total: P.log.lot?.t,
             outTemp: s.temperature, outLen: s.length, outTh: s.thickness,
             coil: { od: P.finish.od, mass: P.finish.coilMass }, config: { MU: K.PROCESS.MU, H_ROLL: K.MATERIAL.H_ROLL } };
  }, { REAL: { ...REAL, speed: undefined, speedTable: REAL.gaps.map((_, i) => REAL.speed(i)) }, temp, sets, useApp })
    .catch(e => { throw e; });
}
