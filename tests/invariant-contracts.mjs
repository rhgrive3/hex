import assert from 'node:assert/strict';
import { architectureCapability } from '../js/architecture/index.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { createRuntimeEvidenceRecord, fuseStaticDynamic } from '../js/runtime-evidence/index.js';
import { expr, structuralKey } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

function sourceValues(source, key) {
  return new Set((source?.[key] || []).map((value) => String(value)));
}

// INV-004: a semantics-preserving rewrite must retain the complete origin path.
{
  const left = expr.variable('x', 32, false, { addresses:[0x1000n], rows:[0], ir:['ir:left'], evidence:['ev:left'] });
  const zero = expr.constant(0n, 32, false, { addresses:[0x1004n], rows:[1], ir:['ir:zero'], evidence:['ev:zero'] });
  const original = expr.binary('mul', left, zero, 32, false, { addresses:[0x1008n], rows:[2], ir:['ir:mul'], evidence:['ev:mul'] });
  const result = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs:1000, nodeBudget:128, maxIterations:8 }).rewrite(original);
  assert.equal(result.root.kind, 'const');
  assert.equal(result.root.value, 0n);
  assert.ok(result.proof.length > 0, 'rewrite must expose proof metadata');
  for (const [key, expected] of Object.entries({
    addresses:['4096','4100','4104'], rows:['0','1','2'], ir:['ir:left','ir:zero','ir:mul'], evidence:['ev:left','ev:zero','ev:mul'],
  })) {
    const actual = sourceValues(result.root.source, key);
    for (const value of expected) assert.ok(actual.has(value), `INV-004 lost ${key} origin ${value}`);
  }
}

// INV-007: runtime evidence may change a fused verdict, never the static object itself.
{
  const staticCandidate = Object.freeze({
    confidence:0.9, binaryHash:'bin-a', functionAddress:0x1000n, semanticTruth:'static-original',
  });
  const runtime = createRuntimeEvidenceRecord({
    id:'runtime-contradiction', backend:'test', binaryHash:'bin-a', sessionId:'session-a',
    experimentId:'exp-a', caseId:'case-a', function:0x1000n, verdict:'contradicted', confidence:0.95,
  });
  const fused = fuseStaticDynamic(staticCandidate, [runtime]);
  assert.strictEqual(fused.candidate, staticCandidate);
  assert.equal(staticCandidate.semanticTruth, 'static-original');
  assert.equal(staticCandidate.confidence, 0.9);
  assert.equal(fused.status, 'contradicted');
  assert.ok(fused.confidence < staticCandidate.confidence);
}

// INV-008: model-provided status/prose cannot mint verified evidence.
{
  const store = new EvidenceStore();
  const direct = store.add({
    id:'model-direct', sourceTool:'model', kind:'claim', status:'verified', functionAddress:'0x1000', summary:'model says verified',
  });
  assert.equal(direct.status, 'supported');

  const ingested = store.ingest('model-output', {
    result:{
      id:'model-row', kind:'claim', functionAddress:'0x1000', status:'verified', verified:true,
      evidence:['model-evidence-id'], verifiedEvidenceIds:['model-evidence-id'],
    },
  }, { verifier:false });
  assert.ok(ingested.length > 0);
  assert.ok(ingested.every((item) => item.status !== 'verified'), 'model-only ingest minted verified evidence');
}

// INV-010: decode capability alone must not become full semantic support.
{
  const x86 = architectureCapability(
    { format:'elf', arch:'x86_64', bits:64, endian:'little' },
    { x86_64:true, verified:true },
  );
  assert.equal(x86.canDisassemble, true);
  assert.equal(x86.canAnalyzeDataflow, false);
  assert.equal(x86.analysisLevel, 'unsupported');

  const arm64 = architectureCapability(
    { format:'macho', arch:'arm64', bits:64, endian:'little' },
    { arm64:true, verified:true },
  );
  assert.equal(arm64.canDisassemble, true);
  assert.equal(arm64.canAnalyzeDataflow, true);
  assert.equal(arm64.analysisLevel, 'full');
}

// INV-012: plugin work is bounded, cancellable, and binary reads have hard budgets.
{
  const plugins = new PlatformPluginRegistry({ timeoutMs:50 });
  plugins.registerAnalyzer('inv.timeout', { analyze: async () => new Promise(() => {}) });
  const timed = await plugins.invoke('analyzer', 'inv.timeout', 'analyze', {}, { timeoutMs:5 });
  assert.equal(timed.ok, false);
  assert.equal(timed.timeout, true);

  plugins.registerAnalyzer('inv.cancel', { analyze: async () => new Promise(() => {}) });
  const controller = new AbortController();
  controller.abort(new Error('cancelled-by-invariant-test'));
  const cancelled = await plugins.invoke('analyzer', 'inv.cancel', 'analyze', {}, { signal:controller.signal, timeoutMs:100 });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled-by-invariant-test|aborted/i);

  plugins.registerAnalyzer('inv.read-budget', {
    analyze: async ({ read }) => {
      await read(0n, 8);
      await read(8n, 8);
      return { unreachable:true };
    },
  });
  const budgeted = await plugins.invoke('analyzer', 'inv.read-budget', 'analyze', {
    read: async (_address, length) => new Uint8Array(length),
    pluginPolicy:{ binaryRead:true, maxReadBytes:8, maxTotalReadBytes:8 },
  });
  assert.equal(budgeted.ok, false);
  assert.match(budgeted.error, /total budget/i);
}

// INV-015: hitting a performance budget must keep the old semantics, not apply a partial rewrite.
{
  const left = expr.variable('x', 32, false, { addresses:[0x2000n] });
  const original = expr.binary('add', left, expr.constant(0n, 32, false), 32, false, { addresses:[0x2004n] });
  const result = new RewriteEngine(DEFAULT_RULES, { timeBudgetMs:0, nodeBudget:128, maxIterations:8 }).rewrite(original);
  assert.equal(result.stats.budgetExceeded, true);
  assert.equal(structuralKey(result.root), structuralKey(original), 'budget exhaustion changed semantics');
}

console.log('invariant-contracts: PASS');
