import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const REBUILD_TRANSACTION_SCHEMA = 'hex-rebuild-transaction-v2';
export const REBUILD_VALIDATION_SCHEMA = 'hex-rebuild-validation-v2';
const ATOMIC_PUBLICATION_PROTOCOLS = new Set(['temp-then-atomic-rename', 'transactional-store']);

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError('rebuild-v2-bytes-required');
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function hashBytes(value) {
  return `bytes:${stableDigest(Array.from(toBytes(value)))}`;
}

function sorted(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();
}

function positiveSafe(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

function requiredValidators(impact, additional = [], requireIndependentOracle = false) {
  const set = new Set(['source-precondition', 'structure', 'loader-reparse', 'unchanged-regions', 'evidence']);
  if (impact.layoutMoving) set.add('layout');
  if (impact.relocations) set.add('relocations');
  if (impact.branchRanges) set.add('branch-ranges');
  if (impact.unwind) set.add('unwind');
  if (impact.importsExports) set.add('imports-exports');
  if (impact.signature) set.add('signature-consequence');
  for (const item of additional) set.add(String(item));
  if (requireIndependentOracle) set.add('independent-differential');
  return [...set].sort();
}

export function createRebuildTransaction(input = {}) {
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new TypeError('rebuild-v2-operations-required');
  const operations = input.operations.map((operation, index) => {
    const offset = BigInt(operation.offset ?? operation.fileOffset ?? -1);
    if (offset < 0n) throw new TypeError('rebuild-v2-offset-invalid');
    const before = toBytes(operation.before ?? []);
    const after = toBytes(operation.after ?? []);
    if (before.length === 0 && after.length === 0) throw new TypeError('rebuild-v2-empty-operation');
    return {
      id: required(operation.id || `operation:${index}:${stableDigest({ offset: offset.toString(), before: Array.from(before), after: Array.from(after) })}`, 'rebuild-v2-operation-id-required'),
      offset: offset.toString(),
      before: Array.from(before),
      after: Array.from(after),
      address: operation.address == null ? null : String(operation.address),
      provenance: clone(operation.provenance || { source: 'local-patch' }),
    };
  }).sort((a, b) => BigInt(a.offset) < BigInt(b.offset) ? -1 : BigInt(a.offset) > BigInt(b.offset) ? 1 : a.id.localeCompare(b.id));

  for (let index = 1; index < operations.length; index++) {
    const previous = operations[index - 1];
    const current = operations[index];
    const previousEnd = BigInt(previous.offset) + BigInt(previous.before.length);
    if (BigInt(current.offset) < previousEnd) throw new TypeError('rebuild-v2-overlapping-original-ranges');
  }

  const sizeDelta = operations.reduce((sum, operation) => sum + operation.after.length - operation.before.length, 0);
  const declaredImpact = input.impact || {};
  const impact = {
    layoutMoving: sizeDelta !== 0 || declaredImpact.layoutMoving === true,
    relocations: declaredImpact.relocations === true,
    branchRanges: declaredImpact.branchRanges === true,
    unwind: declaredImpact.unwind === true,
    importsExports: declaredImpact.importsExports === true,
    signature: declaredImpact.signature === true,
    sections: clone(declaredImpact.sections || []),
  };
  const requireIndependentOracle = input.requireIndependentOracle === true;
  const transaction = {
    schemaVersion: REBUILD_TRANSACTION_SCHEMA,
    transactionId: null,
    binaryId: required(input.binaryId, 'rebuild-v2-binary-id-required'),
    sourceHash: required(input.sourceHash, 'rebuild-v2-source-hash-required'),
    format: required(input.format, 'rebuild-v2-format-required').toLowerCase(),
    architecture: required(input.architecture, 'rebuild-v2-architecture-required').toLowerCase(),
    operations,
    sizeDelta,
    impact,
    expectedOriginalState: clone(input.expectedOriginalState || { sourceHash: input.sourceHash }),
    requiredValidators: requiredValidators(impact, input.additionalValidators || [], requireIndependentOracle),
    requireIndependentOracle,
    unresolvedRisks: sorted(input.unresolvedRisks),
    authority: 'L3-explicit-rebuild-proposal',
  };
  transaction.transactionId = `rebuild-transaction:${stableDigest(transaction)}`;
  return deepFreeze(transaction);
}

async function sourceBytes(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return toBytes(source);
}

export async function materializeRebuildTransaction(transaction, source, options = {}) {
  if (!transaction || transaction.schemaVersion !== REBUILD_TRANSACTION_SCHEMA) return { status: 'rejected', reason: 'rebuild-v2-transaction-schema-invalid' };
  const original = await sourceBytes(source);
  if (options.signal?.aborted) return { status: 'cancelled', reason: 'rebuild-v2-cancelled-before-materialization', transactionId: transaction.transactionId };
  const observedHash = hashBytes(original);
  if (observedHash !== transaction.sourceHash) return { status: 'rejected', reason: 'rebuild-v2-source-identity-mismatch', expected: transaction.sourceHash, observed: observedHash, transactionId: transaction.transactionId };

  const finalLength = original.length + transaction.sizeDelta;
  const defaultBudget = Math.min(Math.max(original.length * 4 + 1024 * 1024, 16 * 1024 * 1024), 2_147_483_647);
  let maxOutputBytes;
  try { maxOutputBytes = positiveSafe(options.maxOutputBytes, defaultBudget, 2_147_483_647, 'rebuild-v2-max-output-budget-invalid'); }
  catch { return { status: 'rejected', reason: 'rebuild-v2-max-output-budget-invalid' }; }
  if (!Number.isSafeInteger(finalLength) || finalLength < 0 || finalLength > maxOutputBytes) return { status: 'rejected', reason: 'rebuild-v2-output-budget-exceeded', finalLength, maxOutputBytes };

  const output = new Uint8Array(finalLength);
  const mappings = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const operation of transaction.operations) {
    if (options.signal?.aborted) return { status: 'cancelled', reason: 'rebuild-v2-cancelled-during-materialization', transactionId: transaction.transactionId };
    const offset = Number(BigInt(operation.offset));
    if (!Number.isSafeInteger(offset) || offset < sourceCursor || offset > original.length) return { status: 'rejected', reason: 'rebuild-v2-operation-out-of-range', operationId: operation.id };
    const before = Uint8Array.from(operation.before);
    const after = Uint8Array.from(operation.after);
    if (offset + before.length > original.length) return { status: 'rejected', reason: 'rebuild-v2-operation-out-of-range', operationId: operation.id };
    for (let i = 0; i < before.length; i++) if (original[offset + i] !== before[i]) return { status: 'rejected', reason: 'rebuild-v2-original-precondition-mismatch', operationId: operation.id, byteIndex: i };

    const untouchedLength = offset - sourceCursor;
    output.set(original.subarray(sourceCursor, offset), outputCursor);
    if (untouchedLength > 0) mappings.push({ kind: 'unchanged', sourceOffset: sourceCursor, outputOffset: outputCursor, length: untouchedLength });
    outputCursor += untouchedLength;
    output.set(after, outputCursor);
    mappings.push({ kind: 'operation', operationId: operation.id, sourceOffset: offset, outputOffset: outputCursor, beforeLength: before.length, afterLength: after.length });
    outputCursor += after.length;
    sourceCursor = offset + before.length;
  }
  const tailLength = original.length - sourceCursor;
  output.set(original.subarray(sourceCursor), outputCursor);
  if (tailLength > 0) mappings.push({ kind: 'unchanged', sourceOffset: sourceCursor, outputOffset: outputCursor, length: tailLength });
  outputCursor += tailLength;
  if (outputCursor !== output.length) return { status: 'rejected', reason: 'rebuild-v2-materialization-length-mismatch' };

  return deepFreeze({
    status: 'materialized',
    transactionId: transaction.transactionId,
    sourceHash: observedHash,
    outputHash: hashBytes(output),
    sourceLength: original.length,
    outputLength: output.length,
    sizeDelta: transaction.sizeDelta,
    bytes: output,
    mappings,
    temporary: true,
    publication: 'not-published',
  });
}

function verifyUnchangedMappings(original, output, mappings) {
  for (const mapping of mappings) {
    if (mapping.kind !== 'unchanged') continue;
    const left = original.subarray(mapping.sourceOffset, mapping.sourceOffset + mapping.length);
    const right = output.subarray(mapping.outputOffset, mapping.outputOffset + mapping.length);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

function validatorResult(name, executed, ok, reason = null, detail = null) {
  return deepFreeze({ validator: name, executed, status: ok ? 'passed' : 'failed', reason: ok ? null : reason, detail: clone(detail) });
}

async function executeExternal(name, fn, context) {
  if (typeof fn !== 'function') return validatorResult(name, false, false, 'required-validator-unavailable');
  try {
    const result = await fn(context);
    if (!result || result.ok !== true) return validatorResult(name, true, false, result?.reason || 'validator-rejected', result || null);
    return validatorResult(name, true, true, null, result);
  } catch (error) {
    return validatorResult(name, true, false, String(error?.message || error));
  }
}

export async function validateRebuildTransaction(transaction, materialized, options = {}) {
  if (!transaction || transaction.schemaVersion !== REBUILD_TRANSACTION_SCHEMA) return { status: 'invalid', reason: 'rebuild-v2-transaction-schema-invalid' };
  if (!materialized || materialized.status !== 'materialized' || materialized.transactionId !== transaction.transactionId) return { status: 'invalid', reason: 'rebuild-v2-materialization-invalid' };
  const original = await sourceBytes(options.original || new Uint8Array());
  const validators = [];
  const builtins = new Map();
  const sourceMatches = hashBytes(original) === transaction.sourceHash;
  const structureMatches = materialized.outputLength === materialized.sourceLength + transaction.sizeDelta;
  const unchangedMatches = verifyUnchangedMappings(original, materialized.bytes, materialized.mappings);
  const evidenceComplete = transaction.operations.every((operation) => operation.provenance && Object.keys(operation.provenance).length > 0);
  builtins.set('source-precondition', () => validatorResult('source-precondition', true, sourceMatches, 'source-hash-mismatch'));
  builtins.set('structure', () => validatorResult('structure', true, structureMatches, 'output-length-inconsistent'));
  builtins.set('unchanged-regions', () => validatorResult('unchanged-regions', true, unchangedMatches, 'unchanged-region-differed'));
  builtins.set('evidence', () => validatorResult('evidence', true, evidenceComplete, 'operation-provenance-missing'));

  for (const name of transaction.requiredValidators) {
    if (builtins.has(name)) {
      validators.push(builtins.get(name)());
      continue;
    }
    const external = name === 'loader-reparse'
      ? options.loaderReparse
      : name === 'independent-differential'
        ? options.independentOracle
        : options.validators?.[name];
    validators.push(await executeExternal(name, external, { transaction, materialized, original, output: materialized.bytes }));
  }

  const failures = validators.filter((item) => item.status !== 'passed');
  const allExecuted = validators.every((item) => item.executed === true);
  const validation = {
    schemaVersion: REBUILD_VALIDATION_SCHEMA,
    transactionId: transaction.transactionId,
    sourceHash: transaction.sourceHash,
    outputHash: materialized.outputHash,
    requiredValidators: [...transaction.requiredValidators],
    validators,
    allRequiredExecuted: allExecuted,
    status: failures.length === 0 && allExecuted ? 'valid' : 'invalid',
    failures,
  };
  return deepFreeze({ ...validation, validationId: `rebuild-validation:${stableDigest(validation)}` });
}

export async function publishRebuildTransaction(materialized, validation, options = {}) {
  if (!materialized || materialized.status !== 'materialized') return { status: 'rejected', reason: 'rebuild-v2-materialization-not-complete' };
  if (!validation || validation.schemaVersion !== REBUILD_VALIDATION_SCHEMA || validation.status !== 'valid' || validation.allRequiredExecuted !== true) return { status: 'rejected', reason: 'rebuild-v2-validation-not-green' };
  if (validation.outputHash !== materialized.outputHash) return { status: 'rejected', reason: 'rebuild-v2-validation-output-mismatch' };
  if (typeof options.atomicPromote !== 'function') return { status: 'not-published', reason: 'rebuild-v2-atomic-promotion-required', outputHash: materialized.outputHash };
  try {
    const result = await options.atomicPromote(materialized.bytes, { materialized, validation });
    if (!result || result.atomic !== true || result.committed !== true) return { status: 'rejected', reason: 'rebuild-v2-publication-not-atomic' };
    const protocol = String(result.protocol || '');
    if (!ATOMIC_PUBLICATION_PROTOCOLS.has(protocol)) return { status: 'rejected', reason: 'rebuild-v2-publication-protocol-invalid' };
    const publicationIdentity = String(result.publicationIdentity || '').trim();
    if (!publicationIdentity) return { status: 'rejected', reason: 'rebuild-v2-publication-identity-required' };
    return deepFreeze({ status: 'published', atomic: true, committed: true, protocol, outputHash: materialized.outputHash, publicationIdentity, result: clone(result) });
  } catch (error) {
    return { status: 'rejected', reason: 'rebuild-v2-publication-failed', detail: String(error?.message || error) };
  }
}

export function rebuildProfileSupport({ transaction, validation, publication, proof = {} } = {}) {
  const requiredCount = transaction?.requiredValidators?.length || 0;
  const executedCount = validation?.validators?.filter((item) => item.executed === true && item.status === 'passed').length || 0;
  const formatProfileIds = sorted(proof.formatProfileIds);
  const formatCoverageComplete = proof.profileDenominatorComplete === true && formatProfileIds.length > 0;
  const exact = transaction?.schemaVersion === REBUILD_TRANSACTION_SCHEMA
    && validation?.schemaVersion === REBUILD_VALIDATION_SCHEMA
    && validation.status === 'valid'
    && validation.allRequiredExecuted === true
    && executedCount === requiredCount
    && publication?.status === 'published'
    && publication.atomic === true
    && publication.committed === true
    && ATOMIC_PUBLICATION_PROTOCOLS.has(publication.protocol)
    && !!publication.publicationIdentity
    && proof.exactHead === true
    && proof.negativeValidatorTest === true
    && proof.staleIdentityTest === true
    && proof.formatSpecificValidatorTests === true
    && proof.atomicInterruptionTest === true
    && proof.realFixture === true
    && formatCoverageComplete;
  return deepFreeze({
    format: transaction?.format || null,
    architecture: transaction?.architecture || null,
    operationClass: transaction?.sizeDelta === 0 ? 'same-size' : transaction?.sizeDelta > 0 ? 'growth' : 'shrink',
    requiredValidatorCount: requiredCount,
    executedValidatorCount: executedCount,
    formatProfileIds,
    formatCoverageComplete,
    status: exact ? 'supported-for-exact-rebuild-profile' : 'unsupported',
    authority: exact ? 'L4-validated-atomic-publication' : 'L3-plan-only',
  });
}
