// 板面冷却（入側・出側の冷却器）の «着水蒸気» を検査する。
// 400 ℃ の板に水が触れれば必ず沸騰するので、ヘッダの下に板が居る間は
// «噴射と同じ着水点» から蒸気が立たなければならない。
// 立てる場所・条件・量が噴射側と食い違っていないかを、発生点そのもので見る。
import { openApp, installHelpers } from './harness.mjs';

const { browser, page } = await openApp({ viewport: { width: 900, height: 520 }, quiet: true });
await installHelpers(page);

const out = await page.evaluate(async () => {
  const A = window.__app, W = A.world, P = A.physics, K = window.__CFG, L = window.__LAYOUT;
  const sv = W.sprayView;

  // 発生点を «どの放出口から出たか» の札付きで記録する
  const rec = [];
  let cur = null;
  const oEmit = sv._emit.bind(sv), oSpawn = sv.steam.spawn.bind(sv.steam);
  sv._emit = (key, rate, dt, max, fn) => oEmit(key, rate, dt, max, (r) => { cur = key; fn(r); });
  sv.steam.spawn = (x, y, z, ...a) => { rec.push({ k: cur, x, y, z }); return oSpawn(x, y, z, ...a); };

  /** 板がヘッダの下を通っている状態まで運転し、そこで n 秒ぶん噴射を回す */
  const run = async (opts) => {
    rec.length = 0;
    Object.assign(P.env, opts.env || {});
    if (opts.cool) { A.bus.emit('CMD_SET_STRIP_COOL', opts.cool); }
    window.__startAuto(true);
    let g = 0;
    // 板がいずれかの冷却ゾーンの真下に入り、かつ走っている瞬間まで進める
    const under = () => L.coolZones().some(([a, b]) => P.slab.onLine && P.slab.xMax > a && P.slab.xMin < b)
                        && Math.abs(P.mill.currentSpeed) > 3;
    while (!under() && g++ < 200000) P.step(1 / 120);
    const hit = under();
    rec.length = 0;
    const s = P.slab, m = P.mill;
    const state = { topY: s.inBite ? m.gap : s.thickness, passLine: m.passLine, temp: s.temperature,
                    zones: L.coolZones().filter(([a, b]) => s.xMax > a && s.xMin < b),
                    land: L.nozzleAim(s.width, s.inBite ? m.gap : s.thickness).land, width: s.width };
    for (let i = 0; i < 240 && under(); i++) { sv.update(1 / 60, P); P.step(1 / 120); }
    return { hit, state, wet: rec.filter(r => r.k === 'wetSteam'), bite: rec.filter(r => r.k === 'steam') };
  };

  const modes = Object.keys(K.MATERIAL.STRIP_COOL.MODES || {});
  const base = await run({ env: { steam: true } });
  P.reset(); const noSteam = await run({ env: { steam: false } });
  return { base, noSteam, modes, mode: K.MATERIAL.STRIP_COOL.mode };
});
await browser.close();

const checks = [];
const ok = (n, c, g) => checks.push({ name: n, pass: !!c, got: g });
const b = out.base, st = b.state;

ok('板が冷却ヘッダの下を通る状態まで到達する', b.hit, b.hit);
ok('着水蒸気が発生している', b.wet.length > 0, b.wet.length);
ok('ロールバイトの蒸気も従来どおり出ている', b.bite.length > 0, b.bite.length);

if (b.wet.length) {
  const zs = b.wet.map(r => Math.abs(r.z));
  const inBand = zs.filter(z => Math.abs(z - st.land) <= 320).length / zs.length;
  ok(`着水点（|z| ≒ ${st.land.toFixed(0)} mm）の帯に 80 % 以上が入る`, inBand >= 0.8, (inBand * 100).toFixed(0) + ' %');
  ok('すべて板幅の内側から立つ', zs.every(z => z <= st.width / 2), Math.max(...zs).toFixed(0));
  const yMin = st.passLine + st.topY;
  ok('すべて板の上面より上から立つ', b.wet.every(r => r.y >= yMin), (Math.min(...b.wet.map(r => r.y)) - yMin).toFixed(0));
  ok('すべてヘッダと板が重なった X の範囲から立つ',
     b.wet.every(r => st.zones.some(([a, c]) => r.x >= a - 1 && r.x <= c + 1)), st.zones.length);
  const L = b.wet.filter(r => r.z > 0).length, R = b.wet.length - L;
  ok(`左右がほぼ均等（${L} / ${R}）`, Math.abs(L - R) <= b.wet.length * 0.25, `${L}/${R}`);
}
ok('「水蒸気」を切ると着水蒸気も止まる', out.noSteam.wet.length === 0, out.noSteam.wet.length);

console.log(JSON.stringify({ landing_mm: +st.land.toFixed(1), plate_top: st.topY, temp: +st.temp.toFixed(0),
                             zones: st.zones.length, wet: b.wet.length, bite: b.bite.length }, null, 2));
for (const c of checks) console.log(`${c.pass ? 'OK  ' : 'NG  '} ${c.name}  → ${c.got}`);
const bad = checks.filter(c => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} ${bad.length ? 'FAIL' : 'PASS'}`);
process.exit(bad.length ? 1 : 0);
