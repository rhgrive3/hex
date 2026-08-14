/*
 * Shared browser harness for the assistant UI tests.
 *
 * Same shape as tests/ui/browser.mjs: a static file server plus Playwright
 * from the npx cache, and a clean skip (not a failure) when Playwright is not
 * installed locally. CI sets CI=1 and gets a hard failure instead.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8',
};

export async function loadPlaywright() {
  const unwrap = (m) => (m?.chromium ? m : (m?.default?.chromium ? m.default : null));
  try { const got = unwrap(await import('playwright')); if (got) return got; } catch { /* try npx cache */ }
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const candidate = path.join(cache, dir, 'node_modules', 'playwright', 'index.js');
    if (!fs.existsSync(candidate)) continue;
    try { const got = unwrap(await import(pathToFileURL(candidate).href)); if (got) return got; } catch { /* continue */ }
  }
  return null;
}

export function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export function reporter() {
  const state = { failures: 0 };
  return {
    state,
    check(name, ok, detail = '') {
      const pass = !!ok;
      console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
      if (!pass) state.failures++;
    },
  };
}

export async function closeSheets(page) {
  for (let i = 0; i < 10; i++) {
    const open = await page.evaluate(() => document.querySelectorAll('#overlays .sheet, #overlays .menu, #overlays .dialog').length);
    if (!open) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  }
}

/** A booted page with the product UI and the assistant installed. */
export async function openApp(browser, { width, height, sample = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, locale: 'ja-JP', hasTouch: width < 900, isMobile: width < 600,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource/i.test(message.text())) return;
    errors.push(message.text());
  });
  await page.goto(page.__baseUrl || context.__baseUrl || global.__hexBaseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__hexUi && !!window.__hexAi, null, { timeout: 20000 });
  await page.waitForTimeout(250);
  await closeSheets(page);
  if (sample) {
    await page.evaluate(() => window.__app.openSample());
    await page.waitForFunction(() => !!window.__app.store.get('fileInfo'), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    await closeSheets(page);
    await page.evaluate(async () => {
      const app = window.__app;
      if (app.symbolsReady) { try { await app.symbolsReady; } catch { /* names are optional */ } }
      await app.ensureFunctions(app.codeRegion());
    });
  }
  return { context, page, errors };
}

/** Replace the session engine with a deterministic stub. */
export async function stubEngine(page, response, options = {}) {
  await page.evaluate(({ response: value, options: opts }) => {
    window.__hexStub = { calls: [] };
    window.__hexAi.session.engine = {
      async run(input) {
        window.__hexStub.calls.push({ question: input.question, mode: input.mode, style: input.style, scope: input.scope });
        for (const event of opts.activity || []) input.onActivity(event);
        if (opts.hang) return new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('cancelled')));
          window.__hexStub.resolve = () => resolve(value);
        });
        if (opts.fail) throw new Error(String(opts.fail));
        return { ...value, mode: input.mode, style: input.style };
      },
    };
  }, { response, options });
}

export async function ask(page, question) {
  await page.fill('.ai-input', question);
  await page.evaluate(() => document.querySelector('.ai-composer').requestSubmit());
  await page.waitForTimeout(220);
}

export async function run(main) {
  const pw = await loadPlaywright();
  if (!pw) {
    const message = 'Playwright is not installed; assistant UI regression was not executed.';
    if (process.env.CI) { console.error(message); process.exit(1); }
    console.log(message);
    return;
  }
  const server = await serve();
  global.__hexBaseUrl = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const failures = await main({ browser, baseUrl: global.__hexBaseUrl });
    if (failures) process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}
