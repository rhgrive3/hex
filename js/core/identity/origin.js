import { canonicalAddress, deepFreeze, jsonSafe, stableStringify } from './index.js';

export const ORIGIN_SCHEMA_VERSION = 1;
const CANONICAL_ORIGIN_SETS = new WeakSet();

function fail(code) { throw new TypeError(code); }
function stringList(values, code) {
  if (values == null) return [];
  if (!Array.isArray(values)) fail(code);
  return values.map((value) => String(value)).filter(Boolean);
}
function bigintValue(value, code) {
  if (typeof value === 'string' && !value.trim()) fail(code);
  try { return typeof value === 'bigint' ? value : BigInt(value); }
  catch { fail(code); }
}
function uniqueSorted(values) {
  const byKey = new Map(values.map((value) => [stableStringify(value), value]));
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

function byteRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-byte-range');
  const start = bigintValue(range.start ?? range.offset, 'origin-invalid-byte-range');
  const end = range.end != null ? bigintValue(range.end, 'origin-invalid-byte-range')
    : range.length != null ? start + bigintValue(range.length, 'origin-invalid-byte-range') : null;
  if (end == null || start < 0n || end < start) fail('origin-invalid-byte-range');
  return {
    ...(range.binaryId == null ? {} : { binaryId: String(range.binaryId) }),
    start: start.toString(),
    end: end.toString(),
  };
}

function virtualRange(range) {
  if (!range || typeof range !== 'object') fail('origin-invalid-virtual-range');
  const start = canonicalAddress(range.start ?? range.address);
  let end;
  if (range.end != null) end = canonicalAddress(range.end);
  else if (range.length != null) end = canonicalAddress(BigInt(start) + bigintValue(range.length, 'origin-invalid-virtual-range'));
  else fail('origin-invalid-virtual-range');
  if (BigInt(end) < BigInt(start)) fail('origin-invalid-virtual-range');
  return {
    ...(range.imageId == null ? {} : { imageId: String(range.imageId) }),
    ...(range.sliceId == null ? {} : { sliceId: String(range.sliceId) }),
    start,
    end,
  };
}

export function createTransformRecord(input = {}) {
  if (!input || typeof input !== 'object') fail('origin-invalid-transform');
  const passId = String(input.passId ?? '').trim();
  const passVersion = String(input.passVersion ?? '').trim();
  const ruleId = String(input.ruleId ?? '').trim();
  const proofKind = String(input.proofKind ?? '').trim();
  if (!passId || !passVersion || !ruleId || !proofKind) fail('origin-invalid-transform');
  return deepFreeze({
    passId,
    passVersion,
    ruleId,
    consumedEntityIds: uniqueSorted(stringList(input.consumedEntityIds, 'origin-invalid-consumed-ids')),
    producedEntityIds: uniqueSorted(stringList(input.producedEntityIds, 'origin-invalid-produced-ids')),
    preconditions: jsonSafe(input.preconditions ?? []),
    proofKind,
    timestampOrBuildId: input.timestampOrBuildId == null ? null : String(input.timestampOrBuildId),
  });
}

export function createOriginSet(input = {}) {
  if (input && typeof input === 'object' && CANONICAL_ORIGIN_SETS.has(input)) return input;
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('origin-invalid-set');
  const byteRanges = uniqueSorted((input.byteRanges || []).map(byteRange));
  const virtualRanges = uniqueSorted((input.virtualRanges || []).map(virtualRange));
  const transforms = uniqueSorted((input.transforms || []).map(createTransformRecord));
  const out = {
    schemaVersion: ORIGIN_SCHEMA_VERSION,
    byteRanges,
    virtualRanges,
    instructionIds: uniqueSorted(stringList(input.instructionIds, 'origin-invalid-instruction-ids')),
    operationIds: uniqueSorted(stringList(input.operationIds ?? input.bytecodeOperationIds, 'origin-invalid-operation-ids')),
    sourceLocations: uniqueSorted((input.sourceLocations || []).map((value) => jsonSafe(value))),
    parentEntityIds: uniqueSorted(stringList(input.parentEntityIds, 'origin-invalid-parent-ids')),
    transforms,
  };
  const frozen = deepFreeze(out);
  CANONICAL_ORIGIN_SETS.add(frozen);
  return frozen;
}

export function mergeOriginSets(...sets) {
  const normalized = sets.filter((value) => value != null).map((value) => createOriginSet(value));
  return createOriginSet({
    byteRanges: normalized.flatMap((value) => value.byteRanges),
    virtualRanges: normalized.flatMap((value) => value.virtualRanges),
    instructionIds: normalized.flatMap((value) => value.instructionIds),
    operationIds: normalized.flatMap((value) => value.operationIds),
    sourceLocations: normalized.flatMap((value) => value.sourceLocations),
    parentEntityIds: normalized.flatMap((value) => value.parentEntityIds),
    transforms: normalized.flatMap((value) => value.transforms),
  });
}

export function appendTransform(origin, transform) {
  const base = createOriginSet(origin);
  return mergeOriginSets(base, createOriginSet({ transforms: [transform] }));
}
