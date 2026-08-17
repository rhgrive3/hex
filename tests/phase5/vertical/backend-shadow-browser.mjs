import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/phase5/corpus/manifest.json'), 'utf8'));
const mime = { '.js':'text/javascript; charset=utf-8', '.wasm':'application/wasm', '.json':'application/json', '.elf':'application/octet-stream', '.exe':'application/octet-stream' };

async function playwright() {
  const unwrap = (module) => module?.chromium ? module : module?.default?.chromium ? module.default : null;
  try { const loaded = unwrap(await import('playwright')); if (loaded) return loaded; } catch { /* inspect npx cache */ }
  const cache = path.join(process.env.HOME || '', '.npm', '_npx');
  if (fs.existsSync(cache)) for (const directory of fs.readdirSync(cache)) {
    const candidate = path.join(cache, directory, 'node_modules/playwright/index.js');
    if (!fs.existsSync(candidate)) continue;
    try { const loaded = unwrap(await import(pathToFileURL(candidate).href)); if (loaded) return loaded; } catch { /* continue */ }
  }
  throw new Error('phase5-browser-playwright-required');
}

function serve() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/phase5-test') {
      response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>Phase 5 vertical test</title>');
      return;
    }
    const file = path.resolve(root, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, { 'content-type':mime[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const pw = await playwright();
const server = await serve();
const browser = await pw.chromium.launch({ args:['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/phase5-test`);
  const results = [];
  for (const fixture of manifest.foundationVerticalFixtures) {
    const result = await page.evaluate(async ({ fixture }) => {
      const { Backend } = await import('/js/backend.js');
      const response = await fetch(`/${fixture.path}`);
      const file = new File([await response.arrayBuffer()], fixture.path.split('/').at(-1));
      const backend = new Backend();
      try {
        const descriptor = await backend.open(file);
        const options = {
          address:BigInt(fixture.entryAddress),
          length:fixture.functionLength,
          abiId:fixture.abiId,
          platform:fixture.abiId === 'microsoft-x64' ? 'windows' : 'linux',
          name:'p5_vertical_seed',
        };
        const cold = await backend.analyzeSemanticFunction(options);
        const warm = await backend.analyzeSemanticFunction(options);
        return {
          format:descriptor.format,
          architecture:descriptor.capability?.architecture || descriptor.slices?.[0]?.capability?.architecture,
          route:cold.route,
          abiId:cold.abiId,
          instructions:cold.pipeline.machineEffects.length,
          exact:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'exact').length,
          exactWithIntrinsic:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'exact-with-intrinsic').length,
          partial:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'partial').length,
          unknown:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'unknown').length,
          provenanceLossCount:cold.pipeline.instrumentation.provenanceLossCount,
          sharedDecompiler:cold.decompiler.semantic,
          coldArtifactId:cold.artifactId,
          warmArtifactId:warm.artifactId,
          warmReused:warm.reused,
          runtime:backend.analysisRouteInfo().artifactRuntime,
        };
      } finally { backend.dispose(); }
    }, { fixture });
    results.push(result);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.deepEqual(results.map((result) => result.abiId), ['sysv-amd64','microsoft-x64']);
  assert.ok(results.every((result) => result.architecture === 'x86_64'));
  assert.ok(results.every((result) => result.route === 'phase5-shadow-v2'));
  assert.ok(results.every((result) => result.partial === 0 && result.unknown === 0));
  assert.ok(results.every((result) => result.provenanceLossCount === 0 && result.sharedDecompiler === true));
  assert.ok(results.every((result) => result.warmReused && result.coldArtifactId === result.warmArtifactId));
  assert.notEqual(results[0].coldArtifactId, results[1].coldArtifactId);
  console.log('PHASE5_REAL_BROWSER_VERTICAL ' + JSON.stringify(results));
  console.log('phase5 real browser production-worker vertical route passed');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
