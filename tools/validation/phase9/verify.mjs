/**
 * Permanent independent verifier for Phase 9 — Solver-backed Verification.
 *
 * This verifier measures the live checkout. It never turns a profile row into
 * a pass by assertion: the phase tests, the production backend, and the
 * critical trust-boundary probes all have to succeed before READY is possible.
 * Only the two canonical files owned by this verifier are excluded from the
 * source-dirt check; adjacent reports and all source changes remain blocking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import { bvSort, BV_COMPARE_OP } from '../../../js/symbolic/expr/kinds.js';
import { createBool, createBv, createCompare, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/evaluate.js';
import { translateSemanticIR } from '../../../js/symbolic/translate/semantic-ir.js';
import { TRANSLATION_STATUS } from '../../../js/symbolic/translate/support-matrix.js';
import { OP, MK, VK } from '../../../js/ir-base.js';
import { ExhaustiveBvBackend } from '../../../js/symbolic/solver/exhaustive-backend.js';
import { PROOF_AUTHORITY, isExactProofBackend } from '../../../js/symbolic/solver/backend.js';
import { SOLVER_STATUS } from '../../../js/symbolic/solver/result.js';
import { defaultSolverRegistry } from '../../../js/symbolic/solver/registry.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';
import { verifyConditionalEdgeFeasibility } from '../../../js/symbolic/verify/edge-feasibility.js';
import { CLAIM_KIND, VERIFICATION_QUERY_KIND, VERDICT, createVerificationQuery } from '../../../js/symbolic/verify/query.js';
import { runPhase9Tests, discoverPhase9Tests } from '../../../tests/phase9/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = path.join(ROOT, 'tools/validation/phase9/profile.json');
const SCHEMA_PATH = path.join(ROOT, 'tools/validation/phase9/release-evidence.schema.json');
const PROFILE = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const REPORT_RELATIVE_PATH = 'reports/phase9/phase9-release-evidence.json';
const CHECKPOINT_RELATIVE_PATH = 'reports/phase9/checkpoints.json';
const VERIFIER_OWNED_PATHS = Object.freeze(new Set([REPORT_RELATIVE_PATH, CHECKPOINT_RELATIVE_PATH]));

export const VERIFIER_ID = 'phase9.verifier';
export const VERIFIER_VERSION = '2.0.0';
export const SCHEMA_VERSION = 'phase9-release-evidence/v2';

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export function isVerifierOwnedPath(file) {
  return VERIFIER_OWNED_PATHS.has(String(file).replaceAll('\\', '/'));
}

export function filterDirtyFiles(statusText) {
  return String(statusText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .filter((file) => file && !isVerifierOwnedPath(file));
}

export function getProductIdentity() {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']) ?? '';
  const dirtyFiles = filterDirtyFiles(status);
  return Object.freeze({
    commitSha: git(['rev-parse', 'HEAD']) || '0'.repeat(40),
    treeSha: git(['rev-parse', 'HEAD^{tree}']) || '0'.repeat(40),
    clean: dirtyFiles.length === 0,
    dirtyFiles,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
  });
}

function gate(id, description, ok, details = {}) {
  return Object.freeze({
    id,
    description,
    status: ok ? 'PASSED' : 'FAILED',
    ok: Boolean(ok),
    ...details,
  });
}

function query(assertion, constraints = []) {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity: 'phase9-release-gate',
    constraints,
    assertion,
  });
}

async function runLiveBackendGate() {
  const backend = defaultSolverRegistry.getDefaultBackend();
  if (!backend || !isExactProofBackend(backend) || backend.constructor.name === 'FakeSolverBackend') {
    return { ok: false, reason: 'production-default-is-not-an-exact-backend', backend: null };
  }

  const x = createFreshSymbol(bvSort(3), 'release_x');
  const satQuery = query(createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 5n)));
  const satResult = await backend.createSession().check(satQuery);
  const satModelValid = satResult.status === SOLVER_STATUS.SAT && validateSatModel(satQuery, satResult.model).valid;

  const unsatQuery = query(null, [
    createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 1n)),
    createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 2n)),
  ]);
  const unsatResult = await backend.createSession().check(unsatQuery);
  const exact = backend.proofAuthority === PROOF_AUTHORITY.EXACT && backend.capabilities().exactProofs === true;
  return {
    ok: exact && satModelValid && unsatResult.status === SOLVER_STATUS.UNSAT,
    backend: {
      id: backend.id,
      version: backend.version,
      proofAuthority: backend.proofAuthority,
      capabilityFingerprint: backend.capabilityFingerprint(),
      capabilities: backend.capabilities(),
    },
    checks: {
      satStatus: satResult.status,
      satModelValid,
      unsatStatus: unsatResult.status,
      exact,
    },
    reason: exact && satModelValid && unsatResult.status === SOLVER_STATUS.UNSAT
      ? null
      : 'live-production-backend-contract-failed',
  };
}

async function runLiveImplementationGates(backendGate) {
  const arithmetic = createFreshSymbol(bvSort(4), 'gate_x');
  const arithmeticExpr = createCompare(BV_COMPARE_OP.EQ, arithmetic, createBv(4, 3n));
  const arithmeticQuery = query(arithmeticExpr);
  const translatorInput = {
    kind: VK.ARG,
    id: 'gate_arg',
    reg: 'x0',
    origin: 'release-gate',
  };
  const translated = translateSemanticIR({
    id: 'gate_cmp',
    op: OP.CMP,
    cond: '==',
    args: [{ value: translatorInput }, { value: { const: 0n, id: 'gate_zero' } }],
  });
  const unsafeLoad = translateSemanticIR({
    id: 'gate_load',
    op: OP.LOAD,
    loc: { kind: MK.STACK, key: 'sp+8' },
  });
  const exactEdge = await verifyConditionalEdgeFeasibility({
    fromBlock: 'release-entry',
    toBlock: 'release-dead',
    edgeCondition: createBool(false),
    preconditions: createBool(true),
    backend: new ExhaustiveBvBackend(),
  });

  const checks = {
    exprEvaluator: evaluateExpr(arithmeticExpr, { [arithmetic.name]: 3n }).status === EVAL_STATUS.VALUE,
    translatorExact: translated.status === TRANSLATION_STATUS.EXACT && translated.semanticUnknowns === 0,
    unsafeMemoryUnknown: unsafeLoad.status === TRANSLATION_STATUS.UNSUPPORTED && unsafeLoad.semanticUnknowns > 0,
    liveBackend: backendGate.ok,
    exactEdgeProof: exactEdge.verdict === VERDICT.PROVED,
  };
  const expected = createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    constraints: [arithmeticExpr],
  });
  checks.queryIdentity = expected.schemaVersion && expected.queryHash.length > 0 && arithmeticQuery.queryHash.length > 0;
  return { checks, ok: Object.values(checks).every(Boolean) };
}

function capabilityStatuses(backendGate, implementationGate, testsOk) {
  const all = testsOk && implementationGate.ok;
  return {
    proofAuthorityContract: backendGate.ok && testsOk ? 'verified' : 'blocked',
    realExactSolverBackend: backendGate.ok ? 'verified' : 'blocked',
    isolatedWorkerLifecycle: testsOk ? 'verified' : 'blocked',
    independentSatModelValidation: backendGate.checks?.satModelValid && testsOk ? 'verified' : 'blocked',
    deterministicSmallBitvectorDifferential: testsOk ? 'verified' : 'blocked',
    globalPathCertificate: testsOk ? 'verified' : 'blocked',
    cacheIdentityFingerprint: testsOk ? 'verified' : 'blocked',
    solverNeutralExprDag: all ? 'verified' : 'blocked',
    bitvectorSemantics: all ? 'verified' : 'blocked',
    pureEvaluator: implementationGate.checks.exprEvaluator && testsOk ? 'verified' : 'blocked',
    semanticIrTranslator: implementationGate.checks.translatorExact && implementationGate.checks.unsafeMemoryUnknown && testsOk ? 'verified' : 'blocked',
    slicingScaffolding: testsOk ? 'verified' : 'blocked',
    solverBackendAbstraction: backendGate.ok && testsOk ? 'verified' : 'blocked',
    statusTaxonomy: testsOk ? 'verified' : 'blocked',
    satModelValidator: backendGate.checks?.satModelValid && testsOk ? 'verified' : 'blocked',
    vacuousProofGuard: all ? 'verified' : 'blocked',
    conditionalEdgeFeasibility: implementationGate.checks.exactEdgeProof && testsOk ? 'verified' : 'blocked',
    boundedEquivalence: testsOk ? 'verified' : 'blocked',
    patchVerification: testsOk ? 'verified' : 'blocked',
    symbolicEvidenceSchema: testsOk ? 'verified' : 'blocked',
    versionSafeCachePolicy: testsOk ? 'verified' : 'blocked',
  };
}

export function buildDeterministicPayload({ product, backend, testExecution, capabilities, gates }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    phase: 9,
    verifier: { id: VERIFIER_ID, version: VERIFIER_VERSION },
    product: {
      commitSha: product.commitSha,
      treeSha: product.treeSha,
      clean: product.clean,
      dirtyFiles: [...(product.dirtyFiles || [])],
    },
    backend: backend || null,
    testExecution: {
      selected: Number(testExecution.selected) || 0,
      total: Number(testExecution.total) || 0,
      allPassed: testExecution.allPassed === true,
    },
    capabilities,
    gates: gates.map((item) => ({
      id: item.id,
      description: item.description,
      status: item.status,
      ok: item.ok === true,
      reason: item.reason || null,
    })),
  };
}

export function validateEvidence(report) {
  const errors = [];
  for (const key of SCHEMA.required || []) if (!(key in report)) errors.push(`missing field: ${key}`);
  if (report.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion mismatch');
  if (!['READY', 'BLOCKING', 'NOT-INTEGRATED'].includes(report.verdict)) errors.push('invalid verdict');
  if (typeof report.deterministicDigest !== 'string' || !report.deterministicDigest) errors.push('missing deterministicDigest');
  if (typeof report.evidenceDigest !== 'string' || !report.evidenceDigest) errors.push('missing evidenceDigest');
  if (!Array.isArray(report.gates) || report.gates.some((item) => !['PASSED', 'FAILED'].includes(item.status))) errors.push('invalid gates');
  return errors;
}

function publishJson(relativePath, value) {
  const target = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (fs.statSync(temporary).size === 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`refusing to publish empty evidence: ${relativePath}`);
  }
  fs.renameSync(temporary, target);
}

export async function verifyPhase9() {
  const product = getProductIdentity();
  const discovered = discoverPhase9Tests(path.join(ROOT, 'tests/phase9'));
  let testExecution = { selected: 0, total: discovered.length, allPassed: false, error: null };
  try {
    const result = runPhase9Tests([], { root: path.join(ROOT, 'tests/phase9') });
    testExecution = { ...result, allPassed: true, error: null };
  } catch (error) {
    testExecution.error = String(error?.message || error);
    console.error('[phase9-verifier] Phase 9 tests FAILED:', testExecution.error);
  }

  const backendGate = await runLiveBackendGate();
  const implementationGate = await runLiveImplementationGates(backendGate);
  const testsOk = testExecution.allPassed === true;
  const gates = PROFILE.gates.map((profileGate) => {
    const ok = testsOk && implementationGate.ok && backendGate.ok;
    return gate(profileGate.id, profileGate.description, ok, {
      reason: ok ? null : (!testsOk ? 'phase9-contract-tests-failed' : (!backendGate.ok ? backendGate.reason : 'live-implementation-gate-failed')),
    });
  });
  const capabilities = capabilityStatuses(backendGate, implementationGate, testsOk);
  const allGatesPass = gates.every((item) => item.ok);
  const ready = product.clean && testsOk && allGatesPass;
  const verdict = ready ? 'READY' : 'BLOCKING';
  const backend = backendGate.backend;
  const payload = buildDeterministicPayload({ product, backend, testExecution, capabilities, gates });
  const deterministicDigest = stableDigest(payload);
  const finalReport = {
    ...payload,
    verdict,
    deterministicDigest,
    evidenceDigest: stableDigest({ ...payload, verdict, deterministicDigest }),
    backendGate: {
      ok: backendGate.ok,
      checks: backendGate.checks || null,
      reason: backendGate.reason || null,
    },
    implementationGate,
  };
  const errors = validateEvidence(finalReport);
  if (errors.length) throw new Error(`Phase 9 evidence failed its own schema: ${errors.join('; ')}`);

  publishJson(REPORT_RELATIVE_PATH, finalReport);
  const checkpoint = {
    id: 'P9-FINAL',
    result: verdict === 'READY' ? 'accepted' : 'blocking',
    integrationSha: product.commitSha,
    integrationTreeSha: product.treeSha,
    verifierId: VERIFIER_ID,
    verifierVersion: VERIFIER_VERSION,
    backendId: backend?.id || null,
    backendVersion: backend?.version || null,
    proofAuthority: backend?.proofAuthority || null,
    capabilityFingerprint: backend?.capabilityFingerprint || null,
    deterministicDigest,
    evidenceDigest: finalReport.evidenceDigest,
    gatesPassed: gates.filter((item) => item.ok).length,
    testFiles: testExecution.total,
  };
  let ledger = { phase: 9, checkpoints: [] };
  const ledgerPath = path.join(ROOT, CHECKPOINT_RELATIVE_PATH);
  if (fs.existsSync(ledgerPath)) {
    try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { /* rewrite malformed verifier-owned ledger */ }
  }
  ledger.checkpoints = (ledger.checkpoints || []).filter((item) => item.id !== 'P9-FINAL');
  ledger.checkpoints.push(checkpoint);
  publishJson(CHECKPOINT_RELATIVE_PATH, ledger);
  console.log(`[phase9-verifier] Verdict: ${verdict}`);
  console.log(`[phase9-verifier] Commit: ${product.commitSha}, Tree: ${product.treeSha}, Clean: ${product.clean}`);
  console.log(`[phase9-verifier] Backend: ${backend?.id || 'none'} ${backend?.version || ''} (${backend?.proofAuthority || 'none'})`);
  console.log(`[phase9-verifier] Deterministic digest: ${deterministicDigest}`);
  return Object.freeze(finalReport);
}

export { PROFILE, SCHEMA, REPORT_RELATIVE_PATH, CHECKPOINT_RELATIVE_PATH };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyPhase9().then((report) => {
    if (report.verdict !== 'READY') process.exitCode = 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
