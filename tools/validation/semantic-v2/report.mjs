import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { scanArchitectureNeutrality } from './architecture-neutrality.mjs';
import { runSsaOracle, createSsaOracleCases } from './ssa-oracle.mjs';
import { runMemorySsaOracle, createMemorySsaOracleCases } from './memoryssa-oracle.mjs';
import { runDifferentialHarness } from './differential.mjs';
import { verifyProvenance, verifyDeterminism } from './provenance.mjs';
import { stableValue } from './core.mjs';

export const PHASE3_VERIFICATION_REPORT_VERSION = 1;

function emptyDifferential(notIntegrated = true) {
  return Object.freeze({
    results: Object.freeze([]), differentialMatchCount: 0, exactEquivalentCount: 0,
    explainedRepresentationDifferenceCount: 0, stricterConservativeCount: 0,
    mismatchCount: 0, notIntegratedCount: notIntegrated ? 1 : 0, blocking: notIntegrated,
  });
}

export async function runPhase3Verification({
  root = process.cwd(),
  ssaAdapter = null,
  memorySsaAdapter = null,
  differentialAdapters = null,
  differentialCases = [],
  provenance = { entities: [], roots: [] },
  determinismChecks = [],
} = {}) {
  const architecture = scanArchitectureNeutrality({ root });
  const ssa = await runSsaOracle({ adapter: ssaAdapter, cases: createSsaOracleCases() });
  const memoryssa = await runMemorySsaOracle({ adapter: memorySsaAdapter, cases: createMemorySsaOracleCases() });
  const differential = differentialCases.length
    ? await runDifferentialHarness({ cases: differentialCases, adapters: differentialAdapters })
    : emptyDifferential(!differentialAdapters);
  const provenanceResult = verifyProvenance(provenance);
  const determinism = [];
  for (const check of determinismChecks) {
    const result = await verifyDeterminism(check);
    determinism.push(Object.freeze({ name: String(check.name ?? 'unnamed'), ...result }));
  }
  const determinismMismatchCount = determinism.filter((result) => !result.deterministic).length;
  const notIntegratedReasons = [];
  if (!ssa.integrated) notIntegratedReasons.push(ssa.reason);
  if (!memoryssa.integrated) notIntegratedReasons.push(memoryssa.reason);
  if (differential.notIntegratedCount > 0) notIntegratedReasons.push('differential-pipeline-not-integrated');
  const notIntegrated = notIntegratedReasons.length > 0;
  const blocking = architecture.architectureLeakCount > 0
    || ssa.blocking
    || memoryssa.blocking
    || provenanceResult.provenanceLossCount > 0
    || differential.blocking
    || determinismMismatchCount > 0
    || notIntegrated;

  return Object.freeze({
    reportVersion: PHASE3_VERIFICATION_REPORT_VERSION,
    status: blocking ? 'blocking' : 'pass',
    blocking,
    notIntegrated,
    notIntegratedReasons: Object.freeze([...new Set(notIntegratedReasons)].sort()),
    ssaCases: Object.freeze({ passed: ssa.passed, failed: ssa.failed, integrated: ssa.integrated, results: ssa.cases }),
    memorySsaCases: Object.freeze({ passed: memoryssa.passed, failed: memoryssa.failed, integrated: memoryssa.integrated, results: memoryssa.cases }),
    architectureLeakCount: architecture.architectureLeakCount,
    architectureFilesChecked: architecture.filesChecked,
    architectureLeaks: architecture.violations,
    provenanceLossCount: provenanceResult.provenanceLossCount,
    provenanceLosses: provenanceResult.losses,
    differentialMatchCount: differential.differentialMatchCount,
    exactEquivalentCount: differential.exactEquivalentCount,
    explainedRepresentationDifferenceCount: differential.explainedRepresentationDifferenceCount,
    stricterConservativeCount: differential.stricterConservativeCount,
    mismatchCount: differential.mismatchCount,
    differentialNotIntegratedCount: differential.notIntegratedCount,
    differentialResults: differential.results,
    determinismCaseCount: determinism.length,
    determinismMismatchCount,
    determinism: Object.freeze(determinism),
  });
}

async function loadAdapter(modulePath) {
  if (!modulePath) return null;
  const absolute = path.resolve(process.cwd(), modulePath);
  const imported = await import(pathToFileURL(absolute).href);
  if (typeof imported.createPhase3VerificationAdapters !== 'function') {
    throw new TypeError('phase3-verification-adapter-factory-required');
  }
  return imported.createPhase3VerificationAdapters();
}

async function main() {
  const args = process.argv.slice(2);
  let adapterPath = null;
  let allowBlocking = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--adapter') adapterPath = args[++index];
    else if (args[index] === '--allow-blocking') allowBlocking = true;
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  const adapters = await loadAdapter(adapterPath);
  const report = await runPhase3Verification({
    root: process.cwd(),
    ssaAdapter: adapters?.ssa ?? null,
    memorySsaAdapter: adapters?.memoryssa ?? null,
    differentialAdapters: adapters?.differential ?? null,
    differentialCases: adapters?.differentialCases ?? [],
    provenance: adapters?.provenance ?? { entities: [], roots: [] },
    determinismChecks: adapters?.determinismChecks ?? [],
  });
  process.stdout.write(`${JSON.stringify(stableValue(report), null, 2)}\n`);
  if (report.blocking && !allowBlocking) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
