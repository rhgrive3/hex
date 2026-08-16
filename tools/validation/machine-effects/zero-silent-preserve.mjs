import { COVERAGE_STATUS, normalizeLiftResult } from './coverage-model.mjs';

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function controlIsPreserving(controlEffect) {
  if (controlEffect == null) return true;
  const kind = String(controlEffect.kind || '').toLowerCase();
  return kind === '' || kind === 'none' || kind === 'fallthrough';
}

function hasUnknownState(bundle) {
  const unknown = bundle?.unknownEffects;
  return !!unknown && Array.isArray(unknown.categories) && unknown.categories.length > 0
    && unknown.preservation !== 'assumed';
}

function hasFaultOrControlEffect(bundle) {
  return (Array.isArray(bundle?.possibleFaults) && bundle.possibleFaults.length > 0)
    || !controlIsPreserving(bundle?.controlEffect);
}

export function silentPreserveAssessment({
  decodedInstruction,
  liftResult,
  recognized = true,
} = {}) {
  const normalized = normalizeLiftResult(liftResult);
  const bundle = normalized.bundle;
  const mnemonic = String(decodedInstruction?.mnemonic || decodedInstruction?.opcode || '<unknown>').toLowerCase();

  if (!recognized) {
    return Object.freeze({ safe: true, reason: 'instruction-not-recognized', mnemonic, coverage: normalized.coverage });
  }

  if (normalized.coverage === COVERAGE_STATUS.UNSUPPORTED && !bundle) {
    return Object.freeze({
      safe: true,
      reason: 'explicit-unsupported-without-preservation-claim',
      mnemonic,
      coverage: normalized.coverage,
    });
  }

  if (!bundle) {
    return Object.freeze({ safe: false, reason: 'recognized-result-missing-bundle', mnemonic, coverage: normalized.coverage });
  }

  const operations = Array.isArray(bundle.operations) ? bundle.operations : [];
  const explicitPreservation = bundle.statePreservation?.proven === true && !!bundle.statePreservation?.reason;
  const unresolvedState = hasUnknownState(bundle);
  const observableNonStateEffect = hasFaultOrControlEffect(bundle);

  if (normalized.coverage === COVERAGE_STATUS.UNSUPPORTED && explicitPreservation) {
    return Object.freeze({ safe: false, reason: 'unsupported-cannot-prove-state-preservation', mnemonic, coverage: normalized.coverage });
  }

  if (operations.length > 0 || unresolvedState || observableNonStateEffect) {
    return Object.freeze({ safe: true, reason: 'effects-or-uncertainty-explicit', mnemonic, coverage: normalized.coverage });
  }

  if (explicitPreservation && (normalized.coverage === COVERAGE_STATUS.EXACT || normalized.coverage === COVERAGE_STATUS.EXACT_WITH_INTRINSIC)) {
    return Object.freeze({ safe: true, reason: 'architectural-preservation-explicitly-proven', mnemonic, coverage: normalized.coverage });
  }

  return Object.freeze({
    safe: false,
    reason: 'recognized-empty-bundle-looks-like-preservation',
    mnemonic,
    coverage: normalized.coverage,
  });
}

export function assertNoSilentPreserve(input) {
  const assessment = silentPreserveAssessment(input);
  if (!assessment.safe) fail('zero-silent-preserve', `${assessment.mnemonic}: ${assessment.reason}`);
  return assessment;
}
