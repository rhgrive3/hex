import { stableStringify } from './core.mjs';
import { createPathProofRecorder, FULL_V2_PATH, verifyPathProof } from './path-proof.mjs';

export const DIFFERENTIAL_CLASSIFICATIONS = Object.freeze([
  'exact/equivalent',
  'stricter-conservative',
  'explained-representation-difference',
  'mismatch',
  'not-integrated',
]);

function missingStages(adapters) {
  const missing = [];
  if (typeof adapters?.legacy?.run !== 'function') missing.push('legacy-v1');
  const required = [
    ['machine-effects','machineEffects'],
    ['semantic-ir-v2','semanticIrV2'],
    ['scalar-ssa','scalarSsa'],
    ['region-resolver','resolveRegions'],
    ['memoryssa','memorySsa'],
    ['v1-compat','compatV1'],
  ];
  for (const [stage, method] of required) if (typeof adapters?.v2?.[method] !== 'function') missing.push(stage);
  return missing;
}

function classificationRecord(testCase, classification, details = {}) {
  return Object.freeze({ caseName: testCase.name, classification, ...details });
}

export async function runDifferentialCase(testCase, adapters) {
  const missing = missingStages(adapters);
  if (missing.length) return classificationRecord(testCase, 'not-integrated', { missingStages: Object.freeze(missing), blocking: true });

  const legacyProof = createPathProofRecorder();
  const v2Proof = createPathProofRecorder();
  let legacyOutput;
  let projectedOutput;
  try {
    legacyProof.mark('legacy-v1');
    legacyOutput = await adapters.legacy.run(testCase.input, { pathProof: legacyProof, caseName: testCase.name });

    v2Proof.mark('machine-effects');
    const effects = await adapters.v2.machineEffects(testCase.input, { pathProof: v2Proof, caseName: testCase.name });
    v2Proof.mark('semantic-ir-v2');
    const ir = await adapters.v2.semanticIrV2(effects, { pathProof: v2Proof, caseName: testCase.name });
    v2Proof.mark('scalar-ssa');
    const ssa = await adapters.v2.scalarSsa(ir, { pathProof: v2Proof, caseName: testCase.name });
    v2Proof.mark('region-resolver');
    const regions = await adapters.v2.resolveRegions(ir, { pathProof: v2Proof, caseName: testCase.name });
    v2Proof.mark('memoryssa');
    const memoryssa = await adapters.v2.memorySsa(ir, regions, { pathProof: v2Proof, caseName: testCase.name });
    v2Proof.mark('v1-compat');
    projectedOutput = await adapters.v2.compatV1({ effects, ir, ssa, regions, memoryssa }, { pathProof: v2Proof, caseName: testCase.name });
  } catch (error) {
    return classificationRecord(testCase, 'mismatch', { blocking: true, error: String(error?.message ?? error), pathProof: verifyPathProof(v2Proof.snapshot(), FULL_V2_PATH) });
  }

  const pathProof = verifyPathProof(v2Proof.snapshot(), FULL_V2_PATH);
  if (!pathProof.passed) return classificationRecord(testCase, 'mismatch', { blocking: true, reason: 'v2-path-proof-failed', pathProof });

  const normalizeLegacy = testCase.normalizeLegacy ?? ((value) => value);
  const normalizeV2 = testCase.normalizeV2 ?? ((value) => value);
  const legacyCanonical = normalizeLegacy(legacyOutput);
  const v2Canonical = normalizeV2(projectedOutput);
  if (stableStringify(legacyCanonical) === stableStringify(v2Canonical)) {
    return classificationRecord(testCase, 'exact/equivalent', { blocking: false, pathProof });
  }

  if (typeof testCase.isStricterConservative === 'function' && await testCase.isStricterConservative(legacyCanonical, v2Canonical)) {
    return classificationRecord(testCase, 'stricter-conservative', { blocking: false, pathProof });
  }

  if (typeof testCase.explainRepresentationDifference === 'function') {
    const explanation = await testCase.explainRepresentationDifference(legacyCanonical, v2Canonical);
    // A representation difference is acceptable only with an explicit safety
    // proof. Missing proof must fail closed; prose alone is not evidence of
    // semantic equivalence or conservative behavior.
    const safetyOk = typeof testCase.safetyFloorPreserved === 'function'
      ? await testCase.safetyFloorPreserved(legacyCanonical, v2Canonical)
      : false;
    if (typeof explanation === 'string' && explanation.trim() && safetyOk === true) {
      return classificationRecord(testCase, 'explained-representation-difference', { blocking: false, explanation: explanation.trim(), pathProof });
    }
  }

  return classificationRecord(testCase, 'mismatch', {
    blocking: true,
    reason: 'semantic-projection-differs-from-legacy-oracle',
    legacy: legacyCanonical,
    projected: v2Canonical,
    pathProof,
  });
}

export async function runDifferentialHarness({ cases = [], adapters } = {}) {
  const results = [];
  for (const testCase of cases) results.push(await runDifferentialCase(testCase, adapters));
  const count = (kind) => results.filter((result) => result.classification === kind).length;
  const mismatchCount = count('mismatch');
  const notIntegratedCount = count('not-integrated');
  return Object.freeze({
    results: Object.freeze(results),
    differentialMatchCount: count('exact/equivalent') + count('explained-representation-difference'),
    exactEquivalentCount: count('exact/equivalent'),
    explainedRepresentationDifferenceCount: count('explained-representation-difference'),
    stricterConservativeCount: count('stricter-conservative'),
    mismatchCount,
    notIntegratedCount,
    blocking: mismatchCount > 0 || notIntegratedCount > 0,
  });
}
