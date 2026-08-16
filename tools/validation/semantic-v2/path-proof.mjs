import { stableStringify } from './core.mjs';

export const FULL_V2_PATH = Object.freeze([
  'machine-effects',
  'semantic-ir-v2',
  'scalar-ssa',
  'region-resolver',
  'memoryssa',
  'v1-compat',
]);

export const COMPATIBILITY_PATH = Object.freeze(['semantic-ir-v2', 'v1-compat']);

export function createPathProofRecorder() {
  const events = [];
  return Object.freeze({
    mark(stage, metadata = null) {
      events.push(Object.freeze({ stage: String(stage), metadata }));
    },
    snapshot() {
      return Object.freeze(events.map((event) => Object.freeze({ ...event })));
    },
  });
}

export function verifyPathProof(events, requiredStages = COMPATIBILITY_PATH) {
  const stages = (events ?? []).map((event) => String(event.stage));
  let cursor = 0;
  const missing = [];
  for (const required of requiredStages) {
    const found = stages.indexOf(required, cursor);
    if (found < 0) missing.push(required);
    else cursor = found + 1;
  }
  const legacyOnly = stages.includes('legacy-v1') && !stages.includes('semantic-ir-v2');
  return Object.freeze({
    passed: missing.length === 0 && !legacyOnly,
    requiredStages: Object.freeze([...requiredStages]),
    observedStages: Object.freeze(stages),
    missingStages: Object.freeze(missing),
    legacyOnly,
    fingerprint: stableStringify(stages),
  });
}
