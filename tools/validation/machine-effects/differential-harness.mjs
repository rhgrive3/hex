import { serializeMachineEffectBundle } from '../../../js/semantics/effects/index.js';
import {
  COVERAGE_STATUS,
  INTEGRATION_STATE,
  createCoverageRecord,
  normalizeLiftResult,
  summarizeCoverage,
} from './coverage-model.mjs';
import { assertNoSilentPreserve } from './zero-silent-preserve.mjs';

export const LEGACY_ORACLE_ROLE = 'compatibility-oracle-not-isa-truth';

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function stableValue(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'undefined' || typeof value === 'symbol') return undefined;
  if (value instanceof Map) {
    return {
      $map: [...value.entries()]
        .map(([key, entryValue]) => [stableValue(key, seen), stableValue(entryValue, seen)])
        .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
    };
  }
  if (value instanceof Set) {
    return { $set: [...value].map((item) => stableValue(item, seen)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  }
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen) ?? null);
  if (typeof value === 'object') {
    if (seen.has(value)) fail('non-serializable-cycle');
    seen.add(value);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = stableValue(value[key], seen);
      if (normalized !== undefined) out[key] = normalized;
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function canonicalDecodedInstruction(decodedInstruction) {
  if (!decodedInstruction || typeof decodedInstruction !== 'object') fail('decoded-instruction-required');
  return canonicalJson(decodedInstruction);
}

export function canonicalSemanticVersions(semanticVersions = {}) {
  if (!semanticVersions || typeof semanticVersions !== 'object') fail('semantic-versions-required');
  return canonicalJson(semanticVersions);
}

export function canonicalV1Result(value) {
  return canonicalJson(value);
}

async function invoke(fn, ...args) {
  return await fn(...args);
}

function missingDifferentialAdapters({ machineLifter, compatibilityLowering, legacyV1Oracle }) {
  const missing = [];
  if (typeof machineLifter !== 'function') missing.push('machineLifter');
  if (typeof compatibilityLowering !== 'function') missing.push('compatibilityLowering');
  if (typeof legacyV1Oracle !== 'function') missing.push('legacyV1Oracle');
  return missing;
}

export async function compareDecodedInstruction({
  decodedInstruction,
  semanticVersions = {},
  machineLifter,
  compatibilityLowering,
  legacyV1Oracle,
  normalizeV1 = canonicalV1Result,
  integrationState = null,
  family = null,
  recognized = true,
} = {}) {
  const decodedKey = canonicalDecodedInstruction(decodedInstruction);
  const versionsKey = canonicalSemanticVersions(semanticVersions);
  const mnemonic = String(decodedInstruction?.mnemonic || decodedInstruction?.opcode || '').toLowerCase() || null;
  const missingAdapters = missingDifferentialAdapters({ machineLifter, compatibilityLowering, legacyV1Oracle });
  const effectiveIntegrationState = integrationState == null
    ? (missingAdapters.length ? INTEGRATION_STATE.NOT_INTEGRATED : INTEGRATION_STATE.INTEGRATED)
    : integrationState;

  if (effectiveIntegrationState !== INTEGRATION_STATE.INTEGRATED && effectiveIntegrationState !== INTEGRATION_STATE.NOT_INTEGRATED) {
    fail('invalid-integration-state', String(effectiveIntegrationState));
  }

  if (effectiveIntegrationState === INTEGRATION_STATE.NOT_INTEGRATED) {
    return Object.freeze({
      status: INTEGRATION_STATE.NOT_INTEGRATED,
      matched: null,
      blocking: true,
      oracleRole: LEGACY_ORACLE_ROLE,
      decodedKey,
      versionsKey,
      coverage: COVERAGE_STATUS.UNKNOWN,
      family,
      mnemonic,
      missingAdapters: Object.freeze(missingAdapters),
      reason: missingAdapters.length
        ? `composed differential adapters not injected: ${missingAdapters.join(', ')}`
        : 'composed ARM64 MachineEffects integration explicitly marked not-integrated',
    });
  }

  if (typeof machineLifter !== 'function') fail('machine-lifter-required');
  if (typeof compatibilityLowering !== 'function') fail('compatibility-lowering-required');
  if (typeof legacyV1Oracle !== 'function') fail('legacy-v1-oracle-required');
  if (typeof normalizeV1 !== 'function') fail('v1-normalizer-required');

  const rawLift = await invoke(machineLifter, decodedInstruction, { semanticVersions });
  const lift = normalizeLiftResult(rawLift);
  assertNoSilentPreserve({ decodedInstruction, liftResult: rawLift, recognized });

  if (lift.coverage === COVERAGE_STATUS.UNSUPPORTED && !lift.bundle) {
    return Object.freeze({
      status: 'unsupported',
      matched: null,
      blocking: false,
      oracleRole: LEGACY_ORACLE_ROLE,
      decodedKey,
      versionsKey,
      coverage: lift.coverage,
      family,
      mnemonic,
      reason: lift.reason,
    });
  }

  const lowered = await invoke(compatibilityLowering, lift.bundle, { decodedInstruction, semanticVersions });
  const legacy = await invoke(legacyV1Oracle, decodedInstruction, { semanticVersions });
  const loweredCanonical = normalizeV1(lowered);
  const legacyCanonical = normalizeV1(legacy);
  const matched = loweredCanonical === legacyCanonical;

  return Object.freeze({
    status: matched ? 'match' : 'mismatch',
    matched,
    blocking: !matched,
    oracleRole: LEGACY_ORACLE_ROLE,
    decodedKey,
    versionsKey,
    coverage: lift.coverage,
    family,
    mnemonic,
    machineEffectsCanonical: serializeMachineEffectBundle(lift.bundle),
    loweredCanonical,
    legacyCanonical,
  });
}

export function assertDifferentialReady(result) {
  if (!result || result.status === INTEGRATION_STATE.NOT_INTEGRATED) {
    fail('machine-effects-differential-not-integrated', result?.reason || 'missing result');
  }
  return true;
}

export function assertDifferentialMatch(result) {
  assertDifferentialReady(result);
  if (result.status === 'mismatch' || result.matched === false) {
    fail('machine-effects-v1-compatibility-mismatch', result.mnemonic || result.decodedKey || 'instruction');
  }
  return true;
}

export async function runDifferentialSuite(cases, options = {}) {
  if (!Array.isArray(cases)) fail('differential-cases-must-be-array');
  const results = [];
  const coverageRecords = [];

  for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index] || {};
    const result = await compareDecodedInstruction({ ...options, ...testCase });
    results.push(result);
    coverageRecords.push(createCoverageRecord({
      key: testCase.key || `${index}:${result.mnemonic || '<unknown>'}`,
      mnemonic: result.mnemonic,
      family: testCase.family || result.family,
      coverage: result.coverage,
      reason: result.reason || null,
      integrationState: result.status === INTEGRATION_STATE.NOT_INTEGRATED
        ? INTEGRATION_STATE.NOT_INTEGRATED
        : INTEGRATION_STATE.INTEGRATED,
      evidence: [LEGACY_ORACLE_ROLE],
    }));
  }

  const coverage = summarizeCoverage(coverageRecords);
  return Object.freeze({
    schemaVersion: 'machine-effects-differential-report/v1',
    oracleRole: LEGACY_ORACLE_ROLE,
    integrationState: coverage.integrationState,
    total: results.length,
    matches: results.filter((result) => result.status === 'match').length,
    mismatches: results.filter((result) => result.status === 'mismatch').length,
    unsupported: results.filter((result) => result.status === 'unsupported').length,
    notIntegrated: results.filter((result) => result.status === INTEGRATION_STATE.NOT_INTEGRATED).length,
    coverage,
    results: Object.freeze(results),
  });
}

export async function assertDeterministicLift({
  decodedInstruction,
  semanticVersions = {},
  machineLifter,
  runs = 3,
} = {}) {
  if (typeof machineLifter !== 'function') fail('machine-lifter-required');
  if (!Number.isInteger(runs) || runs < 2) fail('determinism-runs-must-be-at-least-two');
  const decodedKey = canonicalDecodedInstruction(decodedInstruction);
  const versionsKey = canonicalSemanticVersions(semanticVersions);
  const outputs = [];

  for (let index = 0; index < runs; index++) {
    const lift = normalizeLiftResult(await invoke(machineLifter, decodedInstruction, { semanticVersions }));
    const canonical = lift.bundle
      ? canonicalJson({ coverage: lift.coverage, bundle: JSON.parse(serializeMachineEffectBundle(lift.bundle)) })
      : canonicalJson({ coverage: lift.coverage, reason: lift.reason });
    outputs.push(canonical);
  }

  const first = outputs[0];
  const mismatchIndex = outputs.findIndex((output) => output !== first);
  if (mismatchIndex >= 0) {
    fail('machine-effects-nondeterministic', `run 0 != run ${mismatchIndex}; decoded=${decodedKey}; versions=${versionsKey}`);
  }
  return Object.freeze({ deterministic: true, runs, decodedKey, versionsKey, canonical: first });
}
