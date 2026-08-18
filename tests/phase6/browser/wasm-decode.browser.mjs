import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Real-browser proof for the Phase 6 decoder.
 *
 * Hex is browser/iPad-first, so "the deployed WASM decodes RISC-V" is only
 * believable once it has been observed in a browser, streaming the same
 * capstone.wasm over HTTP the way the product does. This runs the production
 * classic worker script itself inside a real Worker.
 *
 * It is a `.browser.mjs`, not a `.test.mjs`, so the canonical Phase 6 runner
 * does not silently require a browser toolchain; `npm run phase6:browser`
 * runs it and fails closed when Playwright is unavailable.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mime = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' };

async function playwright() {
  const unwrap = (module) => (module?.chromium ? module : module?.default?.chromium ? module.default : null);
  try { const loaded = unwrap(await import('playwright')); if (loaded) return loaded; } catch { /* inspect npx cache */ }
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
  if (fs.existsSync(cache)) {
    for (const directory of fs.readdirSync(cache)) {
      const candidate = path.join(cache, directory, 'node_modules/playwright/index.js');
      if (!fs.existsSync(candidate)) continue;
      try { const loaded = unwrap(await import(pathToFileURL(candidate).href)); if (loaded) return loaded; } catch { /* continue */ }
    }
  }
  throw new Error('phase6-browser-playwright-required');
}

function serve() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/phase6-test') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>Phase 6 RISC-V decode</title>');
      return;
    }
    const file = path.resolve(root, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const { chromium } = await playwright();
const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${origin}/phase6-test`);

  const result = await page.evaluate(async () => {
    // The production classic worker script, loaded exactly as the product loads it.
    const worker = new Worker('/js/platform/capstone-disasm-worker.js');
    const ask = (message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 60_000);
      worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
      worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage(message);
    });
    // c.li a0,7 | addi a1,a1,1 | c.add a0,a1 | ld a2,0(a0) | ret
    const riscv = await ask({
      id: 1, architecture: 'riscv64', address: 0x1000n,
      bytes: new Uint8Array([0x1d, 0x45, 0x93, 0x85, 0x15, 0x00, 0x2e, 0x95, 0x03, 0x36, 0x05, 0x00, 0x67, 0x80, 0x00, 0x00]),
    });
    const arm64 = await ask({ id: 2, architecture: 'arm64', address: 0x1000n, bytes: new Uint8Array([0x00, 0x00, 0x80, 0xd2]) });
    const x86 = await ask({ id: 3, architecture: 'x86_64', address: 0x2000n, bytes: new Uint8Array([0x48, 0x89, 0xf8, 0xc3]) });
    worker.terminate();
    return {
      riscv: {
        ok: riscv.ok, error: riscv.error ?? null, bytesConsumed: riscv.bytesConsumed,
        sizes: (riscv.instructions ?? []).map((instruction) => Number(instruction.size)),
        addresses: (riscv.instructions ?? []).map((instruction) => Number(instruction.address)),
        architectures: [...new Set((riscv.instructions ?? []).map((instruction) => instruction.architecture))],
        hasStructuredDetail: (riscv.instructions ?? []).every((instruction) => Array.isArray(instruction.capstoneOperands)),
      },
      arm64: { ok: arm64.ok, count: (arm64.instructions ?? []).length },
      x86: { ok: x86.ok, count: (x86.instructions ?? []).length },
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    };
  });

  assert.deepEqual(consoleErrors, [], 'the page must not raise errors');
  assert.equal(result.riscv.ok, true, `RISC-V decode failed in the browser: ${result.riscv.error}`);
  assert.equal(result.riscv.bytesConsumed, 16);
  assert.deepEqual(result.riscv.sizes, [2, 4, 2, 4, 4], 'mixed compressed/uncompressed widths must decode in the browser');
  assert.deepEqual(result.riscv.addresses, [0x1000, 0x1002, 0x1006, 0x1008, 0x100c]);
  assert.deepEqual(result.riscv.architectures, ['riscv64']);
  assert.equal(result.riscv.hasStructuredDetail, true, 'structured detail must cross the browser worker boundary');
  assert.equal(result.arm64.ok, true, 'ARM64 must still decode in the browser');
  assert.equal(result.arm64.count, 1);
  assert.equal(result.x86.ok, true, 'x86-64 must still decode in the browser');
  assert.equal(result.x86.count, 2);
  // Phase 6 must not have introduced a cross-origin-isolation requirement.
  assert.equal(result.crossOriginIsolated, false, 'RISC-V decode must not require cross-origin isolation');

  console.log(`PHASE6_BROWSER=${JSON.stringify(result)}`);
  console.log('phase6 browser RISC-V decode: PASS');
} finally {
  await browser.close();
  server.close();
}
