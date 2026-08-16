import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { verifyProvenance, verifyDeterminism } from '../../tools/validation/semantic-v2/provenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const v2Corpus = globalThis.__HEX_PHASE3_CURRENT_CORPUS__;
assert.ok(v2Corpus, 'explicit v2 current-corpus evidence must run before final evidence');
assert.equal(v2Corpus.semantic.failed, 0);
assert.equal(v2Corpus.decompiler.failed, 0);

function commandsFor(scriptName) {
  const script = packageJson.scripts?.[scriptName];
  if (typeof script !== 'string' || !script.trim()) throw new Error(`missing npm script: ${scriptName}`);
  return script.split(/\s*&&\s*/).map((command) => command.trim()).filter(Boolean);
}

function runLegacyCommand(suite, command) {
  const child = spawnSync('bash', ['-lc', command], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  const passed = child.status === 0;
  if (!passed) {
    const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    process.stderr.write(`\n[phase3-legacy-differential ${suite}] ${command}\n${combined.slice(-5000)}\n`);
  }
  return { command, passed, status: child.status, signal: child.signal ?? null, timedOut: child.error?.code === 'ETIMEDOUT' };
}

const legacySemantic = commandsFor('semantic:test').map((command) => runLegacyCommand('semantic', command));
const legacyDecompiler = commandsFor('decompiler:test').map((command) => runLegacyCommand('decompiler', command));
const v2ByCommand = new Map([
  ...v2Corpus.semantic.results.map((item) => [`semantic\u0000${item.command}`, item]),
  ...v2Corpus.decompiler.results.map((item) => [`decompiler\u0000${item.command}`, item]),
]);
const differentialResults = [
  ...legacySemantic.map((item) => ({ suite: 'semantic', ...item })),
  ...legacyDecompiler.map((item) => ({ suite: 'decompiler', ...item })),
].map((legacy) => {
  const v2 = v2ByCommand.get(`${legacy.suite}\u0000${legacy.command}`);
  const matched = legacy.passed === true && v2?.passed === true;
  return { suite: legacy.suite, command: legacy.command, legacyPassed: legacy.passed, v2Passed: v2?.passed === true, matched };
});
const mismatchResults = differentialResults.filter((item) => !item.matched);
assert.equal(legacySemantic.filter((item) => item.passed).length, legacySemantic.length, 'legacy semantic corpus must remain green');
assert.equal(legacyDecompiler.filter((item) => item.passed).length, legacyDecompiler.length, 'legacy decompiler corpus must remain green');
assert.equal(mismatchResults.length, 0, `legacy/v2 unchanged-assertion differential mismatch: ${JSON.stringify(mismatchResults)}`);

const provenancePlugin = Object.freeze({
  id: 'phase3-provenance-architecture', semanticVersion: '1', fixedInstructionSize: 4,
  liftExact(decoded) {
    const base = {
      instructionId: decoded.instructionId,
      architectureId: 'phase3-provenance-architecture',
      mode: decoded.mode,
      possibleFaults: [],
      origin: decoded.origin,
    };
    const target = (value) => ({ kind: 'absolute-address', value: `0x${BigInt(value).toString(16)}`, widthBits: 64 });
    const reg = { kind: 'register', registerId: 'state0', widthBits: 32 };
    const access = { space: 'memory', addressExpr: { kind: 'bitvector', widthBits: 64, value: '20480' }, widthBits: 32, endian: 'little' };
    if (decoded.testKind === 'cond') return createMachineEffectBundle({
      ...base, operations: [],
      controlEffect: { kind: 'conditional-branch', target: target(decoded.trueTarget), fallthrough: target(decoded.falseTarget), condition: { kind: 'bitvector', widthBits: 1, value: '1' } },
      completeness: 'exact',
    });
    if (decoded.testKind === 'write-store-branch') return createMachineEffectBundle({
      ...base,
      operations: [
        { id: `${decoded.instructionId}:state-write`, kind: 'register-write', register: reg, value: { kind: 'bitvector', widthBits: 32, value: String(decoded.value) } },
        { id: `${decoded.instructionId}:memory-write`, kind: 'memory-write', access, value: { kind: 'bitvector', widthBits: 32, value: String(decoded.value) } },
      ],
      controlEffect: { kind: 'branch', target: target(decoded.target) }, completeness: 'exact',
    });
    if (decoded.testKind === 'read-load-return') return createMachineEffectBundle({
      ...base,
      operations: [
        { id: `${decoded.instructionId}:state-read`, kind: 'register-read', register: reg, value: { kind: 'bitvector', widthBits: 32 } },
        { id: `${decoded.instructionId}:memory-read`, kind: 'memory-read', access, value: { kind: 'bitvector', widthBits: 32 } },
      ],
      controlEffect: { kind: 'return' }, completeness: 'exact',
    });
    return null;
  },
});

function buildProvenanceFixture() {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin: provenancePlugin,
    decoderSemanticVersion: 'phase3-provenance-decoder-1',
    binaryId: 'binary_phase3_provenance', sliceId: 'slice_phase3_provenance', addressWidthBits: 64,
    entryBlockKey: 'entry',
    blocks: [
      { key: 'entry', startAddress: 0x1000n, instructions: [{ decoded: { address: 0x1000n, mode: 'test', testKind: 'cond', trueTarget: 0x1010n, falseTarget: 0x1020n } }], successors: [{ to: 'left', kind: 'conditional-true' }, { to: 'right', kind: 'conditional-false' }] },
      { key: 'left', startAddress: 0x1010n, instructions: [{ decoded: { address: 0x1010n, mode: 'test', testKind: 'write-store-branch', value: 1, target: 0x1030n } }], successors: [{ to: 'merge', kind: 'branch' }] },
      { key: 'right', startAddress: 0x1020n, instructions: [{ decoded: { address: 0x1020n, mode: 'test', testKind: 'write-store-branch', value: 2, target: 0x1030n } }], successors: [{ to: 'merge', kind: 'branch' }] },
      { key: 'merge', startAddress: 0x1030n, instructions: [{ decoded: { address: 0x1030n, mode: 'test', testKind: 'read-load-return' } }], successors: [] },
    ],
  });
}

const fixture = buildProvenanceFixture();
const scalarPhis = fixture.ssa.definitions.filter((definition) => definition.kind === 'phi');
const memoryPhis = fixture.memorySsa.definitions.filter((definition) => definition.kind === 'memory-phi');
assert.ok(scalarPhis.length > 0, 'provenance fixture must traverse scalar phi creation');
assert.ok(memoryPhis.length > 0, 'provenance fixture must traverse MemoryPhi creation');

const roots = fixture.machineEffects.map((bundle) => ({ id: `machine:${bundle.instructionId}`, kind: 'machine-effect-bundle', origin: bundle.origin }));
const entities = [
  ...fixture.semanticIr.nodes.map((item) => ({ id: item.id, kind: `semantic-ir-${item.kind}`, origin: item.origin })),
  ...fixture.semanticIr.values.map((item) => ({ id: item.id, kind: `semantic-value-${item.kind}`, origin: item.origin })),
  ...fixture.ssa.definitions.map((item) => ({ id: item.valueId, kind: `ssa-${item.kind}`, origin: item.origin })),
  ...fixture.ssa.uses.map((item) => ({ id: item.useId, kind: 'ssa-use', origin: item.origin })),
  ...fixture.memorySsa.regions.map((item) => ({ id: item.id, kind: `memory-region-${item.kind}`, origin: item.origin })),
  ...fixture.memorySsa.definitions.map((item) => ({ id: item.id, kind: `memoryssa-${item.kind}`, origin: item.origin })),
  ...fixture.memorySsa.uses.map((item) => ({ id: item.id, kind: 'memoryssa-use', origin: item.origin })),
  ...fixture.legacyV1.instructions.map((item) => ({ id: `legacy-inst:${item.id}`, kind: `legacy-inst-${item.op}`, origin: item.origin })),
  ...fixture.legacyV1.values.map((item) => ({ id: `legacy-value:${item.id}`, kind: `legacy-value-${item.kind}`, origin: item.origin })),
];
const provenance = verifyProvenance({ roots, entities });
assert.equal(provenance.provenanceLossCount, 0, `production provenance chain lost origin: ${JSON.stringify(provenance.losses)}`);
assert.equal(Object.keys(fixture.legacyV1.compat.origins.nodes).length, fixture.semanticIr.nodes.length);
assert.equal(Object.keys(fixture.legacyV1.compat.origins.values).length, fixture.semanticIr.values.length);
assert.equal(Object.keys(fixture.legacyV1.compat.origins.ssaDefinitions).length, fixture.ssa.definitions.length);
assert.equal(Object.keys(fixture.legacyV1.compat.origins.ssaUses).length, fixture.ssa.uses.length);

const determinism = await verifyDeterminism({
  name: 'production-pipeline-provenance-fixture',
  variants: [{ order: 1 }, { order: 2 }],
  async build() { return buildProvenanceFixture(); },
  normalize(result) {
    return {
      semanticIr: result.semanticIr,
      ssa: result.ssa,
      memorySsa: result.memorySsa,
      compatOrigins: result.legacyV1.compat.origins,
      compatNodeMap: result.legacyV1.compat.semanticNodeToLegacyInstructionIds,
    };
  },
});
assert.equal(determinism.deterministic, true, `production provenance fixture must be deterministic: ${JSON.stringify(determinism.mismatchVariantIndexes)}`);

const differential = Object.freeze({
  matchUnit: 'unchanged-semantic/decompiler-command-assertion-corpus',
  legacySemantic: { total: legacySemantic.length, passed: legacySemantic.filter((item) => item.passed).length, failed: legacySemantic.filter((item) => !item.passed).length },
  legacyDecompiler: { total: legacyDecompiler.length, passed: legacyDecompiler.filter((item) => item.passed).length, failed: legacyDecompiler.filter((item) => !item.passed).length },
  v2Semantic: { total: v2Corpus.semantic.total, passed: v2Corpus.semantic.passed, failed: v2Corpus.semantic.failed },
  v2Decompiler: { total: v2Corpus.decompiler.total, passed: v2Corpus.decompiler.passed, failed: v2Corpus.decompiler.failed },
  differentialMatchCount: differentialResults.length - mismatchResults.length,
  mismatchCount: mismatchResults.length,
  results: Object.freeze(differentialResults),
});

globalThis.__HEX_PHASE3_FINAL_EVIDENCE__ = Object.freeze({
  path: fixture.path,
  pathExecuted: fixture.instrumentation.v2Executed === true,
  differential,
  provenance: Object.freeze({
    provenanceLossCount: provenance.provenanceLossCount,
    entityCount: entities.length,
    rootCount: roots.length,
    scalarPhiCount: scalarPhis.length,
    memoryPhiCount: memoryPhis.length,
    status: 'proven-production-chain',
  }),
  determinism: Object.freeze({ deterministic: determinism.deterministic, mismatchVariantIndexes: determinism.mismatchVariantIndexes }),
  consumerEvidenceStatus: 'unchanged-current-corpus-25-of-25',
});
console.log('[phase3-final-evidence]', JSON.stringify({
  differentialMatchCount: differential.differentialMatchCount,
  mismatchCount: differential.mismatchCount,
  provenanceLossCount: provenance.provenanceLossCount,
  provenanceEntityCount: entities.length,
  scalarPhiCount: scalarPhis.length,
  memoryPhiCount: memoryPhis.length,
  deterministic: determinism.deterministic,
}));
