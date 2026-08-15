import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as irFacade from '../js/ir.js';
import * as architecture from '../js/architecture/index.js';
import * as pluginApi from '../js/platform/plugin-api.js';
import * as projectApi from '../js/project/index.js';
import { createRuntimeEvidenceRecord, fuseStaticDynamic } from '../js/runtime-evidence/index.js';
import { ProposalStore } from '../js/ai/proposals.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireExports(module, label, names) {
  for (const name of names) assert.ok(name in module, `${label} compatibility export missing: ${name}`);
}

function source(relative) { return fs.readFileSync(path.join(root, relative), 'utf8'); }
function posix(value) { return value.split(path.sep).join('/'); }
function walk(relative) {
  const base = path.join(root, relative);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    else if (/\.m?js$/.test(entry.name)) out.push(posix(child));
  }
  return out;
}
function importSpecs(text) {
  const specs = [];
  const staticImport = /\b(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"]([^'"]+)['"]/gs;
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticImport, dynamicImport]) {
    let match;
    while ((match = re.exec(text))) specs.push(match[1]);
  }
  return specs;
}
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return spec;
  return posix(path.normalize(path.join(path.dirname(fromFile), spec)));
}
function assertNoImport(files, predicate, message) {
  for (const file of files) {
    for (const spec of importSpecs(source(file))) {
      const resolved = resolveImport(file, spec);
      assert.equal(predicate({ file, spec, resolved }), false, `${message}: ${file} -> ${spec}`);
    }
  }
}

// Public compatibility facades: additions are allowed, removals/renames are not.
requireExports(irFacade, 'js/ir.js', [
  'OP', 'MK', 'buildIR', 'irFor', 'readModifyWrite', 'hasUnknownStoreBarrier',
  'mustAlias', 'mayAliasProvenance', 'valueRange', 'valueInfo', 'rangeOnBranch',
  'branchConstraints', 'originOf',
]);
requireExports(architecture, 'js/architecture/index.js', [
  'ArchitectureAdapter', 'UnsupportedArchitectureError', 'unsupportedArchitectureResult',
  'registerArchitectureAdapter', 'architectureAdapter', 'architectureCapability',
]);
requireExports(projectApi, 'js/project/index.js', [
  'HEX_PROJECT_VERSION', 'HEX_PROJECT_MIME', 'MAX_PROJECT_BYTES', 'ProjectFormatError',
  'createHexProject', 'serializeHexProject', 'parseHexProject', 'tryParseHexProject',
  'exportHexProject', 'importHexProject', 'validateHexProject',
]);
requireExports(pluginApi, 'js/platform/plugin-api.js', [
  'PlatformPluginRegistry', 'platformPlugins', 'registerFormat', 'registerArchitecture',
  'registerAnalyzer', 'registerKnowledgeProvider', 'registerSignatureProvider',
  'registerRecognitionProvider', 'registerViewContribution', 'registerGoalProvider',
]);

// Unknown stores remain conservative: unknown is never MustAlias=false + MayAlias=false.
{
  const unknown = { kind: irFacade.MK.UNKNOWN, size: 8 };
  const global = { kind: irFacade.MK.GLOBAL, address: 0x1000n, size: 8 };
  assert.equal(irFacade.mustAlias(unknown, global), false);
  assert.equal(irFacade.mayAliasProvenance(unknown, global), true);

  const barrier = { op: irFacade.OP.STORE, loc: unknown, block: 0, row: 1 };
  const mini = { instructions: [barrier], blocks: [{ succ: [] }] };
  assert.equal(irFacade.hasUnknownStoreBarrier(mini, { block: 0, row: 0 }, { block: 0, row: 2 }), true);
}

// .hexproj v1 remains a portable exchange format. Cache data stays a reference.
{
  assert.equal(projectApi.HEX_PROJECT_VERSION, 1, '.hexproj v1 import/export compatibility is required');
  const project = projectApi.createHexProject({
    binaryHash: 'guardrail:binary',
    userNames: [{ addr: 0x1000n, name: 'guarded' }],
    cacheReferences: ['analysis:summary'],
    navigation: { currentFunction: 0x1000n },
  });
  const roundtrip = projectApi.parseHexProject(projectApi.serializeHexProject(project));
  assert.equal(roundtrip.version, 1);
  assert.equal(roundtrip.binary.embedded, false);
  assert.deepEqual(roundtrip.analysis.cacheReferences, ['analysis:summary']);
  assert.equal(roundtrip.user.names[0].addr, 0x1000n);
}

// Plugin API v1 registration surface stays compatible and additive.
{
  const registry = new pluginApi.PlatformPluginRegistry({ timeoutMs: 100 });
  for (const method of [
    'registerFormat', 'registerArchitecture', 'registerAnalyzer', 'registerKnowledgeProvider',
    'registerSignatureProvider', 'registerRecognitionProvider', 'registerViewContribution', 'registerGoalProvider',
  ]) assert.equal(typeof registry[method], 'function', `plugin v1 method missing: ${method}`);
}

// Runtime evidence may refine a static candidate, but must not mutate static state.
{
  const staticCandidate = Object.freeze({ confidence: 0.5, binaryHash: 'guardrail:binary', functionAddress: 0x1000n });
  const evidence = createRuntimeEvidenceRecord({
    id: 'runtime-guardrail', backend: 'test', binaryHash: 'guardrail:binary', sessionId: 'session',
    experimentId: 'experiment', caseId: 'case', function: 0x1000n,
    provenanceGroup: 'runtime:session:experiment:case', confidence: 0.8, verdict: 'supported',
  });
  const fused = fuseStaticDynamic(staticCandidate, [evidence]);
  assert.notEqual(fused, staticCandidate);
  assert.equal(staticCandidate.confidence, 0.5);
  assert.equal(Object.hasOwn(staticCandidate, 'status'), false);
}

// AI mutation remains proposal/approval gated. Deterministic evidence is mandatory.
{
  const evidenceStore = { has: (id) => id === 'e1' };
  const proposals = new ProposalStore({ evidenceStore, binding: () => ({ binaryId: 'guardrail:binary' }) });
  assert.throws(() => proposals.create({ kind: 'rename', before: { name: 'a' }, after: { name: 'b' } }), /deterministic evidence/i);
  const proposal = proposals.create({
    kind: 'rename', target: { address: '0x1000' }, before: { name: 'a' }, after: { name: 'b' }, evidenceIds: ['e1'],
  });
  let applied = 0;
  await assert.rejects(
    () => proposals.apply(proposal.id, { currentState: { name: 'a' }, apply: async () => { applied++; } }),
    /approval/i,
  );
  assert.equal(applied, 0, 'AI must not directly execute mutation without approval');
  const { approvalToken } = proposals.approve(proposal.id);
  await proposals.apply(proposal.id, { approvalToken, currentState: { name: 'a' }, apply: async () => { applied++; } });
  assert.equal(applied, 1);
}

// Dependency-boundary checks intentionally target stable architectural seams.
// Legacy ir-core.js is excluded: section 35 explicitly identifies it as temporary mixed debt.
{
  const genericModules = [
    'js/ir.js', 'js/dataflow.js', 'js/dataflow-ir.js', 'js/dataflow-ir-compare.js', 'js/dataflow-semantic.js',
  ].filter((file) => fs.existsSync(path.join(root, file)));
  const architectureSpecific = /(?:^|\/)architecture\/(?:arm64|arm64e|x86_64|riscv64)(?:\/|\.|$)|(?:^|\/)targets\/architecture\//i;
  assertNoImport(genericModules, ({ resolved }) => architectureSpecific.test(resolved), 'generic semantic module imports architecture-specific implementation');

  const projectFiles = walk('js/project');
  assertNoImport(projectFiles, ({ resolved }) => (
    resolved.startsWith('js/cache/') || resolved.startsWith('js/core/artifacts/') || /(?:artifact[-_]?store|analysis[-_]?cache)/i.test(resolved)
  ), 'project exchange layer owns derived analysis cache');

  const uiFiles = [...walk('js/ui'), 'js/ui.js', 'js/ui-root.js', 'js/panels.js', 'js/app.js']
    .filter((file, index, list) => list.indexOf(file) === index && fs.existsSync(path.join(root, file)));
  assertNoImport(uiFiles, ({ resolved }) => (
    resolved === 'js/ir-core.js' || resolved === 'js/decompiler/pipeline-core.js'
  ), 'UI imports private semantic internals instead of a facade');

  const aiFiles = walk('js/ai');
  assertNoImport(aiFiles, ({ resolved }) => resolved === 'js/patch.js' || resolved.startsWith('js/patch/'), 'AI imports a direct binary-mutation implementation');

  const decompilerCore = source('js/decompiler/pipeline-core.js');
  assert.doesNotMatch(decompilerCore, /\.(?:mnemonic|operands)\b/, 'semantic decompiler must not reinterpret instruction text');
  assertNoImport(['js/decompiler/pipeline-core.js'], ({ resolved }) => (
    resolved.startsWith('js/architecture/') || resolved === 'js/disasm.js' || resolved === 'js/backend.js'
  ), 'semantic decompiler imports decoder/backend implementation');
}

console.log('migration guardrails: PASS');
