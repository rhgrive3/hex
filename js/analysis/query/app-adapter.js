import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';
import { buildOverlay } from '../../narrate.js';
import { decompile } from '../../decompile.js';
import { inferTypes } from '../../types.js';
import { resolveABIPlugin } from '../../targets/abi/index.js';
import { riscvAbiFromElfFlags } from '../../targets/abi/riscv-lp64.js';
import { X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES } from '../../targets/architecture/x86_64/semantic-function-contract.js';

const QUERY_ROUTED_FETCH = Symbol('analysis-query-routed-fetch');
const QUERY_ROUTED_ANALYZE = Symbol('analysis-query-routed-analyze');
const MAX_PAGE = 5_000;
const MAX_FUNCTION_SCAN = 400_000;

function storeValue(app, key) {
  try { return typeof app?.store?.get === 'function' ? app.store.get(key) : (app?.store?.[key] ?? null); }
  catch { return null; }
}

function addressOf(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim().replace(/^(?:fn|function):/i, '');
    if (!text) return null;
    try { return BigInt(text); } catch { return null; }
  }
  if (value && typeof value === 'object') return addressOf(value.address ?? value.startAddress ?? value.startAddr ?? value.start ?? value.functionId ?? value.id);
  return null;
}

const functionId = (value) => value == null ? null : `0x${BigInt(value).toString(16)}`;

function pageOf(page = {}) {
  const rawOffset = Number(page.offset ?? page.start ?? 0);
  const rawLimit = Number(page.limit ?? page.size ?? 200);
  return {
    offset:Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
    limit:Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(MAX_PAGE, rawLimit) : 200,
  };
}

function unsupported(id, reason) {
  return { value:null, functionId:id, status:{ completeness:'unsupported', reason } };
}

function completenessOf(value, fallback = 'complete') {
  if (value?.status?.completeness) return value.status.completeness;
  if (value?.unsupported === true) return 'unsupported';
  if (value?.truncated === true) return 'truncated';
  if (value?.completeness?.complete === false || value?.complete === false || value?.partial === true) return 'partial';
  if (typeof value?.completeness === 'string') return value.completeness;
  return fallback;
}

function wrap(value, completeness = null, status = {}) {
  if (value == null) return null;
  return { value, status:{ ...status, completeness:completeness ?? completenessOf(value) } };
}

function paged(values, page, completeness = 'complete', status = {}) {
  const source = Array.from(values || []);
  const { offset, limit } = pageOf(page);
  const items = source.slice(offset, offset + limit);
  return {
    value:items,
    page:{ offset, limit, returned:items.length, total:source.length, next:offset + items.length < source.length ? offset + items.length : null },
    status:{ ...status, completeness, paged:true },
  };
}

function artifactVersions(app) {
  const value = app?.analysisArtifactVersions ?? app?.artifactVersions;
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function currentInfo(app) { return storeValue(app, 'fileInfo'); }
function currentSlice(app) {
  const index = Number(storeValue(app, 'sliceIndex') ?? -1);
  return index >= 0 ? currentInfo(app)?.slices?.[index] ?? null : null;
}
function architectureOf(app) {
  return String(storeValue(app, 'architecture') ?? storeValue(app, 'capability')?.architecture ?? currentSlice(app)?.capability?.architecture ?? '').toLowerCase();
}
function formatOf(app) { return String(app?.backend?.formatId ?? currentInfo(app)?.formatId ?? '').toLowerCase(); }
function executableRegion(app, address) {
  if (typeof app?.executableRegionFor === 'function') {
    try { return app.executableRegionFor(BigInt(address)); } catch { return null; }
  }
  const a = BigInt(address);
  return (storeValue(app, 'regions') || []).find((region) => {
    try { return region?.exec === true && a >= BigInt(region.vmAddr) && a < BigInt(region.vmAddr) + BigInt(region.size); }
    catch { return false; }
  }) ?? null;
}

function rangeFor(app, id) {
  const address = addressOf(id);
  if (address == null) return { ok:false, reason:'function-address-invalid' };
  if (typeof app?.validatedFunctionRange === 'function') {
    try {
      const live = app.validatedFunctionRange(address);
      if (live?.ok) {
        const fn = live.function ?? app?.symbols?.functionAt?.(address) ?? null;
        return fn?.end == null && live.complete !== false
          ? { ...live, complete:false, reason:live.reason || 'function-end-unproven' }
          : live;
      }
      if (live) return live;
    } catch { /* derive below */ }
  }
  const fn = app?.symbols?.functionAt?.(address);
  if (!fn) return { ok:false, reason:'function-symbol-missing' };
  const region = executableRegion(app, fn.start);
  if (!region) return { ok:false, reason:'function-start-not-executable', function:fn };
  const regionEnd = BigInt(region.vmAddr) + BigInt(region.size);
  let end = fn.end == null ? regionEnd : BigInt(fn.end);
  if (end <= fn.start) return { ok:false, reason:'invalid-function-range', function:fn, region };
  const crossed = end > regionEnd;
  if (crossed) end = regionEnd;
  return {
    ok:true, start:BigInt(fn.start), end, region, function:fn,
    complete:fn.end != null && !crossed,
    reason:fn.end == null ? 'function-end-unproven' : crossed ? 'symbol-range-crosses-executable-region' : null,
    provenance:'executable-region+symbol-boundary',
  };
}

function semanticIR(value) { return value?.pipeline?.semanticIr ?? value?.semanticAnalysis?.pipeline?.semanticIr ?? value?.semanticIR ?? null; }
function semanticCFG(value) { return value?.pipeline?.cfg ?? value?.semanticAnalysis?.pipeline?.cfg ?? value?.cfg ?? null; }

function normalizePlatform(value) {
  const p = String(value ?? '').trim().toLowerCase();
  if (!p) return null;
  if (p.includes('windows') || p === 'win32') return 'windows';
  if (p.includes('linux')) return 'linux';
  if (p.includes('freebsd')) return 'freebsd';
  if (p.includes('netbsd')) return 'netbsd';
  if (p.includes('openbsd')) return 'openbsd';
  if (p.includes('solaris')) return 'solaris';
  if (p.includes('system v') || p === 'sysv' || p.includes('unix')) return 'unix';
  return p;
}

function descriptorMetadata(app) {
  const slice = currentSlice(app);
  const descriptor = slice?.info?.descriptor ?? slice?.descriptor ?? currentInfo(app)?.productDescriptor ?? app?.backend?.platformInfo?.productDescriptor;
  return descriptor?.formatMetadata ?? {};
}

function applyLegacyPresentation(app, value) {
  if (!value?.model) return;
  const start = value.startAddr ?? value.startAddress ?? value.model?.startAddress;
  if (start == null) return;
  const region = executableRegion(app, start);
  if (!region) return;
  app.semantic = { regionId:region.id, model:value.model, result:value };
  if (storeValue(app, 'currentRegion') === region) {
    try { app.viewer?.setBlockOverlay?.(region.id, buildOverlay(value.model)); } catch { /* presentation only */ }
  }
}

function installRoutes(app, directFetch) {
  if (!app) return;
  if (typeof directFetch === 'function' && !app._fetchFunctionModel?.[QUERY_ROUTED_FETCH]) {
    const routedFunctionModel = async function routedFunctionModel(id, options = {}) {
      if (!app.analysisQueries) return directFetch(addressOf(id) ?? id, options);
      const snapshot = await app.analysisQueries.snapshot(options);
      const result = await app.analysisQueries.function(snapshot, id, options);
      if (result.completeness === 'unsupported' || result.value == null) {
        const error = new Error('analysis-query-function-unavailable');
        error.code = 'ANALYSIS_QUERY_FUNCTION_UNAVAILABLE';
        throw error;
      }
      return result.value;
    };
    Object.defineProperty(routedFunctionModel, QUERY_ROUTED_FETCH, { value:directFetch });
    app._fetchFunctionModel = routedFunctionModel;
  }
  const original = app.analyzeFunctionAt;
  if (typeof original === 'function' && !original?.[QUERY_ROUTED_ANALYZE]) {
    const routedAnalyzeFunctionAt = async function routedAnalyzeFunctionAt(id, options = {}) {
      if (!app.analysisQueries) return original.call(app, id, options);
      const snapshot = await app.analysisQueries.snapshot(options);
      const result = await app.analysisQueries.function(snapshot, id, options);
      if (result.completeness === 'unsupported' || result.value == null) return null;
      applyLegacyPresentation(app, result.value);
      return result.value;
    };
    Object.defineProperty(routedAnalyzeFunctionAt, QUERY_ROUTED_ANALYZE, { value:original.bind(app) });
    app.analyzeFunctionAt = routedAnalyzeFunctionAt;
  }
}

export function createAppAnalysisQueryAdapter(app) {
  const existingFetch = typeof app?._fetchFunctionModel === 'function' ? app._fetchFunctionModel : null;
  const directFetch = existingFetch?.[QUERY_ROUTED_FETCH] ?? (existingFetch ? existingFetch.bind(app) : null);
  let metadataEpoch = null;
  let metadataTask = null;

  const metadataSummary = () => {
    const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
    if (metadataEpoch === epoch && metadataTask) return metadataTask;
    metadataEpoch = epoch;
    metadataTask = typeof app?.backend?.binaryMetadata === 'function'
      ? Promise.resolve(app.backend.binaryMetadata('summary')).catch(() => null)
      : Promise.resolve(null);
    return metadataTask;
  };

  const abiFor = async (architecture) => {
    const descriptor = descriptorMetadata(app);
    const metadata = await metadataSummary();
    const explicit = descriptor.abi ?? metadata?.summary?.abi ?? metadata?.metadata?.abi ?? null;
    const bits = Number(descriptor.bits ?? metadata?.summary?.bits ?? 64);
    let platform = normalizePlatform(descriptor.platform ?? metadata?.summary?.platform);
    if (architecture === 'riscv64') {
      if (explicit) {
        const plugin = resolveABIPlugin({ architecture, platform:platform ?? 'unix', abiId:String(explicit) });
        return plugin?.supported ? { supported:true, abiId:plugin.id, platform:platform ?? 'unix', evidence:'explicit' } : { supported:false, reason:'riscv-explicit-abi-unsupported' };
      }
      const flags = metadata?.metadata?.flags;
      if (flags == null) return { supported:false, reason:'riscv-elf-flags-unavailable' };
      const selected = riscvAbiFromElfFlags(flags, { bits });
      return selected?.supported && selected.abiId
        ? { supported:true, abiId:selected.abiId, platform:platform ?? 'unix', evidence:'elf-e-flags' }
        : { supported:false, reason:selected?.reason || 'riscv-abi-unproven' };
    }
    if (architecture === 'x86_64') {
      platform ??= formatOf(app) === 'pe' ? 'windows' : formatOf(app) === 'elf' ? 'unix' : null;
      const plugin = resolveABIPlugin({ architecture, platform, ...(explicit ? { abiId:String(explicit) } : {}) });
      return plugin?.supported ? { supported:true, abiId:plugin.id, platform:platform ?? 'unknown', evidence:explicit ? 'explicit' : 'format-platform' } : { supported:false, reason:'x86-64-abi-unproven' };
    }
    return { supported:false, reason:`semantic-function-unsupported-architecture:${architecture || 'unknown'}` };
  };

  const produceFunction = async (id, options = {}) => {
    const range = rangeFor(app, id);
    if (!range.ok) return unsupported(id, range.reason || 'function-range-unavailable');
    const architecture = architectureOf(app);
    const symbols = app?.symbols;
    const name = symbols?.nameAt?.(range.start) ?? symbols?.label?.(range.start) ?? null;

    if (supportsArm64SemanticAnalysis(architecture)) {
      if (!app?.backend || !range.region || !storeValue(app, 'canDisassemble') || !symbols?.functionCount) return unsupported(id, 'arm64-function-producer-unavailable');
      const alignment = Number(storeValue(app, 'instructionAlignment') ?? storeValue(app, 'capability')?.instructionAlignment ?? 4);
      if (alignment !== 4) return unsupported(id, 'arm64-legacy-producer-requires-4-byte-instructions');
      const startRow = Number((range.start - BigInt(range.region.vmAddr)) / 4n);
      const maxRow = Math.max(0, Number(BigInt(range.region.size) / 4n) - 1);
      const endRow = Math.min(Number((range.end - BigInt(range.region.vmAddr) + 3n) / 4n) - 1, maxRow);
      if (startRow < 0 || endRow < startRow) return unsupported(id, 'function-range-empty');
      const value = await analyzeFunctionCached(app.backend, range.region, startRow, endRow, symbols, options.onProgress, options);
      const completeness = value?.truncated ? 'truncated' : range.complete === false ? 'partial' : 'complete';
      const enriched = {
        ...value, functionId:functionId(range.start), architectureId:architecture,
        startAddress:range.start, endAddress:range.end, name,
        completeness:{ complete:completeness === 'complete', reason:value?.truncated ? 'analysis-budget' : range.reason || null, provenance:range.provenance, regionId:range.region.id },
      };
      return wrap(enriched, completeness, { reason:enriched.completeness.reason, architecture, producer:'legacy-arm64-compatibility' });
    }

    if (!['x86_64', 'riscv64'].includes(architecture) || typeof app?.backend?.analyzeSemanticFunction !== 'function') {
      return unsupported(id, `function-analysis-unsupported-architecture:${architecture || 'unknown'}`);
    }
    const span = range.end - range.start;
    if (span <= 0n) return unsupported(id, 'function-range-empty');
    const budgeted = span > BigInt(X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES);
    const length = Number(budgeted ? BigInt(X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES) : span);
    const abi = await abiFor(architecture);
    if (!abi.supported) return unsupported(id, abi.reason);
    const sliceIndex = Math.max(0, Number(storeValue(app, 'sliceIndex') ?? 0));
    const requestedCompleteness = budgeted || range.complete === false ? 'partial' : 'complete';
    const canonical = await app.backend.analyzeSemanticFunction({
      address:range.start, length, architecture, abiId:abi.abiId, platform:abi.platform, sliceIndex,
      name:name ?? undefined, completeness:requestedCompleteness, signal:options.signal ?? null,
      onIdentityProgress:options.onIdentityProgress ?? options.onProgress,
    });
    const completeness = budgeted ? 'truncated' : range.complete === false ? 'partial' : completenessOf(canonical);
    return wrap({
      ...canonical, functionId:functionId(range.start), startAddress:range.start,
      endAddress:range.start + BigInt(length), requestedEndAddress:range.end, name,
      truncated:budgeted, complete:completeness === 'complete',
    }, completeness, {
      reason:budgeted ? 'semantic-function-decode-budget' : range.reason || null,
      architecture, abiId:abi.abiId, abiEvidence:abi.evidence, producer:'canonical-semantic-function',
    });
  };

  const loadFunction = async (id, options = {}) => {
    if (typeof app?.analyzeFunction === 'function') {
      const value = await app.analyzeFunction(id, options);
      if (value != null) return wrap(value);
    }
    if (directFetch) {
      const value = await directFetch(addressOf(id) ?? id, options);
      if (value != null) return wrap(value);
    }
    return produceFunction(id, options);
  };

  const adapter = {
    async currentIdentity(options = {}) {
      if (options.signal?.aborted) {
        const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('AbortError');
        error.name = 'AbortError';
        throw error;
      }
      const fileInfo = currentInfo(app);
      const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
      let binaryId = app?.backend?.binaryId ?? fileInfo?.binaryId ?? fileInfo?.sha256 ?? fileInfo?.hash ?? project?.binaryHash ?? project?.binary?.hash ?? null;
      if (!binaryId && typeof app?.backend?.ensureBinaryId === 'function') {
        try { binaryId = await app.backend.ensureBinaryId({ signal:options.signal ?? null, onProgress:options.onIdentityProgress ?? options.onProgress }); }
        catch (error) { if (options.signal?.aborted || error?.name === 'AbortError' || error?.stale) throw error; }
      }
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
        try { binaryId = await app.ensureAnalysisIdentity(); } catch { /* fail below */ }
      }
      if (!binaryId) {
        const error = new Error('analysis-query-binary-unbound');
        error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
        throw error;
      }
      const projectRevision = Number(project?.revision ?? app?.projectRevision ?? app?.workspace?.bindingRevision ?? 0);
      const analysisEpoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      return { binaryId:String(binaryId), projectRevision:Number.isFinite(projectRevision) ? projectRevision : 0, artifactVersions:artifactVersions(app), analysisEpoch:Number.isFinite(analysisEpoch) ? analysisEpoch : 0 };
    },

    async binaryInfo(snapshot) {
      const info = currentInfo(app);
      const slice = currentSlice(app);
      const value = {
        binaryId:snapshot.binaryId, name:info?.name ?? storeValue(app, 'file')?.name ?? null,
        size:info?.size ?? storeValue(app, 'file')?.size ?? null,
        formatId:formatOf(app) || (info?.format ?? null), architecture:architectureOf(app) || null,
        sliceIndex:Number(storeValue(app, 'sliceIndex') ?? -1),
        capability:storeValue(app, 'capability') ?? slice?.capability ?? info?.capability ?? null,
        regions:(storeValue(app, 'regions') || []).map((r) => ({ id:r.id, name:r.name ?? null, section:r.section ?? null, vmAddr:r.vmAddr, size:r.size, exec:r.exec === true, read:r.read === true, write:r.write === true })),
      };
      return wrap(value, info ? 'complete' : 'partial', { reason:info ? null : 'file-info-unavailable' });
    },

    async functions(_snapshot, query = {}, page = {}, options = {}) {
      const symbols = app?.symbols;
      if (!symbols?.funcs) return unsupported(null, 'function-index-unavailable');
      const needle = String(query.text ?? query.name ?? '').trim().toLowerCase();
      const exactAddress = addressOf(query.address);
      const count = Math.min(symbols.funcs.length, MAX_FUNCTION_SCAN);
      const rows = [];
      for (let i = 0; i < count; i++) {
        if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('AbortError'), { name:'AbortError' });
        const address = BigInt(symbols.funcs[i]);
        const name = symbols.nameAt?.(address) ?? null;
        if (exactAddress != null && address !== exactAddress) continue;
        if (needle && !String(name ?? '').toLowerCase().includes(needle) && !address.toString(16).includes(needle.replace(/^0x/, ''))) continue;
        const fn = symbols.functionAt?.(address);
        rows.push({ id:functionId(address), address, name, end:fn?.end ?? null, size:fn?.end != null ? fn.end - address : null, evidence:symbols.functionEvidence?.(address) ?? null });
      }
      const complete = symbols.functionStartsComplete === true && count === symbols.funcs.length;
      return paged(rows, page, complete ? 'complete' : 'partial', { reason:complete ? null : count < symbols.funcs.length ? 'function-scan-budget' : 'function-discovery-incomplete' });
    },

    async functionById(_snapshot, id, options = {}) { return loadFunction(id, options); },

    async instructions(_snapshot, range, page = {}, options = {}) {
      const request = range && typeof range === 'object' ? range : { functionId:range };
      let start = addressOf(request.start ?? request.address);
      let end = addressOf(request.end);
      if (start == null && request.functionId != null) {
        const fnRange = rangeFor(app, request.functionId);
        if (!fnRange.ok) return unsupported(request.functionId, fnRange.reason);
        start = fnRange.start;
        end = fnRange.end;
      }
      if (start == null) return unsupported(null, 'instruction-range-start-required');
      let length = Number(request.length ?? (end == null ? 4096n : end - start));
      if (!Number.isSafeInteger(length) || length <= 0) return unsupported(null, 'instruction-range-invalid');
      const truncated = length > 1024 * 1024;
      length = Math.min(length, 1024 * 1024);
      if (typeof app?.backend?.disassembleAt === 'function') {
        const decoded = await app.backend.disassembleAt(start, { architecture:architectureOf(app), length, signal:options.signal ?? null });
        if (decoded?.supported && decoded?.found) {
          const rows = (decoded.instructions || []).map((insn, i) => ({ id:insn.instructionId ?? `${functionId(insn.address ?? start)}:${i}`, address:insn.address == null ? null : BigInt(insn.address), size:Number(insn.length ?? insn.size ?? 0), mnemonic:String(insn.mnemonic ?? insn.instructionFamily ?? ''), operands:String(insn.opStr ?? insn.operands ?? ''), raw:insn }));
          return paged(rows, page, truncated ? 'truncated' : 'complete', { reason:truncated ? 'instruction-read-budget' : null });
        }
      }
      const result = await loadFunction(request.functionId ?? start, options);
      const rows = result?.value?.model?.instructions;
      return rows ? paged(rows, page, result.status?.completeness ?? completenessOf(result.value)) : unsupported(request.functionId ?? start, 'instruction-producer-unavailable');
    },

    async semanticIR(_snapshot, id, options = {}) {
      if (typeof app?.getSemanticIR === 'function') {
        const value = await app.getSemanticIR(id, options);
        if (value != null) return wrap(value);
      }
      const result = await loadFunction(id, options);
      const value = semanticIR(result?.value);
      return value == null ? unsupported(id, result?.value ? 'semantic-ir-v2-unavailable' : 'function-producer-unavailable') : wrap(value, result.status?.completeness);
    },

    async cfg(_snapshot, id, options = {}) {
      if (typeof app?.getCFG === 'function') {
        const value = await app.getCFG(id, options);
        if (value != null) return wrap(value);
      }
      const result = await loadFunction(id, options);
      const value = semanticCFG(result?.value);
      return value == null ? unsupported(id, result?.value ? 'cfg-unavailable' : 'function-producer-unavailable') : wrap(value, result.status?.completeness);
    },

    async callers(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id);
      if (address == null || typeof app?.ensureProgram !== 'function') return unsupported(id, 'program-index-unavailable');
      const program = await app.ensureProgram(options.onProgress);
      if (!program?.callersOf) return unsupported(id, 'program-index-unavailable');
      const { offset, limit } = pageOf(page);
      const source = program.callersOf(address, Math.min(MAX_PAGE, offset + limit));
      return paged(Array.from(source || []), page, source?.complete === false ? 'partial' : 'complete', { reason:source?.incompleteReason ?? null });
    },

    async callees(_snapshot, id, page = {}, options = {}) {
      const range = rangeFor(app, id);
      if (!range.ok || typeof app?.ensureProgram !== 'function') return unsupported(id, range.reason || 'program-index-unavailable');
      const program = await app.ensureProgram(options.onProgress);
      if (!program?.calleesOf) return unsupported(id, 'program-index-unavailable');
      const { offset, limit } = pageOf(page);
      const source = program.calleesOf(range.start, range.end, Math.min(MAX_PAGE, offset + limit));
      return paged(Array.from(source || []), page, source?.complete === false ? 'partial' : 'complete', { reason:source?.incompleteReason ?? null });
    },

    async xrefs(_snapshot, id, page = {}, options = {}) {
      const address = addressOf(id);
      if (address == null || typeof app?.ensureProgram !== 'function') return unsupported(id, 'program-index-unavailable');
      const program = await app.ensureProgram(options.onProgress);
      if (!program) return unsupported(id, 'program-index-unavailable');
      const { offset, limit } = pageOf(page);
      const cap = Math.min(MAX_PAGE, offset + limit);
      const refs = program.refSitesTo?.(address, 1n, cap) || [];
      const calls = program.callSitesTo?.(address, cap) || [];
      const rows = [
        ...Array.from(refs).map((x) => ({ kind:'reference', site:x.site, target:x.target, refKind:x.kind ?? null })),
        ...Array.from(calls).map((x) => ({ kind:'call', site:x.site, target:address, caller:x.caller ?? null })),
      ].sort((a, b) => BigInt(a.site) < BigInt(b.site) ? -1 : BigInt(a.site) > BigInt(b.site) ? 1 : 0);
      const complete = refs.complete !== false && calls.complete !== false;
      return paged(rows, page, complete ? 'complete' : 'partial', { reason:refs.incompleteReason ?? calls.incompleteReason ?? null });
    },

    async types(_snapshot, scope, _page = {}, options = {}) {
      if (typeof app?.getTypes === 'function') {
        const value = await app.getTypes(scope, options);
        if (value != null) return wrap(value);
      }
      const id = scope?.functionId ?? scope?.address ?? scope;
      const result = await loadFunction(id, options);
      const model = result?.value?.model;
      return model ? wrap(inferTypes(model), result.status?.completeness, { inference:true }) : unsupported(id, 'typed-function-projection-unavailable');
    },

    async evidence(_snapshot, query = {}, page = {}, options = {}) {
      if (typeof app?.getEvidence === 'function') {
        const value = await app.getEvidence(query, options);
        return value == null ? unsupported(query?.functionId ?? null, 'evidence-store-unavailable') : paged(Array.isArray(value) ? value : [value], page);
      }
      const rows = [...(app?.autoReport?.report?.deep || [])];
      if (query.functionId != null) {
        const result = await loadFunction(query.functionId, options);
        for (const evidence of result?.value?.decompiler?.evidence || []) rows.push({ kind:'decompiler', functionId:query.functionId, evidence });
      }
      return rows.length ? paged(rows, page, app?.autoReport?.report?.truncated ? 'partial' : 'complete') : unsupported(query?.functionId ?? null, 'evidence-store-unavailable');
    },

    async decompile(_snapshot, id, options = {}) {
      if (typeof app?.getDecompile === 'function') {
        const value = await app.getDecompile(id, options);
        if (value != null) return wrap(value);
      }
      const result = await loadFunction(id, options);
      if (result?.value?.decompiler) return wrap(result.value.decompiler, result.status?.completeness);
      if (!result?.value?.model) return unsupported(id, 'decompiler-projection-unavailable');
      const address = addressOf(id) ?? result.value.startAddr ?? result.value.startAddress;
      return wrap(decompile(result.value.model, { name:address == null ? null : app?.symbols?.nameAt?.(address), addr:address }), result.status?.completeness);
    },

    async search(_snapshot, query, page = {}, options = {}) {
      if (typeof app?.querySearch === 'function') {
        const value = await app.querySearch(query, options);
        return paged(Array.isArray(value) ? value : value?.results || [], page, completenessOf(value));
      }
      if (!query || typeof query !== 'object' || typeof app?.backend?.search !== 'function') return unsupported(null, 'typed-search-producer-unavailable');
      const value = await app.backend.search(query, options.onProgress);
      return paged(value?.results || [], page, value?.capped || value?.cancelled ? 'partial' : 'complete', { reason:value?.cancelled ? 'cancelled' : value?.capped ? 'search-result-cap' : null });
    },

    async causalPath(_snapshot, source, sink, options = {}) {
      return typeof app?.queryCausalPath === 'function' ? wrap(await app.queryCausalPath(source, sink, options)) : unsupported(source?.functionId ?? source ?? null, 'causal-path-producer-unavailable');
    },
  };

  installRoutes(app, directFetch);
  return adapter;
}
