// 評価器共通の起動処理。three.js をローカルへルーティングし、index.html には
// «CONFIG / Rolling / App を window に露出する» 1 行だけの改変を加えて読み込む。
// 各評価器（eval / interfere / structure / supplytrace / croptrace / coiltrace / shots）が
// 同じ起動経路を使うことで、計測条件の食い違いを構造的に無くす。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const THREE_DIR = path.join(__dirname, 'node_modules/three');
export const DEFAULT_TARGET = path.join(__dirname, '..', 'index.html');
export const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export async function openApp(opts = {}) {
  const target = opts.target || DEFAULT_TARGET;
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: opts.viewport || { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(opts.timeout || 600000);
  const errors = [];
  page.on('pageerror', e => { errors.push('pageerror: ' + e.message); if (!opts.quiet) console.log('[ERR]', e.message); });
  page.on('console', m => {
    if (m.type() === 'error' && !/ERR_CONNECTION/.test(m.text())) { errors.push(m.text()); if (!opts.quiet) console.log('[CONSOLE]', m.text()); }
    else if (opts.echo && m.type() === 'log') console.log('[page]', m.text());
  });
  await page.route('**/__three__', r => r.fulfill({ contentType: 'application/javascript',
    body: fs.readFileSync(path.join(THREE_DIR, 'build/three.module.js'), 'utf8') }));
  await page.route('**/examples/jsm/**', r => {
    const rel = new URL(r.request().url()).pathname.split('/examples/jsm/')[1];
    const f = path.join(THREE_DIR, 'examples/jsm', rel);
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ contentType: 'application/javascript',
      body: fs.readFileSync(f, 'utf8').replace(/from ['"]three['"]/g, `from '/__three__'`) });
  });
  await page.route('**/font-awesome/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/index.html', r => {
    let h = fs.readFileSync(target, 'utf8');
    h = h.replace(/\bnew App\(\);/, 'window.__CFG = CONFIG; window.__ROLL = Rolling; window.__SCRAP = Scrap; window.__CRADLE = Cradle; window.__LAYOUT = Layout; window.__app = new App();');
    h = h.replace(/"three":\s*"[^"]+"/, '"three": "/__three__"');
    h = h.replace(/"three\/addons\/":\s*"[^"]+"/, '"three/addons/": "/x/examples/jsm/"');
    r.fulfill({ contentType: 'text/html', body: h });
  });
  await page.goto('http://localhost/index.html', { waitUntil: 'load' }).catch(() => {});
  await page.waitForFunction(() => !!window.__app, null, { timeout: 25000 });
  await page.evaluate(async () => { window.__T = await import('/__three__'); });
  await page.waitForTimeout(600);
  return { browser, page, errors };
}

/**
 * ページ側で使う共通ヘルパを注入する。
 *  __ff(pred, maxSteps): 物理を固定ステップで進め、pred() が真になったら止める（描画はしない）
 *  __cam(pos, tgt):      カメラを mm 座標で置き、1 フレーム描画する
 *  __startAuto(anim):    供給アニメーションの有無を選んで自動運転を開始する
 */
export async function installHelpers(page) {
  await page.evaluate(() => {
    const A = window.__app, P = A.physics, W = A.world;
    A._probed = true;
    window.requestAnimationFrame = () => 0;                 // アプリの rAF ループを止め、明示ステップにする
    window.__ff = (pred, maxSteps = 120 * 2000, every = 0) => {
      let n = 0;
      while (n++ < maxSteps) {
        P.step(1 / 120);
        if (every && n % every === 0) W.render(P, every / 120);
        if (pred(P, n)) return { n, t: n / 120, done: true };
      }
      return { n, t: n / 120, done: false };
    };
    window.__cam = (pos, tgt) => {
      const sc = window.__CFG.SCALE;
      W._tw = null;
      W.camera.position.set(pos[0] * sc, pos[1] * sc, pos[2] * sc);
      W.controls.target.set(tgt[0] * sc, tgt[1] * sc, tgt[2] * sc);
      W.controls.update();
      W.render(P, 1 / 60);
    };
    window.__startAuto = (anim = false) => {
      const c = document.getElementById('chk-supply-anim');
      if (c.checked !== anim) { c.checked = anim; c.dispatchEvent(new Event('change')); }
      document.getElementById('btn-reset').click();
      document.getElementById('btn-start').click();
    };
  });
}
