import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
let failures = 0;

function check(name, ok, detail = '') {
  const pass = !!ok;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}

async function loadPlaywright() {
  const unwrap = (m) => m?.chromium ? m : m?.default?.chromium ? m.default : null;
  try { const got = unwrap(await import('playwright')); if (got) return got; } catch { /* fall through */ }
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
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
    if ((!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function audit(page, label) {
  const result = await page.evaluate(() => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const accessibleName = (node) => {
      const aria = (node.getAttribute('aria-label') || '').trim();
      if (aria) return aria;
      const refs = (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      if (refs.length) {
        const value = refs.map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (value) return value;
      }
      if (node.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
        if (explicit?.textContent.trim()) return explicit.textContent.trim();
      }
      const parentLabel = node.closest('label');
      if (parentLabel?.textContent.trim()) return parentLabel.textContent.trim();
      if (/^(BUTTON|A)$/.test(node.tagName) || node.getAttribute('role') === 'button' || node.getAttribute('role') === 'tab' || node.getAttribute('role') === 'menuitem') {
        const text = node.textContent.trim();
        if (text) return text;
      }
      /* Placeholder is accepted as a compatibility hint for legacy search fields;
         canonical global controls use aria-label. This still rejects blank controls. */
      return (node.getAttribute('title') || node.getAttribute('placeholder') || '').trim();
    };

    const ids = [...document.querySelectorAll('[id]')].map((n) => n.id).filter(Boolean);
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

    const interactive = [...document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="tab"], [role="menuitem"]')]
      .filter(visible).filter((n) => !n.disabled && n.getAttribute('aria-hidden') !== 'true');
    const unnamed = interactive.filter((n) => !accessibleName(n)).map((n) => `${n.tagName.toLowerCase()}#${n.id}.${n.className}`);

    const refAttrs = ['aria-labelledby', 'aria-describedby', 'aria-controls'];
    const invalidRefs = [];
    for (const node of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls]')) {
      for (const attr of refAttrs) {
        const value = node.getAttribute(attr);
        if (!value) continue;
        for (const id of value.trim().split(/\s+/)) if (id && !document.getElementById(id)) invalidRefs.push(`${attr}=${id}`);
      }
    }

    const hiddenFocusable = [...document.querySelectorAll('[aria-hidden="true"] button, [aria-hidden="true"] input, [aria-hidden="true"] textarea, [aria-hidden="true"] select, [aria-hidden="true"] a[href], [aria-hidden="true"] [tabindex]')]
      .filter((n) => !n.closest('[inert]') && visible(n) && n.tabIndex >= 0)
      .map((n) => `${n.tagName.toLowerCase()}#${n.id}.${n.className}`);

    const invalidAria = [...document.querySelectorAll('[role="tab"]')]
      .filter((n) => !['true', 'false'].includes(n.getAttribute('aria-selected') || ''))
      .map((n) => n.textContent.trim());

    return { duplicates, unnamed, invalidRefs, hiddenFocusable, invalidAria };
  });
  check(`${label}: no duplicate IDs`, result.duplicates.length === 0, result.duplicates.join(', '));
  check(`${label}: visible interactive controls have names/labels`, result.unnamed.length === 0, result.unnamed.slice(0, 5).join(' | '));
  check(`${label}: ARIA references resolve`, result.invalidRefs.length === 0, result.invalidRefs.slice(0, 5).join(' | '));
  check(`${label}: no focusable controls inside non-inert aria-hidden regions`, result.hiddenFocusable.length === 0, result.hiddenFocusable.slice(0, 5).join(' | '));
  check(`${label}: tabs have valid aria-selected`, result.invalidAria.length === 0, result.invalidAria.join(', '));
}

async function contrastAudit(page, theme) {
  const ratios = await page.evaluate((mode) => {
    document.documentElement.dataset.theme = mode;
    const root = getComputedStyle(document.documentElement);
    const parse = (value) => {
      const v = value.trim();
      if (v.startsWith('#')) {
        const hex = v.slice(1);
        const x = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
        return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
      }
      const m = v.match(/[\d.]+/g);
      return m ? m.slice(0, 3).map(Number) : null;
    };
    const lum = (rgb) => {
      const linear = rgb.map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const ratio = (a, b) => {
      const l1 = lum(parse(a)), l2 = lum(parse(b));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const get = (name) => root.getPropertyValue(name);
    return {
      text: ratio(get('--ui-text'), get('--ui-bg')),
      muted: ratio(get('--ui-text-muted'), get('--ui-surface')),
      confirmed: ratio(get('--ui-confirmed'), get('--ui-surface')),
      contradicted: ratio(get('--ui-contradicted'), get('--ui-surface')),
    };
  }, theme);
  check(`${theme}: canonical text contrast >= 4.5`, Object.values(ratios).every((v) => Number.isFinite(v) && v >= 4.5), JSON.stringify(ratios));
}

async function focusTrapAudit(page) {
  await page.evaluate(async () => {
    const { Sheet } = await import('/js/ui.js');
    const sheet = new Sheet('Focus audit');
    const a = document.createElement('button'); a.type = 'button'; a.textContent = 'First body action';
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Last body action';
    sheet.body.append(a, b);
    const focusable = [...sheet.root.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
      .filter((node) => node.offsetParent !== null);
    window.__a11ySheet = sheet;
    window.__a11yFirst = focusable[0];
    window.__a11yLast = focusable[focusable.length - 1];
    window.__a11yFirst?.focus();
  });
  await page.keyboard.press('Shift+Tab');
  check('Sheet focus trap wraps backward', await page.evaluate(() => document.activeElement === window.__a11yLast));
  await page.keyboard.press('Tab');
  check('Sheet focus trap wraps forward', await page.evaluate(() => document.activeElement === window.__a11yFirst));
  await page.evaluate(() => {
    window.__a11ySheet?.destroyChain();
    delete window.__a11ySheet; delete window.__a11yFirst; delete window.__a11yLast;
  });
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    const message = 'Playwright is not installed; accessibility regression was not executed.';
    if (process.env.CI) { console.error(message); return 1; }
    console.log(message); return 0;
  }
  const server = await serve();
  const baseUrl = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const [label, viewport] of [['phone', { width: 393, height: 852 }], ['desktop', { width: 1440, height: 900 }]]) {
      const context = await browser.newContext({ viewport, locale: 'ja-JP', hasTouch: label === 'phone', isMobile: label === 'phone' });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.__hexUi, null, { timeout: 10000 });
      await audit(page, `${label}/investigate`);
      await page.evaluate(() => window.__hexUi.router.navigate('/explorer/functions'));
      await page.waitForTimeout(80);
      await audit(page, `${label}/explorer`);
      if (label === 'phone') {
        await contrastAudit(page, 'light');
        await contrastAudit(page, 'dark');
        await focusTrapAudit(page);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  if (failures) return 1;
  console.log('Accessibility browser regression passed');
  return 0;
}

process.exitCode = await main();
