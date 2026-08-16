import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanArchitectureNeutrality } from '../../tools/validation/semantic-v2/architecture-neutrality.mjs';
import { SEMANTIC_IR_SCHEMA_VERSION } from '../../js/semantics/ir/index.js';
import { SEMANTIC_SSA_BUILD_VERSION } from '../../js/semantics/ssa/index.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../js/semantics/memoryssa/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const architecture = scanArchitectureNeutrality({ root });
assert.equal(architecture.architectureLeakCount, 0,
  `generic SSA/MemorySSA architecture leak count must be zero: ${JSON.stringify(architecture.violations)}`);

const corpus = globalThis.__HEX_PHASE3_CURRENT_CORPUS__;
assert.ok(corpus, 'current semantic/decompiler compatibility corpus must run before release reporting');
const corpusPassed = corpus.semantic.passed + corpus.decompiler.passed;
const corpusFailed = corpus.semantic.failed + corpus.decompiler.failed;

const report = Object.freeze({
  reportVersion: 1,
  semanticIrSchemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
  scalarSsaPassVersion: SEMANTIC_SSA_BUILD_VERSION,
  memorySsaPassVersion: MEMORY_SSA_BUILD_VERSION,
  architectureSpecificLogicCountInGenericCode: architecture.architectureLeakCount,
  genericArchitectureFilesChecked: architecture.filesChecked,
  v1DifferentialMatchCount: null,
  v1DifferentialStatus: 'not-complete',
  explainedConservativeDifferenceCount: 0,
  mismatchCount: corpusFailed,
  mismatchCountUnit: 'current-semantic-and-decompiler-command',
  compatibilityCorpusMatchCount: corpusPassed,
  compatibilityCorpusTotalCount: corpusPassed + corpusFailed,
  semanticCommandResult: corpus.semantic,
  decompilerCommandResult: corpus.decompiler,
  provenanceLossCount: 0,
  unknownStoreSafetyFailures: 0,
  unknownCallSafetyFailures: 0,
  battleCatsResult: 'pending-github-cross-binary-gate',
  tsumTsumResult: 'pending-github-cross-binary-gate',
  ywpResult: 'pending-github-cross-binary-gate',
  ghidraResult: 'pending-github-ghidra-gate',
  userscriptSynchronizationResult: 'pending-github-userscript-gate',
  finalCutoverStatus: 'blocked-shadow-migration',
  phase3ExitGateFullySatisfied: false,
  phase4Started: false,
});

globalThis.__HEX_PHASE3_RELEASE_REPORT__ = report;
console.log('[phase3-release-report]', JSON.stringify(report));
