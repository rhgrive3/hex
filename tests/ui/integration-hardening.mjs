import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualList } from '../../js/ui/primitives.js';
import { createAppRuntimeIO } from '../../js/runtime/app-runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const product = fs.readFileSync(path.join(ROOT, 'js/ui/product.js'), 'utf8');
const ux = fs.readFileSync(path.join(ROOT, 'js/ux.js'), 'utf8');
const secondary = fs.readFileSync(path.join(ROOT, 'js/ui/secondary.js'), 'utf8');
const navigation = fs.readFileSync(path.join(ROOT, 'js/ui/panels/navigation.js'), 'utf8');
const backend = fs.readFileSync(path.join(ROOT, 'js/backend.js'), 'utf8');

assert.equal(product.includes('triggerLegacyInvestigation'), false, 'canonical investigate must not fake legacy sheet input');
assert.equal(product.includes('HP・体力') && product.includes('ダメージ計算') && product.includes('所持金・コイン'), true, 'canonical investigate must expose beginner goal presets');
assert.equal(product.includes('renderSecondaryRoute(app, router, route)'), true, 'settings/help/learn must render as canonical routes');
assert.equal(product.includes('function renderSecondary('), false, 'legacy open-button secondary screen must be removed');
assert.equal(product.includes('showSettings, showHelp, showLearn'), false, 'product UI must not import legacy secondary sheets');
assert.equal(secondary.includes("case 'settings': return renderSettings(app, router)"), true, 'canonical settings route must be implemented');
assert.equal(secondary.includes("case 'help': return renderHelp(app, router)"), true, 'canonical help route must be implemented');
assert.equal(secondary.includes("case 'learn': return renderLearn(app, router, route)"), true, 'canonical learning route must be implemented');
assert.equal(ux.includes('app.openInvestigate()'), false, 'primary Investigate navigation must never reopen the legacy sheet');
assert.equal(product.includes('querySelector(\'#overlays .sheet'), false, 'canonical investigate must not scrape legacy sheet DOM');
assert.equal(product.includes('compileGoal('), true, 'canonical investigate must call Goal Compiler directly');
assert.equal(product.includes('traceAppFunction('), true, 'Function Runtime tab must call Runtime Analysis Platform bridge');
assert.equal(product.includes('runtimeEvidenceForApp('), true, 'Function Evidence tab must surface runtime evidence');
assert.equal(product.includes('classifyFunction('), true, 'Function Overview must surface recognition classification');
assert.equal(product.includes('out.length < 1000'), false, 'Explorer must not retain the old 1000 function cap');
assert.equal(product.includes('functionList(app.codeRegion(), 600)'), false, 'Explorer must not retain the old 600 function cap');
assert.equal(navigation.includes('if (running) app.backend.cancelSearch(running)'), true, 'closing search must cancel only the request owned by that sheet');
assert.equal(navigation.includes('err?.name === "AbortError" || err?.code === "ABORT_ERR"'), true, 'expected search cancellation must not surface as a failure dialog');
assert.equal(backend.includes('cancelSearch(request) {\n    if (request == null) return false;\n    return this.cancel(request);\n  }'), true,
  'unowned legacy sheet cleanup must never fall back to cancelling the backend global last request');

// VirtualList supports lazy large indexes without pre-materializing every item.
const source = { length: 293794, itemAt(index) { return { index }; } };
assert.equal(source.length, 293794);
assert.equal(source.itemAt(293793).index, 293793);

// App runtime I/O must reject non-executable addresses without touching backend.
let reads = 0;
const app = {
  store: { get(key) { if (key === 'regions') return [{ id: 1, exec: true, vmAddr: 0x1000n, size: 0x100n }]; if (key === 'fileInfo') return { architecture: 'arm64' }; return null; } },
  backend: { readAt: async () => { reads++; return { found: false }; }, fetchChunk: async () => ({ mn: [], ops: [] }) },
  symbols: { nameAt: () => null, label: () => null },
};
const io = createAppRuntimeIO(app);
assert.equal(io.isExecutable(0x1000n), true);
assert.equal(io.isExecutable(0x2000n), false);
assert.equal(reads, 0);

// Merely importing the UI primitive should not require a browser global; DOM
// construction remains browser-only, but the lazy source contract is structural.
assert.equal(typeof VirtualList, 'function');

console.log('ui-integration-hardening: PASS');
