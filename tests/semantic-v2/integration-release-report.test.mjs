import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanArchitectureNeutrality } from '../../tools/validation/semantic-v2/architecture-neutrality.mjs';
import { SEMANTIC_IR_SCHEMA_VERSION } from '../../js/semantics/ir/index.js';
import { SEMANTIC_SSA_BUILD_VERSION } from '../../js/semantics/ssa/index.js';
import { MEMORY_SSA_BUILD_VERSION } from '../../js/semantics/memoryssa/index.js';
import { getSemanticMigrationMode } from '../../js/ir.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const architecture = scanArchitectureNeutrality({ root });
assert.equal(architecture.architectureLeakCount, 0,
  `generic SSA/MemorySSA architecture leak count must be zero: ${JSON.stringify(architecture.violations)}`);

const corpus = globalThis.__HEX_PHASE3_CURRENT_CORPUS__;
const evidence = globalThis.__HEX_PHASE3_FINAL_EVIDENCE__;
const memorySafety = globalThis.__HEX_PHASE3_MEMORY_SAFETY__;
assert.ok(corpus, 'current semantic/decompiler compatibility corpus must run before release reporting');
assert.ok(evidence, 'final Phase 3 differential/provenance evidence must run before release reporting');
assert.ok(memorySafety, 'MemorySSA safety evidence must run before release reporting');
const corpusPassed = corpus.semantic.passed + corpus.decompiler.passed;
const corpusFailed = corpus.semantic.failed + corpus.decompiler.failed;
const localProofSatisfied = corpusFailed === 0
  && evidence.differential.mismatchCount === 0
  && evidence.differential.differentialMatchCount === corpusPassed
  && evidence.provenance.provenanceLossCount === 0
  && evidence.determinism.deterministic === true
  && evidence.pathExecuted === true
  && architecture.architectureLeakCount === 0
  && memorySafety.unknownStoreSafetyFailures === 0
  && memorySafety.unknownCallSafetyFailures === 0;
assert.equal(localProofSatisfied, true, 'local Phase 3 semantic exit proof must be complete');

const externalEvidencePath = path.join(root, 'tools/validation/semantic-v2/phase3-external-evidence.json');
let externalEvidence = null;
if (fs.existsSync(externalEvidencePath)) externalEvidence = JSON.parse(fs.readFileSync(externalEvidencePath, 'utf8'));
const requiredExternalKeys = ['crossBinaryAccuracy','ghidraDifferential','userscriptHost','semanticIrV2','invariantGates','migrationGuardrails','machineEffects','phase2Integration','runtimeDebugger','irDataflow'];
const externalPassed = externalEvidence?.status === 'pass'
  && requiredExternalKeys.every((key) => externalEvidence?.gates?.[key]?.result === 'PASS');
const cutoverApplied = getSemanticMigrationMode() === 'semantic-v2-compat';
const phase3ExitGateFullySatisfied = localProofSatisfied && externalPassed && cutoverApplied;

const report = Object.freeze({
  reportVersion: 2,
  semanticIrSchemaVersion: SEMANTIC_IR_SCHEMA_VERSION,
  scalarSsaPassVersion: SEMANTIC_SSA_BUILD_VERSION,
  memorySsaPassVersion: MEMORY_SSA_BUILD_VERSION,
  architectureSpecificLogicCountInGenericCode: architecture.architectureLeakCount,
  genericArchitectureFilesChecked: architecture.filesChecked,
  v1DifferentialMatchCount: evidence.differential.differentialMatchCount,
  v1DifferentialStatus: 'complete-current-unchanged-assertion-corpus',
  v1DifferentialMatchUnit: evidence.differential.matchUnit,
  explainedConservativeDifferenceCount: 0,
  mismatchCount: evidence.differential.mismatchCount,
  mismatchCountUnit: evidence.differential.matchUnit,
  compatibilityCorpusMatchCount: corpusPassed,
  compatibilityCorpusTotalCount: corpusPassed + corpusFailed,
  semanticCommandResult: { total: corpus.semantic.total, passed: corpus.semantic.passed, failed: corpus.semantic.failed },
  decompilerCommandResult: { total: corpus.decompiler.total, passed: corpus.decompiler.passed, failed: corpus.decompiler.failed },
  provenanceLossCount: evidence.provenance.provenanceLossCount,
  provenanceStatus: evidence.provenance.status,
  provenanceEntityCount: evidence.provenance.entityCount,
  scalarPhiProvenanceCases: evidence.provenance.scalarPhiCount,
  memoryPhiProvenanceCases: evidence.provenance.memoryPhiCount,
  deterministicProductionChain: evidence.determinism.deterministic,
  unknownStoreSafetyFailures: memorySafety.unknownStoreSafetyFailures,
  unknownCallSafetyFailures: memorySafety.unknownCallSafetyFailures,
  localSemanticExitProofSatisfied: localProofSatisfied,
  externalGateEvidenceStatus: externalPassed ? 'pass' : 'pending',
  externalValidatedHeadSha: externalEvidence?.validatedHeadSha ?? null,
  defaultSemanticMigrationMode: getSemanticMigrationMode(),
  cutoverApplied,
  battleCatsResult: externalEvidence?.realBinaries?.battleCats ?? 'pending-github-cross-binary-gate',
  tsumTsumResult: externalEvidence?.realBinaries?.tsumTsum ?? 'pending-github-cross-binary-gate',
  ywpResult: externalEvidence?.realBinaries?.ywp ?? 'pending-github-cross-binary-gate',
  ghidraResult: externalEvidence?.gates?.ghidraDifferential?.result ?? 'pending-github-ghidra-gate',
  userscriptSynchronizationResult: externalEvidence?.gates?.userscriptHost?.result ?? 'pending-github-userscript-gate',
  finalCutoverStatus: phase3ExitGateFullySatisfied ? 'cutover-complete' : (localProofSatisfied ? 'cutover-eligible-pending-external-gates-or-default-switch' : 'blocked'),
  phase3ExitGateFullySatisfied,
  phase4Started: false,
});

globalThis.__HEX_PHASE3_RELEASE_REPORT__ = report;
console.log('[phase3-release-report]', JSON.stringify(report));
