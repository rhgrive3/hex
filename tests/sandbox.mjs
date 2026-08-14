/* Focused browser test for the untrusted-code boundary (no binary scan needed). */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pw = await loadPlaywright();
if (!pw) { console.log('Playwright unavailable; sandbox browser test skipped'); process.exit(0); }
const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    fs.createReadStream(file).pipe(res);
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  const result = await page.evaluate(async () => {
    const { runInSandbox } = await import('/js/sandbox.js');
    const lines = [];
    window.__sandboxLeak = 0;
    const value = await runInSandbox({
      source: `try { parent.__sandboxLeak = 1; } catch {}
let network = false; try { await fetch('data:text/plain,leak'); network = true; } catch {}
print('sandbox', typeof app, parent === window, network, await hex.ping(41));`,
      api: { ping: (n) => n + 1 }, out: (...args) => lines.push(args), timeout: 5000,
    });
    const pluginSource = `try { parent.__sandboxLeak = 2; } catch {}
hex.plugin({ name: 'safe-plugin', async run(hex, print) { print('plugin', await hex.ping(1), typeof app); } });`;
    const discovered = await runInSandbox({ source: pluginSource, mode: 'discover', api: {}, out: () => {}, timeout: 5000 });
    const pluginLines = [];
    const plugin = await runInSandbox({ source: pluginSource, mode: 'plugin', index: 0,
      api: { ping: (n) => n + 1 }, out: (...args) => pluginLines.push(args), timeout: 5000 });
    return { value, lines, leak: window.__sandboxLeak, discovered, plugin, pluginLines };
  });
  const line = result.lines[0] || [];
  const unexpected = errors.filter((e) => !/connect-src 'none'|Refused to connect|violates.*Content Security Policy/i.test(e));
  const blocked = errors.some((e) => /connect-src 'none'|Refused to connect/i.test(e));
  const pluginLine = result.pluginLines[0] || [];
  if (!result.value.ok || !result.discovered.ok || result.discovered.value[0]?.name !== 'safe-plugin' ||
      !result.plugin.ok || pluginLine.join(' ') !== 'plugin 2 undefined' || result.leak !== 0 ||
      line.join(' ') !== 'sandbox undefined false false 42' || unexpected.length || !blocked) {
    console.error(JSON.stringify({ result, errors, unexpected }, null, 2));
    process.exitCode = 1;
  } else console.log('sandbox browser test: ok');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function loadPlaywright() {
  const unwrap = (m) => m && (m.chromium ? m : m.default && m.default.chromium ? m.default : null);
  try { const p = unwrap(await import('playwright')); if (p) return p; } catch { /* cache fallback */ }
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache)) {
    const file = path.join(cache, dir, 'node_modules', 'playwright', 'index.js');
    if (!fs.existsSync(file)) continue;
    try { const p = unwrap(await import(pathToFileURL(file).href)); if (p) return p; } catch { /* next */ }
  }
  return null;
}
