import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SHOTS = process.env.UI_SHOTS ? path.resolve(ROOT, process.env.UI_SHOTS) : null;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8',
};

const VIEWPORTS = [
  ['phone-small', 375, 667],
  ['phone-standard', 393, 852],
  ['phone-large', 430, 932],
  ['phone-landscape', 844, 390],
  ['tablet-small-portrait', 744, 1133],
  ['tablet-small-landscape', 1133, 744],
  ['tablet', 1024, 1366],
  ['desktop', 1440, 900],
];

async function loadPlaywright() {
  const unwrap = (m) => m?.chromium ? m : (m?.default?.chromium ? m.default : null);
  try { const got = unwrap(await import('playwright')); if (got) return got; } catch { /* try npx cache */ }
  const home = process.env.HOME || '';
  const cache = path.join(home, '.npm', '_npx');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const candidate = path.join(cache, dir, 'node_modules', 'playwright', 'index.js');
    if (!fs.existsSync(candidate)) continue;
    try { const got = unwrap(await import(pathToFileURL(candidate).href)); if (got) return got; } catch { /* continue */ }
  }
  return null;
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(name, ok, detail = '') {
  const pass = !!ok;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}

async function closeTransient(page) {
  for (let i = 0; i < 12; i++) {
    const active = page.locator('#overlays .sheet:not(.parked)').last();
    if (!(await active.count())) break;
    const done = active.locator('.sheet-done').last();
    if (await done.count()) await done.click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(40);
  }
}

async function noOverflow(page) {
  return page.evaluate(() => ({
    body: document.body.scrollWidth - document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
}

async function primaryTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('.ui-bottom-nav .ui-nav-item')].filter((node) => getComputedStyle(node).display !== 'none').map((node) => {
    const r = node.getBoundingClientRect();
    return { text: node.textContent.trim(), w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
}

async function shellGeometry(page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    const nodes = [...document.querySelectorAll('.ui-product-chrome, .ui-bottom-nav, .ui-route-host:not([hidden])')];
    return nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { cls: node.className, left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: vv?.width || innerWidth, vh: vv?.height || innerHeight };
    });
  });
}

async function openSample(page) {
  await page.evaluate(() => window.__app.openSample());
  await page.waitForFunction(() => !!window.__app.store.get('fileInfo'), null, { timeout: 20000 });
  await page.waitForTimeout(350);
  await closeTransient(page);
  await page.evaluate(async () => {
    const app = window.__app;
    if (app.symbolsReady) { try { await app.symbolsReady; } catch {} }
    await app.ensureFunctions(app.codeRegion());
  });
}

async function firstFunction(page) {
  return page.evaluate(() => {
    const app = window.__app;
    const region = app.codeRegion();
    const list = app.symbols?.functionList?.(region, 4) || [];
    return list.length ? list[0].addr.toString() : null;
  });
}

async function shot(page, browser, viewport, name) {
  if (!SHOTS) return;
  const dir = path.join(SHOTS, browser, viewport);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png'), fullPage: false });
}

async function checkViewport(browserType, browserName, viewportName, width, height, baseUrl, screenshots = false) {
  const browser = await browserType.launch({ args: browserName === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', hasTouch: width < 900, isMobile: width < 600 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__hexUi, null, { timeout: 10000 });
    await page.waitForTimeout(350);
    await closeTransient(page);

    check(`${browserName}/${viewportName}: investigate is default`, await page.locator('[data-screen="investigate"]').count() === 1);
    let overflow = await noOverflow(page);
    check(`${browserName}/${viewportName}: no body horizontal overflow`, overflow.body <= 1 && overflow.root <= 1, JSON.stringify(overflow));

    const targets = await primaryTargets(page);
    check(`${browserName}/${viewportName}: four persistent task destinations`, targets.length === 4, `count=${targets.length}`);
    check(`${browserName}/${viewportName}: primary touch targets >=44px`, targets.every((item) => item.w >= 44 && item.h >= 44), JSON.stringify(targets));
    check(`${browserName}/${viewportName}: primary navigation stays inside viewport`, targets.every((item) => item.left >= -1 && item.right <= width + 1 && item.top >= -1 && item.bottom <= height + 1));
    const geometry = await shellGeometry(page);
    check(`${browserName}/${viewportName}: product chrome stays in visual viewport`, geometry.every((item) => item.left >= -1 && item.right <= item.vw + 1 && item.top >= -1 && item.bottom <= item.vh + 2), JSON.stringify(geometry));
    if (screenshots) await shot(page, browserName, viewportName, 'landing-investigate');

    await openSample(page);
    const fn = await firstFunction(page);
    check(`${browserName}/${viewportName}: sample exposes a function`, !!fn);

    await page.evaluate(() => window.__hexUi.router.navigate('/explorer/functions'));
    await page.waitForTimeout(100);
    check(`${browserName}/${viewportName}: explorer route opens`, await page.locator('[data-screen="explorer"]').count() === 1);
    check(`${browserName}/${viewportName}: explorer is windowed`, await page.locator('.ui-virtual-list').count() <= 1 && await page.locator('.ui-virtual-row').count() < 80);
    overflow = await noOverflow(page);
    check(`${browserName}/${viewportName}: explorer no horizontal overflow`, overflow.body <= 1 && overflow.root <= 1);
    if (screenshots) await shot(page, browserName, viewportName, 'explorer');

    await page.evaluate(() => window.__hexUi.router.navigate('/code'));
    await page.waitForTimeout(100);
    check(`${browserName}/${viewportName}: code viewer route restores virtualized viewer`, await page.locator('#viewport').count() === 1 && await page.locator('#ui-route-host[hidden]').count() === 1);
    if (screenshots) await shot(page, browserName, viewportName, 'code-viewer');

    if (fn) {
      for (const tab of ['overview','pseudocode','flow','calls','evidence','runtime']) {
        await page.evaluate(({ fn, tab }) => window.__hexUi.router.navigate(`/function/${fn}/${tab}`), { fn, tab });
        await page.waitForTimeout(tab === 'calls' ? 500 : 250);
        check(`${browserName}/${viewportName}: function/${tab} opens`, await page.locator('[data-screen="function"]').count() === 1);
        overflow = await noOverflow(page);
        check(`${browserName}/${viewportName}: function/${tab} no body overflow`, overflow.body <= 1 && overflow.root <= 1, JSON.stringify(overflow));
        if (screenshots) await shot(page, browserName, viewportName, `function-${tab}`);
      }

      await page.evaluate(({ fn }) => window.__hexUi.router.navigate(`/function/${fn}/overview`), { fn });
      await page.evaluate(() => { document.querySelector('.ui-route-host').scrollTop = 120; });
      await page.evaluate(() => window.__hexUi.router.navigate('/explorer/functions'));
      await page.evaluate(() => history.back());
      await page.waitForTimeout(100);
      check(`${browserName}/${viewportName}: browser back restores function route`, await page.locator('[data-screen="function"]').count() === 1);
      const restoredScroll = await page.evaluate(() => document.querySelector('.ui-route-host').scrollTop);
      check(`${browserName}/${viewportName}: route scroll state restores`, restoredScroll >= 0);

      await page.evaluate(() => window.__hexUi.router.navigate('/code'));
      await page.evaluate(() => window.__app.onSelectRow(0));
      await page.waitForTimeout(100);
      if (screenshots) await shot(page, browserName, viewportName, 'instruction-detail');
      await closeTransient(page);
    }

    await page.evaluate(() => window.__hexUi.router.navigate('/results'));
    await page.waitForTimeout(80);
    if (screenshots) await shot(page, browserName, viewportName, 'results');
    await page.evaluate(() => window.__hexUi.router.navigate('/settings'));
    await page.waitForTimeout(80);
    if (screenshots) await shot(page, browserName, viewportName, 'settings');
    await page.evaluate(() => window.__hexUi.router.navigate('/help'));
    await page.waitForTimeout(80);
    if (screenshots) await shot(page, browserName, viewportName, 'help');

    if (width < 600) {
      await page.evaluate(() => window.__hexUi.router.navigate('/investigate'));
      const input = page.locator('.ui-command-input');
      await input.focus();
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--ui-keyboard-inset', '280px');
        document.documentElement.classList.add('ui-keyboard-open');
      });
      const visible = await input.evaluate((node) => {
        const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
      });
      check(`${browserName}/${viewportName}: focused goal input stays visible with keyboard inset`, visible);
      const navMoved = await page.locator('.ui-bottom-nav').evaluate((node) => getComputedStyle(node).pointerEvents === 'none');
      check(`${browserName}/${viewportName}: keyboard removes fixed nav from input hit area`, navMoved);
      await page.evaluate(() => { document.documentElement.classList.remove('ui-keyboard-open'); document.documentElement.style.setProperty('--ui-keyboard-inset', '0px'); });
    }

    check(`${browserName}/${viewportName}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    const message = 'Playwright is not installed; UI browser regression was not executed.';
    if (process.env.CI) { console.error(message); return 1; }
    console.log(message); return 0;
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  try {
    for (const [name, width, height] of VIEWPORTS) {
      await checkViewport(pw.chromium, 'chromium', name, width, height, url, !!SHOTS && ['phone-standard','tablet','desktop'].includes(name));
    }
    if (pw.webkit) {
      for (const [name, width, height] of VIEWPORTS.filter(([name]) => ['phone-standard','phone-landscape','tablet','desktop'].includes(name))) {
        await checkViewport(pw.webkit, 'webkit', name, width, height, url, !!SHOTS && name === 'phone-standard');
      }
    } else {
      check('WebKit engine is available', false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  if (failures) return 1;
  console.log('UI browser viewport matrix passed');
  return 0;
}

process.exitCode = await main();
