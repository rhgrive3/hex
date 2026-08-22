import { addressText } from '../validation.js';

let turnSequence = 1;

export function createTurnSnapshot(local = {}, request = {}) {
  const current = first(local.currentAddress, local.activeFunction?.address, local.currentFunction?.address);
  const range = resolveFunctionRange(local, current);
  const selection = snapshotSelection(local.selection);
  const identity = resolveBinaryIdentity(local, request);
  const projectId = first(request.projectId, local.projectId, local.project?.id, local.project?.binaryHash);
  const runtimeId = first(local.runtimeSession?.id, local.runtime?.sessionId, local.runtimeSessionId);
  const runtimeKnown = local.runtimeSessionKnown === true || runtimeId != null;
  const requestedScope = String(request.scope || 'auto');
  return deepFreeze({
    id: `turn_${Date.now().toString(36)}_${turnSequence++}`,
    createdAt: new Date().toISOString(),
    binaryIdentity: identity,
    binaryId: identity.id,
    legacyBinaryId: identity.legacyId,
    projectIdentity: projectId == null ? null : String(projectId),
    architecture: copyScalar(first(local.architecture, local.binary?.architecture, local.capability?.architecture)),
    slice: copyScalar(first(local.slice, local.sliceIndex, local.binary?.sliceIndex)),
    currentFunction: current == null ? null : {
      address: addressText(current),
      range,
      name: first(local.activeFunction?.name, local.currentFunction?.name, safeName(local, current)),
    },
    selection,
    runtimeSessionIdentity: runtimeId == null ? null : String(runtimeId),
    runtimeSessionState: runtimeKnown ? (runtimeId == null ? 'none' : 'bound') : 'unknown',
    requestedScope,
    capabilities: snapshotCapabilities(local),
    neighborhood: snapshotNeighborhood(local, current),
  });
}

export function createSnapshotContext(local = {}, snapshot, scopeController = null) {
  const frozen = {};
  for (const key of Reflect.ownKeys(local)) {
    try {
      Object.defineProperty(frozen, key, {
        value:local[key], enumerable:true, configurable:true, writable:true,
      });
    } catch { /* best-effort capability capture */ }
  }
  frozen.turnSnapshot = snapshot;
  frozen.binaryIdentity = snapshot.binaryIdentity;
  frozen.binaryId = snapshot.binaryId;
  frozen.projectId = snapshot.projectIdentity;
  frozen.currentAddress = parseAddress(snapshot.currentFunction?.address);
  frozen.activeFunction = snapshot.currentFunction ? {
    address: parseAddress(snapshot.currentFunction.address),
    name: snapshot.currentFunction.name,
    start: parseAddress(snapshot.currentFunction.range?.start),
    end: parseAddress(snapshot.currentFunction.range?.end),
  } : null;
  frozen.currentFunction = frozen.activeFunction;
  frozen.selection = snapshot.selection;
  if (scopeController) {
    frozen.scopeAllowsTool = (scope, tool, args) => scopeController.scopeAllowsTool(scope, tool, args);
    frozen.scopeContainsAddress = (scope, address) => scopeController.scopeContainsAddress(scope, address);
    frozen.scopeContainsFunction = (scope, address) => scopeController.scopeContainsFunction(scope, address);
  }
  return Object.freeze(frozen);
}

export function resolveBinaryIdentity(local = {}, request = {}) {
  const explicit = normalizeIdentity(request.binaryIdentity ?? local.binaryIdentity);
  if (explicit) return explicit;
  const contentHash = first(
    request.binaryHash,
    local.binaryHash,
    local.binaryFingerprint?.hash,
    local.fingerprint?.hash,
    local.binary?.fingerprint?.hash,
    local.project?.binaryHash,
  );
  const legacyId = first(request.binaryId, local.binaryId);
  if (contentHash != null && String(contentHash)) {
    const slice = first(local.sliceIndex, local.slice, local.binary?.sliceIndex);
    const suffix = slice == null ? '' : `:${String(slice)}`;
    return {
      id: `content:${String(contentHash)}${suffix}`,
      kind: 'content-derived',
      confidence: 'strong',
      state: 'ready',
      algorithm: first(local.binaryFingerprint?.algorithm, local.fingerprint?.algorithm, 'existing-hash'),
      hash: String(contentHash),
      legacyId: legacyId == null ? null : String(legacyId),
    };
  }
  const name = first(local.fileInfo?.name, local.binary?.name);
  const slice = first(local.sliceIndex, local.slice, local.binary?.sliceIndex);
  const fallback = legacyId != null ? String(legacyId) : (name ? `${name}:${String(slice ?? 0)}` : null);
  return {
    id: fallback ? `fallback:${fallback}` : 'fallback:unbound',
    kind: 'fallback', confidence: fallback ? 'weak' : 'none', state: 'hash-unavailable',
    algorithm: null, hash: null, legacyId: fallback,
  };
}

function normalizeIdentity(value) {
  if (!value) return null;
  if (typeof value === 'string') return { id: value, kind: 'external', confidence: 'strong', state: 'ready', algorithm: null, hash: null, legacyId: null };
  if (typeof value !== 'object' || !value.id) return null;
  return {
    id: String(value.id), kind: String(value.kind || 'external'), confidence: String(value.confidence || 'strong'),
    state: String(value.state || 'ready'), algorithm: value.algorithm == null ? null : String(value.algorithm),
    hash: value.hash == null ? null : String(value.hash), legacyId: value.legacyId == null ? null : String(value.legacyId),
  };
}

function resolveFunctionRange(local, current) {
  if (current == null) return null;
  let range = null;
  try {
    // Prefer an exact function boundary source over ProgramIndex.functionRange.
    // ProgramIndex intentionally falls back to the executable region end when
    // an exact end is unknown; using that fallback for AI scope=function would
    // silently widen one function to the remainder of the region.
    range = local.functionRange?.(current) || local.symbols?.functionAt?.(current) || local.program?.functionRange?.(current) || null;
  } catch { /* optional */ }
  const start = first(range?.start, range?.address, range?.startAddr, local.activeFunction?.start, local.currentFunction?.start, current);
  const end = first(range?.end, range?.endAddr, local.activeFunction?.end, local.currentFunction?.end);
  return { start: addressText(start), end: addressText(end) };
}

function snapshotSelection(value) {
  if (!value) return null;
  const instructions = Array.isArray(value.instructions) ? value.instructions.slice(0, 80).map((item) => ({
    address: addressText(item?.address), mnemonic: String(item?.mnemonic || ''), operands: String(item?.operands || ''),
  })) : [];
  const start = addressText(first(value.start, instructions[0]?.address));
  const end = addressText(first(value.end, instructions[instructions.length - 1]?.address, start));
  return deepFreeze({ start, end, instructions, truncated: !!value.truncated || (Array.isArray(value.instructions) && value.instructions.length > 80) });
}

function snapshotCapabilities(local) {
  const source = local.capabilities || local.capability || {};
  const out = {};
  for (const key of ['canDisassemble', 'architecture', 'instructionAlignment', 'runtime', 'project', 'knowledge', 'semanticIR']) {
    const value = source[key] ?? local[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

function snapshotNeighborhood(local, current) {
  const raw = local.allowedNeighborhood || local.neighborhood || [];
  const addresses = new Set();
  if (current != null) addresses.add(addressText(current));
  for (const item of Array.isArray(raw) ? raw.slice(0, 256) : []) {
    const value = item?.address ?? item?.start ?? item;
    const text = addressText(value);
    if (text) addresses.add(text);
  }
  return Array.from(addresses);
}

function safeName(local, address) { try { return local.functionName?.(address) || null; } catch { return null; } }
function copyScalar(value) { return ['string', 'number', 'boolean'].includes(typeof value) ? value : value == null ? null : String(value); }
function first(...values) { return values.find((value) => value !== undefined && value !== null) ?? null; }
function parseAddress(value) { try { return value == null ? null : BigInt(value); } catch { return value; } }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
