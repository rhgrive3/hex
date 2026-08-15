const DEFAULT_ARRAY_LIMIT = 24;
const DEFAULT_STRING_LIMIT = 6000;

function arrayOf(value, keys) {
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function firstDefined(value, keys) {
  for (const key of keys) if (value?.[key] !== undefined) return value[key];
  return undefined;
}

export function boundedProjection(value, { depth = 0, arrayLimit = DEFAULT_ARRAY_LIMIT, stringLimit = DEFAULT_STRING_LIMIT, objectLimit = 64 } = {}) {
  if (depth > 6) return '[detailRef]';
  if (typeof value === 'string') return value.length > stringLimit ? `${value.slice(0, stringLimit)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map((item) => boundedProjection(item, { depth: depth + 1, arrayLimit, stringLimit, objectLimit }));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, objectLimit)) {
      out[key] = boundedProjection(item, { depth: depth + 1, arrayLimit, stringLimit, objectLimit });
    }
    return out;
  }
  return String(value);
}

export function completenessOf(result) {
  const explicit = result?.completeness && typeof result.completeness === 'object' ? result.completeness : null;
  const rows = arrayOf(result, ['results', 'functions', 'sites', 'updates', 'nodes', 'paths', 'blocks', 'callers', 'callees', 'observations', 'candidates']);
  const returned = Number(explicit?.returned ?? result?.returned ?? rows.length ?? 0);
  const totalValue = explicit?.total ?? result?.total;
  const total = totalValue == null ? (result?.truncated ? null : returned) : Math.max(0, Number(totalValue) || 0);
  const complete = explicit?.complete ?? result?.complete ?? !Boolean(result?.truncated);
  const coverageValue = explicit?.coverage ?? result?.coverage;
  const coverage = Number.isFinite(Number(coverageValue)) ? Math.max(0, Math.min(1, Number(coverageValue))) :
    (total != null && total > 0 ? Math.min(1, returned / total) : (complete ? 1 : null));
  const reason = explicit?.reason ?? result?.reason ?? (complete ? null : 'result-limit');
  return { complete: Boolean(complete), returned: Math.max(0, Number.isFinite(returned) ? returned : 0), total, coverage, reason };
}

function withEnvelope(data, meta = {}) {
  return {
    ...data,
    completeness: meta.completeness || completenessOf(meta.result),
    ...(meta.detailRef ? { detailRef: meta.detailRef } : {}),
    ...(meta.continuation?.cursor ? { continuation: { cursor: meta.continuation.cursor } } : {}),
    ...(Array.isArray(meta.evidenceIds) && meta.evidenceIds.length ? { evidenceIds: meta.evidenceIds.slice(0, 64) } : {}),
  };
}

function summaryOf(result) {
  return result?.summary ?? result?.message ?? null;
}

function topRows(result, keys, limit = DEFAULT_ARRAY_LIMIT) {
  return arrayOf(result, keys).slice(0, limit).map((row) => boundedProjection(row, { arrayLimit: 16, stringLimit: 1600, objectLimit: 48 }));
}

export function projectSearch(result, meta = {}) {
  const rows = topRows(result, ['results', 'functions', 'sites'], 24);
  return withEnvelope({
    query: result?.query,
    results: rows,
    ...(result?.scanned != null ? { scanned: result.scanned } : {}),
    ...(result?.scanTotal != null ? { scanTotal: result.scanTotal } : {}),
  }, { ...meta, result });
}

export function projectFunction(result, meta = {}) {
  return withEnvelope({
    address: result?.address ?? result?.functionAddress,
    name: result?.name,
    summary: boundedProjection(result?.summary ?? null, { arrayLimit: 16, stringLimit: 2500 }),
    instructions: result?.instructions,
    ...(result?.assemblyExcerpt != null ? { assemblyExcerpt: String(result.assemblyExcerpt).slice(0, 7000) } : {}),
    ...(result?.pseudocodeExcerpt != null ? { pseudocodeExcerpt: String(result.pseudocodeExcerpt).slice(0, 7000) } : {}),
    truncated: Boolean(result?.truncated),
  }, { ...meta, result });
}

export function projectSemanticFacts(result, meta = {}) {
  return withEnvelope({
    address: result?.address ?? result?.functionAddress,
    facts: topRows(result, ['results'], 32),
    engine: result?.engine,
  }, { ...meta, result });
}

export function projectVerification(result, meta = {}) {
  const paths = arrayOf(result, ['causalPaths', 'paths']).slice(0, 8).map((path) => {
    if (Array.isArray(path)) return path.slice(0, 32).map((node) => boundedProjection(node, { arrayLimit: 8, stringLimit: 800, objectLimit: 32 }));
    if (path && typeof path === 'object') {
      const out = boundedProjection(path, { arrayLimit: 24, stringLimit: 1200, objectLimit: 48 });
      if (Array.isArray(path.nodes)) out.nodes = path.nodes.slice(0, 32).map((node) => boundedProjection(node, { arrayLimit: 8, stringLimit: 800, objectLimit: 32 }));
      return out;
    }
    return path;
  });
  return withEnvelope({
    verified: Boolean(result?.verified),
    updates: topRows(result, ['updates', 'results'], 16),
    causalPaths: paths,
    source: boundedProjection(result?.source ?? result?.sourceValue ?? null, { arrayLimit: 8, stringLimit: 1200 }),
    sink: boundedProjection(result?.sink ?? result?.destination ?? result?.field ?? null, { arrayLimit: 8, stringLimit: 1200 }),
    engine: result?.engine,
  }, { ...meta, result });
}

export function projectObjcDispatch(result, meta = {}) {
  const resolved = firstDefined(result, ['resolved', 'target', 'resolvedTarget']);
  const candidates = topRows(result, ['candidates', 'results', 'targets'], 20);
  const requirements = boundedProjection(firstDefined(result, ['requirements', 'missingRequirements', 'missing']) ?? [], { arrayLimit: 20, stringLimit: 1600 });
  return withEnvelope({
    resolved: boundedProjection(resolved, { arrayLimit: 12, stringLimit: 2000 }),
    confidence: result?.confidence,
    candidates,
    totalCandidates: result?.totalCandidates ?? result?.total ?? candidates.length,
    requirements,
    ambiguity: boundedProjection(result?.ambiguity ?? null, { arrayLimit: 12, stringLimit: 1600 }),
  }, { ...meta, result });
}

export function projectSignature(result, meta = {}) {
  return withEnvelope({
    address: result?.address ?? result?.functionAddress,
    found: result?.found,
    signature: boundedProjection(result?.signature ?? result?.prototype ?? null, { arrayLimit: 16, stringLimit: 3000 }),
    source: result?.source,
    confidence: result?.confidence,
    alternatives: topRows(result, ['alternatives', 'candidates'], 12),
  }, { ...meta, result });
}

export function projectCompare(result, meta = {}) {
  return withEnvelope({
    left: boundedProjection(result?.left ?? null, { arrayLimit: 16, stringLimit: 2400 }),
    right: boundedProjection(result?.right ?? null, { arrayLimit: 16, stringLimit: 2400 }),
    similarity: firstDefined(result, ['similarity', 'instructionSimilarity', 'score']),
    instructionSimilarity: result?.instructionSimilarity,
    sameInstructionCount: result?.sameInstructionCount,
    summaryChanged: result?.summaryChanged,
    semanticDifferences: topRows(result, ['semanticDifferences', 'differences', 'changes'], 24),
    changedFields: topRows(result, ['changedFields', 'fields'], 20),
    changedCalls: topRows(result, ['changedCalls', 'calls'], 20),
    summary: boundedProjection(summaryOf(result), { arrayLimit: 20, stringLimit: 3000 }),
  }, { ...meta, result });
}

export function projectBinaryDiff(result, meta = {}) {
  const rows = topRows(result, ['results', 'functions', 'changes', 'matches'], 28);
  return withEnvelope({
    summary: boundedProjection(summaryOf(result), { arrayLimit: 20, stringLimit: 3000 }),
    results: rows,
    similarity: firstDefined(result, ['similarity', 'score']),
    changedFunctions: result?.changedFunctions ?? result?.changed ?? undefined,
    addedFunctions: result?.addedFunctions ?? result?.added ?? undefined,
    removedFunctions: result?.removedFunctions ?? result?.removed ?? undefined,
    left: boundedProjection(result?.left ?? null, { arrayLimit: 12, stringLimit: 1800 }),
    right: boundedProjection(result?.right ?? null, { arrayLimit: 12, stringLimit: 1800 }),
  }, { ...meta, result });
}

export function projectGraph(result, meta = {}) {
  const data = {
    address: result?.address ?? result?.functionAddress,
  };
  for (const key of ['results', 'functions', 'sites', 'callers', 'callees', 'nodes', 'blocks', 'paths', 'edges']) {
    if (Array.isArray(result?.[key])) data[key] = result[key].slice(0, key === 'edges' ? 40 : 28).map((row) => boundedProjection(row, { arrayLimit: 16, stringLimit: 1400, objectLimit: 48 }));
  }
  if (result?.from !== undefined) data.from = result.from;
  if (result?.to !== undefined) data.to = result.to;
  if (result?.view !== undefined) data.view = result.view;
  return withEnvelope(data, { ...meta, result });
}

function criticalSliceNode(node) {
  if (!node || typeof node !== 'object') return boundedProjection(node, { stringLimit: 600 });
  const out = {};
  for (const key of ['id', 'instructionId', 'address', 'op', 'kind', 'source', 'sink', 'condition', 'location', 'memory', 'call', 'callee', 'value', 'def', 'uses']) {
    if (node[key] !== undefined) out[key] = boundedProjection(node[key], { arrayLimit: 10, stringLimit: 900, objectLimit: 24 });
  }
  return Object.keys(out).length ? out : boundedProjection(node, { arrayLimit: 10, stringLimit: 900, objectLimit: 24 });
}

export function projectSlice(result, meta = {}) {
  const rows = arrayOf(result, ['nodes', 'results', 'path', 'paths']);
  return withEnvelope({
    source: boundedProjection(result?.source ?? null, { arrayLimit: 8, stringLimit: 1200 }),
    sink: boundedProjection(result?.sink ?? null, { arrayLimit: 8, stringLimit: 1200 }),
    criticalNodes: rows.slice(0, 32).map(criticalSliceNode),
    branchConditions: topRows(result, ['branchConditions', 'conditions'], 12),
    memoryAccesses: topRows(result, ['memoryAccesses', 'memory'], 12),
    callBoundaries: topRows(result, ['callBoundaries', 'calls'], 12),
  }, { ...meta, result });
}

export function projectSymbolic(result, meta = {}) {
  const paths = arrayOf(result, ['paths', 'results']).slice(0, 10).map((path) => ({
    ...(path?.id != null ? { id: path.id } : {}),
    ...(path?.returnValue !== undefined ? { returnValue: boundedProjection(path.returnValue, { stringLimit: 1200 }) } : {}),
    returnConstraints: boundedProjection(path?.returnConstraints ?? path?.returns ?? [], { arrayLimit: 16, stringLimit: 1200 }),
    writeConstraints: boundedProjection(path?.writeConstraints ?? path?.writes ?? [], { arrayLimit: 16, stringLimit: 1200 }),
    branchConstraints: boundedProjection(path?.branchConstraints ?? path?.constraints ?? [], { arrayLimit: 20, stringLimit: 1200 }),
    interesting: Boolean(path?.interesting),
  }));
  return withEnvelope({
    paths,
    status: result?.status,
    engine: result?.engine,
    truncated: Boolean(result?.truncated),
    reason: result?.reason,
  }, { ...meta, result });
}

export function projectDetail(result, meta = {}) {
  return withEnvelope({
    found: result?.found,
    evidenceId: result?.evidenceId,
    detailRef: result?.detailRef,
    origin: boundedProjection(result?.origin ?? null, { arrayLimit: 16, stringLimit: 1800 }),
    path: result?.path,
    record: boundedProjection(result?.record ?? null, { arrayLimit: 24, stringLimit: 3000, objectLimit: 64 }),
    semanticFact: boundedProjection(result?.semanticFact ?? null, { arrayLimit: 24, stringLimit: 3000, objectLimit: 64 }),
    relevantSourceRecords: boundedProjection(result?.relevantSourceRecords ?? result?.data ?? null, { arrayLimit: 40, stringLimit: 7000, objectLimit: 80 }),
    verification: boundedProjection(result?.verification ?? null, { arrayLimit: 16, stringLimit: 1800 }),
    navigation: boundedProjection(result?.navigation ?? null, { arrayLimit: 16, stringLimit: 1800 }),
  }, { ...meta, result });
}

export function projectRuntime(result, meta = {}) {
  return withEnvelope({ observations: topRows(result, ['observations', 'results'], 24), summary: boundedProjection(summaryOf(result), { stringLimit: 2500 }) }, { ...meta, result });
}

export function projectKnowledge(result, meta = {}) {
  return withEnvelope({
    found: result?.found,
    identity: boundedProjection(result?.identity ?? result?.knownFunction ?? result?.result ?? null, { arrayLimit: 16, stringLimit: 2400 }),
    confidence: result?.confidence,
    source: result?.source,
    alternatives: topRows(result, ['alternatives', 'candidates', 'matches'], 16),
  }, { ...meta, result });
}

export function projectBounded(result, meta = {}) {
  return withEnvelope(boundedProjection(result, { arrayLimit: 24, stringLimit: 6000, objectLimit: 80 }), { ...meta, result });
}
