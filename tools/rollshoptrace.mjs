// ロール現品管理（組・研削・粗度・摩擦への効き）の «実測» トレース。
//   node rollshoptrace.mjs
import { openApp, installHelpers } from './harness.mjs';
const { browser, page, errors } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);
const out = await page.evaluate(() => {
  const A = window.__app, P = A.physics, K = window.__CFG, R = window.__ROLL;
  const M = K.MILL, S = M.ROLL_SHOP;
  const checks = [], ok = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });

  // 1) 保有数と諸元が仕様どおり
  const sh = P.rolls;
  ok('WR / BUR の保有組数が仕様どおり', sh.wr.length === 7 && sh.br.length === 2,
     `WR ${sh.wr.length} 組 / BUR ${sh.br.length} 組`);
  ok('ロール寸法が仕様どおり', M.WR_D === 930 && M.WR_D_MIN === 885 && M.BR_D === 1430 && M.BR_D_MIN === 1350,
     `WR Φ${M.WR_D}（最小 Φ${M.WR_D_MIN}）／ BUR Φ${M.BR_D}（最小 Φ${M.BR_D_MIN}）`);
  ok('研削クラウンが仕様どおり（径差）', M.WR_CROWN === 150 && M.BR_CROWN === -50,
     `WR ${M.WR_CROWN > 0 ? '+' : ''}${M.WR_CROWN} µm / BUR ${M.BR_CROWN} µm`);
  ok('メーカー・硬度・粗度が諸元に載っている',
     /関東特殊鋼/.test(M.WR_MAKER) && /日本製鋼/.test(M.BR_MAKER) && /60/.test(M.WR_HARDNESS) && /1.10/.test(M.WR_ROUGHNESS),
     `${M.WR_MAKER} ${M.WR_HARDNESS} ${M.WR_ROUGHNESS} ／ ${M.BR_MAKER} ${M.BR_HARDNESS} ${M.BR_ROUGHNESS}`);

  // 2) 在庫の作り方: 新品指定なら全組が新品径、限度指定なら全組が最小径
  sh.reset(0);
  // «研削状態» はミルに入っている組の話。在庫の残りは組ごとに履歴が違うのが現場の姿
  ok('新品指定で使用中の組が新品径', Math.abs(sh.wrSet.dia - M.WR_D) < 1e-9 && Math.abs(sh.brSet.dia - M.BR_D) < 1e-9,
     `使用中 WR Φ${sh.wrSet.dia.toFixed(0)} / BUR Φ${sh.brSet.dia.toFixed(0)}（在庫 ${sh.wr.map(q => q.dia.toFixed(0)).join('/')}）`);
  sh.reset(1);
  ok('研削限度指定で全組が最小径', sh.wr.every(q => Math.abs(q.dia - M.WR_D_MIN) < 1e-9),
     `WR ${sh.wr.map(q => q.dia.toFixed(0)).join('/')}`);
  sh.reset(0.5);
  const spread = Math.max(...sh.wr.map(q => q.dia)) - Math.min(...sh.wr.map(q => q.dia));
  ok('途中の指定では組ごとに履歴が散る（現場の在庫）', spread > 1,
     `径の幅 ${spread.toFixed(1)} mm（${sh.wr.map(q => q.dia.toFixed(0)).join('/')}）`);
  ok('どの組も新品径と最小径の間にある',
     sh.wr.every(q => q.dia <= M.WR_D + 1e-9 && q.dia >= M.WR_D_MIN - 1e-9)
     && sh.br.every(q => q.dia <= M.BR_D + 1e-9 && q.dia >= M.BR_D_MIN - 1e-9), 'すべて範囲内');

  // 3) 粗度: 研削したてから使うほど WR は荒れ BUR は磨かれる（向きが逆）
  sh.reset(0);
  const ra0 = { wr: sh.wrSet.ra, br: sh.brSet.ra };
  sh.advance(S.CAMPAIGN * 0.999);
  ok('研削したての粗度が仕様の下限', Math.abs(ra0.wr - S.WR.RA_NEW) < 1e-9 && Math.abs(ra0.br - S.BR.RA_NEW) < 1e-9,
     `WR ${ra0.wr} / BUR ${ra0.br} µmRa`);
  ok('WR は使うほど荒れ、BUR は磨かれる（向きが逆）', sh.wrSet.ra > ra0.wr && sh.brSet.ra < ra0.br,
     `WR ${ra0.wr} → ${sh.wrSet.ra.toFixed(2)} ／ BUR ${ra0.br} → ${sh.brSet.ra.toFixed(2)} µmRa`);
  ok('粗度が仕様の範囲を出ない',
     sh.wrSet.ra <= S.WR.RA_END + 1e-9 && sh.brSet.ra >= S.BR.RA_END - 1e-9,
     `WR ${sh.wrSet.ra.toFixed(2)} ≤ ${S.WR.RA_END} ／ BUR ${sh.brSet.ra.toFixed(2)} ≥ ${S.BR.RA_END}`);

  // 4) 交換と研削: 寿命で交換 → 外した組は細くなり粗度が戻る
  sh.reset(0);
  ok('寿命前は交換不要', !sh.needChange, `使用 0 / 寿命 ${S.CAMPAIGN.toExponential(1)}`);
  sh.advance(S.CAMPAIGN);
  ok('寿命に達すると交換が要る', sh.needChange, `使用 ${sh.wrSet.work.toExponential(2)} t·mm`);
  const before = { no: sh.wrSet.no, dia: sh.wrSet.dia, g: sh.wrSet.grinds };
  sh.change();
  const old = sh.wr.find(q => q.no === before.no);
  ok('外した組は研削されて細くなり、粗度と使用量が戻る',
     Math.abs(old.dia - (before.dia - S.GRIND_WR)) < 1e-9 && old.work === 0 && Math.abs(old.ra - S.WR.RA_NEW) < 1e-9,
     `${before.no} 組 Φ${before.dia.toFixed(0)} → Φ${old.dia.toFixed(0)} ／ 研削 ${before.g} → ${old.grinds} 回`);
  ok('別の組に入れ替わる', sh.wrSet.no !== before.no, `${before.no} 組 → ${sh.wrSet.no} 組`);

  // 5) 最小径を割ったら新品に入れ替わる（廃却）
  sh.reset(1);                                    // 全組が最小径
  sh.advance(S.CAMPAIGN); sh.change();
  ok('最小径を割った組は新品に入れ替わる', sh.wr.some(q => Math.abs(q.dia - M.WR_D) < 1e-9),
     `WR ${sh.wr.map(q => q.dia.toFixed(0)).join('/')}`);

  // 6) 粗度が摩擦係数に効く（荒いほど μ が高い）
  const muNew = R.friction(450, 120, S.WR.RA_NEW), muEnd = R.friction(450, 120, S.WR.RA_END);
  const muNone = R.friction(450, 120);
  ok('粗度が荒いほど摩擦係数が高い', muEnd > muNew, `${S.WR.RA_NEW}: ${muNew.toFixed(4)} → ${S.WR.RA_END}: ${muEnd.toFixed(4)}`);
  ok('粗度の効きが 20 % 以内（過大にしない）', (muEnd - muNew) / muNone < 0.2,
     `${((muEnd - muNew) / muNone * 100).toFixed(1)} %`);
  ok('粗度を渡さなければ従来どおり', Math.abs(R.friction(450, 120, M.MU_RA_REF) - muNone) < 1e-12,
     `基準粗度 ${M.MU_RA_REF} µmRa で一致`);

  // 7) 圧延するとミルの現在径が «いま入っている組» と一致する
  P.rolls.reset(0.4); P._mountRolls();
  ok('ミルの現在径が使用中の組と一致する',
     Math.abs(P.mill.wrDia - P.rolls.wrSet.dia) < 1e-9 && Math.abs(P.mill.brDia - P.rolls.brSet.dia) < 1e-9,
     `WR Φ${P.mill.wrDia.toFixed(1)} / BUR Φ${P.mill.brDia.toFixed(1)}`);
  return { checks };
});
for (const c of out.checks) console.log(c.pass ? '  ok  ' : '  NG  ', c.name, '—', c.detail);
console.log(`RESULT: ${out.checks.every(c => c.pass) ? 'PASS' : 'FAIL'} (${out.checks.filter(c => c.pass).length}/${out.checks.length})`);
if (errors.length) console.log('errors:', errors);
await browser.close();
