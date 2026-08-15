/* Focused browser test for the untrusted-code boundary (no binary scan needed). */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pw = await loadPlaywright();
if (!pw) {
  const msg = 'Playwright unavailable; sandbox browser test skipped';
  if (process.env.CI) { console.error(msg + ' (CI requires this test)'); process.exit(1); }
  console.log(msg); process.exit(0);
}
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
      source: `let network = false; try { await fetch('data:text/plain,leak'); network = true; } catch {}
print('sandbox', typeof app, typeof parent, typeof window, typeof document, typeof fetch, network, await hex.ping(41));`,
      api: { ping: (n) => n + 1 }, out: (...args) => lines.push(args), timeout: 5000,
    });
    const pluginSource = `try { parent.__sandboxLeak = 2; } catch {}
hex.plugin({ name: 'safe-plugin', async run(hex, print) { print('plugin', await hex.ping(1), typeof app); } });`;
    const discovered = await runInSandbox({ source: pluginSource, mode: 'discover', api: {}, out: () => {}, timeout: 5000 });
    const pluginLines = [];
    const plugin = await runInSandbox({ source: pluginSource, mode: 'plugin', index: 0,
      api: { ping: (n) => n + 1 }, out: (...args) => pluginLines.push(args), timeout: 5000 });

    const emuLines = [];
    const emulator = await runInSandbox({
      source: `const e = await hex.emulator(0x1000n, [3n]);
print('emu', await e.get('x0'), typeof e.step, e.id);
await e.destroy();`,
      api: {
        emulatorCreate: () => ({ id: 'emu-test' }),
        emulatorGetRegister: (_id, reg) => reg === 'x0' ? 3n : 0n,
        emulatorDestroy: () => true,
      },
      out: (...args) => emuLines.push(args), timeout: 5000,
    });

    const begin = performance.now();
    const runaway = await runInSandbox({ source: 'while (true) {}', api: {}, out: () => {}, timeout: 150 });
    const runawayMs = performance.now() - begin;
    const normalLines=[];
    const normalOutput=await runInSandbox({source:"for(let i=0;i<8;i++) print('ok',i)",api:{},out:(...args)=>normalLines.push(args),timeout:5000});
    const giantOutput=await runInSandbox({source:'print(new Uint8Array(300000))',api:{},out:()=>{},timeout:5000});
    const floodOutput=await runInSandbox({source:"for(let i=0;i<500;i++) print('x')",api:{},out:()=>{},timeout:5000});
    const directOutput=await runInSandbox({source:'postMessage(new Uint8Array(300000)); await new Promise(r=>setTimeout(r,1000))',api:{},out:()=>{},timeout:5000});
    return { value, lines, leak: window.__sandboxLeak, discovered, plugin, pluginLines,
      emulator, emuLines, runaway, runawayMs, normalOutput, normalLines, giantOutput, floodOutput, directOutput };
  });
  const line = result.lines[0] || [];
  const unexpected = errors.filter((e) => !/connect-src 'none'|Refused to connect|violates.*Content Security Policy/i.test(e));
  const pluginLine = result.pluginLines[0] || [];
  const emuLine = result.emuLines[0] || [];
  if (!result.value.ok || !result.discovered.ok || result.discovered.value[0]?.name !== 'safe-plugin' ||
      !result.plugin.ok || pluginLine.join(' ') !== 'plugin 2 undefined' || result.leak !== 0 ||
      line.join(' ') !== 'sandbox undefined undefined undefined undefined undefined false 42' ||
      !result.emulator.ok || emuLine.join(' ') !== 'emu 3 function emu-test' ||
      !result.runaway.error || !/時間制限/.test(result.runaway.error) || result.runawayMs > 2000 ||
      !result.normalOutput.ok || result.normalLines.length !== 8 ||
      !/安全上限/.test(result.giantOutput.error || '') || !/安全上限/.test(result.floodOutput.error || '') || !/安全上限/.test(result.directOutput.error || '') ||
      unexpected.length) {
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
