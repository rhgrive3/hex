await import('./panels-compat-surface-base.mjs');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decorateFunctionAnalysisForUi,
  installFunctionAnalysisPresentation,
} from '../js/ui/function-analysis-presentation.js';
import { decompile } from '../js/decompile.js';
import { cfgGraph } from '../js/graphview.js';

console.log('Testing canonical analysis UI projection...');

const canonicalDecompiler = Object.freeze({
  semantic:true,
  signature:'int f(void)',
  pseudocode:'int f(void) { return 1; }',
  lines:Object.freeze([{ kind:'sig', indent:0, text:'int f(void)' }]),
  warnings:Object.freeze([]),
  evidence:Object.freeze([]),
});
const legacyV1 = {
  startAddress:0x1000n,
  instructions:[
    { id:0, row:10, op:'cmp', sub:'eq', origin:{ address:0x1000n } },
    { id:1, row:20, op:'ret', origin:{ address:0x1010n } },
    { id:2, row:30, op:'ret', origin:{ address:0x1020n } },
  ],
  blocks:[
    { index:0, semanticBlockId:'b0', startRow:10, endRow:10, insts:[{ row:10, op:'cmp', sub:'eq', origin:{ address:0x1000n } }], backEdges:[] },
    { index:1, semanticBlockId:'b1', startRow:20, endRow:20, insts:[{ row:20, op:'ret', origin:{ address:0x1010n } }] },
    { index:2, semanticBlockId:'b2', startRow:30, endRow:30, insts:[{ row:30, op:'ret', origin:{ address:0x1020n } }] },
  ],
  backEdges:[],
};
const canonicalCfg = Object.freeze({
  contractVersion:'2.0.0',
  functionId:'0x1000',
  entryBlockId:'b0',
  blocks:Object.freeze([
    Object.freeze({ id:'b0', predecessors:Object.freeze([]), successors:Object.freeze([
      Object.freeze({ to:'b1', kind:'conditional-true' }),
      Object.freeze({ to:'b2', kind:'conditional-false' }),
    ]) }),
    Object.freeze({ id:'b1', predecessors:Object.freeze(['b0']), successors:Object.freeze([]) }),
    Object.freeze({ id:'b2', predecessors:Object.freeze(['b0']), successors:Object.freeze([]) }),
  ]),
});
const canonical = Object.freeze({
  architectureId:'x86_64',
  abiId:'sysv-amd64',
  pipeline:Object.freeze({ legacyV1, cfg:canonicalCfg }),
  decompiler:canonicalDecompiler,
});

const projected = decorateFunctionAnalysisForUi(canonical);
assert.notEqual(projected, canonical, 'presentation decoration must not mutate the canonical Query result');
assert.equal(canonical.model, undefined, 'canonical Query result must remain model-free');
assert.equal(projected.model.__analysisPresentationOnly, true);
assert.equal(projected.presentationProjection.analysisAuthority, 'AnalysisQueryAPI');
assert.deepEqual(projected.model.basicBlocks.map((block) => block.rows), [[10], [20], [30]]);

const decompiled = decompile(projected.model);
assert.equal(decompiled.pseudocode, canonicalDecompiler.pseudocode,
  'canonical decompiler output must be reused instead of rerunning a legacy architecture decompiler');
assert.notEqual(decompiled, canonicalDecompiler, 'UI may clone presentation data but must not mutate the canonical snapshot');

const graph = cfgGraph(projected.model, {});
assert.equal(graph.nodes.length, 3);
assert.equal(graph.edges.length, 2);
assert.deepEqual(graph.edges.map((edge) => [edge.from, edge.to, edge.kind, edge.label]), [
  ['b0', 'b1', 'true', '成り立つ'],
  ['b0', 'b2', 'false', '成り立たない'],
]);

let calls = 0;
const app = {
  viewer:{ rowAddress(row) { return row === 7 ? 0x100bn : null; } },
  async analyzeFunctionAt() { calls++; return canonical; },
};
const firstRoute = installFunctionAnalysisPresentation(app);
const secondRoute = installFunctionAnalysisPresentation(app);
assert.equal(firstRoute, secondRoute, 'presentation route installation must be idempotent');
const routed = await app.analyzeFunctionAt(0x1000n);
assert.equal(calls, 1, 'one UI request must execute one canonical analysis request');
assert.equal(routed.model.__canonicalArchitectureId, 'x86_64');
assert.equal(app.viewer.rowAddress(7), 0x100bn,
  'the UI address source supports variable-width instruction geometry; it is not row*4');

const armLegacy = { model:{ instructions:[], basicBlocks:[] }, instructions:0 };
assert.equal(decorateFunctionAnalysisForUi(armLegacy), armLegacy,
  'existing ARM64 legacy presentation results must remain untouched');

const functionPanelSource = readFileSync(new URL('../js/ui/panels/function-analysis.js', import.meta.url), 'utf8');
assert.match(functionPanelSource, /api\.functions\(/,
  'the first-party function inventory must cross AnalysisQueryAPI');
assert.doesNotMatch(functionPanelSource, /ensureFunctions\s*\(/,
  'the function inventory UI must not call the discovery subsystem directly');
assert.doesNotMatch(functionPanelSource, /\.functionList\s*\(/,
  'the function inventory UI must not enumerate SymbolIndex directly');
assert.match(functionPanelSource, /functionViews\s*\(/,
  'function summary must derive alternate views from the canonical next-view registry');
assert.match(functionPanelSource, /openFunctionView\s*\(/,
  'function summary must route alternate views through the canonical function-view router');
assert.match(functionPanelSource, /['"]next-views['"]/,
  'function summary must retain the shared next-views navigation surface');

console.log('Canonical analysis UI projection tests PASS!');
