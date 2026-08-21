import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';
import { buildOverlay } from '../../narrate.js';
import { decompile } from '../../decompile.js';
import { inferTypes } from '../../types.js';
import { resolveABIPlugin } from '../../targets/abi/index.js';
import { riscvAbiFromElfFlags } from '../../targets/abi/riscv-lp64.js';
import { X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES } from '../../targets/architecture/x86_64/semantic-function-contract.js';

const QUERY_ROUTED_FETCH = Symbol('analysis-query-routed-fetch');
const QUERY_ROUTED_ANALYZE = Symbol('analysis-query-routed-analyze');
const MAX_FUNCTION_SCAN = 400_000;
const MAX_PAGE_LIMIT = 5_000;
const DEFAULT_PAGE_LIMIT = 200;

function storeValue(app, key) {
  try {
    if (typeof app?.store?.get === 'function') return app.store.get(key);
  } catch { /* fall through to compatibility-shaped state */ }
  return app?.store?.[key] ?? null;
}

function normalizeAddress(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string') {
    const text = value.trim().replace(/^(?:fn|function):/i, '');
    if (!text) return null;
    try { return BigInt(text); } catch { return null; }
  }
  if (value && typeof value === 'object') {
    return normalizeAddress(value.address ?? value.startAddress ?? value.startAddr ?? value.start ?? value.functionId ?? value.id);
  }
  return null;
}

function functionIdOf(address) {
  return address == null ? null : `0x${BigInt(address).toString(16)}`;
}

function pageSpec(input = {}, defaults = {}) {
  const rawOffset = Number(input?.offset ?? input?.start ?? 0);
  const rawLimit = Number(input?.limit ?? input?.size ?? defaults.limit ?? DEFAULT_PAGE_LIMIT);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0
    ? Math.min(MAX_PAGE_LIMIT, rawLimit)
    : Math.min(MAX_PAGE_LIMIT, defaults.limit ?? DEFAULT_PAGE_LIMIT);
  return { offset, limit };
}

function unsupported(functionId, reason, detail = null) {
  return {
    value: null,
    functionId,
    status: {
      completeness: 'unsupported',
      reason,
      ...(detail == null ? {} : { detail }),
    },
  };
}

function completenessOf(value, fallbackCompleteness = 'complete') {
  if (value?.status?.completeness != null) return value.status.completeness;
  if (value?.completeness?.complete === false) return value?.truncated === true ? 'truncated' : 'partial';
  if (typeof value?.completeness === 'string') return value.completeness;
  if (value?.unsupported === true) return 'unsupported';
  if (value?.truncated === true) return 'truncated';
  if (value?.partial === true || value?.complete === false) return 'partial';
  return fallbackCompleteness;
}

function wrappedValue(value, fallbackCompleteness = 'complete', status = {}) {
  if (value == null) return null;
  return {
    value,
    status: {
      ...status,
      completeness: status.completeness ?? completenessOf(value, fallbackCompleteness),
    },
  };
}

function semanticIRFromModel(model) {
  return model?.pipeline?.semanticIr
    ?? model?.semanticAnalysis?.pipeline?.semanticIr
    ?? model?.semanticIR
    ?? null;
}

function cfgFromModel(model) {
  return model?.pipeline?.cfg
    ?? model?.semanticAnalysis?.pipeline?.cfg
    ?? model?.cfg
    ?? null;
}

function artifactVersionsFor(app) {
  const direct = app?.analysisArtifactVersions ?? app?.artifactVersions ?? null;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { ...direct };
  return {};
}

function currentFileInfo(app) {
  return storeValue(app, 'fileInfo') ?? null;
}

function currentSlice(app, fileInfo = currentFileInfo(app)) {
  const index = Number(storeValue(app, 'sliceIndex') ?? -1);
  return index >= 0 ? fileInfo?.slices?.[index] ?? null : null;
}

function liveArchitecture(app) {
  return String(
    storeValue(app, 'architecture')
    ?? storeValue(app, 'capability')?.architecture
    ?? currentSlice(app)?.capability?.architecture
    ?? currentSlice(app)?.info?.architecture
    ?? '',
  ).toLowerCase();
}

function executableRegionFor(app, address) {
  if (typeof app?.executableRegionFor === 'function') {
    try { return app.executableRegionFor(BigInt(address)); } catch { return null; }
  }
  const target = BigInt(address);
  return (storeValue(app, 'regions') || []).find((region) => {
    try {
      return region?.exec === true && target >= BigInt(region.vmAddr) && target < BigInt(region.vmAddr) + BigInt(region.size);
    } catch { return false; }
  }) ?? null;
}

function validatedRangeFor(app, functionId) {
  const address = normalizeAddress(functionId);
  if (address == null) return { ok:false, reason:'function-address-invalid' };
  if (typeof app?.validatedFunctionRange === 'function') {
    try {
      const range = app.validatedFunctionRange(address);
      if (range?.ok) return range;
      if (range) return range;
    } catch { /* derive below */ }
  }
  const fn = app?.symbols?.functionAt?.(address) ?? null;
  if (!fn) return { ok:false, reason:'function-symbol-missing' };
  const region = executableRegionFor(app, fn.start);
  if (!region) return { ok:false, reason:'function-start-not-executable', function:fn };
  const regionEnd = BigInt(region.vmAddr) + BigInt(region.size);
  let end = fn.end == null ? regionEnd : BigInt(fn.end);
  let complete = fn.end != null;
  let reason = fn.end == null ? 'function-end-inferred-from-executable-region' : null;
  if (end <= fn.start) return { ok:false, reason:'invalid-function-range', function:fn, region };
  if (end > regionEnd) {
    end = regionEnd;
    complete = false;
    reason = 'symbol-range-crosses-executable-region';
  }
  return {
    ok:true,
    start:BigInt(fn.start),
    end,
    region,
    function:fn,
    complete,
    reason,
    provenance:'executable-region+symbol-boundary',
  };
}

function formatIdFor(app) {
  return String(app?.backend?.formatId ?? currentFileInfo(app)?.formatId ?? '').toLowerCase();
}

function normalizePlatform(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('windows') || text === 'win32') return 'windows';
  if (text.includes('linux')) return 'linux';
  if (text.includes('freebsd')) return 'freebsd';
  if (text.includes('netbsd')) return 'netbsd';
  if (text.includes('openbsd')) return 'openbsd';
  if (text.includes('solaris')) return 'solaris';
  if (text.includes('darwin') || text.includes('macos') || text.includes('ios')) return 'darwin';
  if (text.includes('system v') || text === 'sysv' || text.includes('unix')) return 'unix';
  return text;
}

function descriptorMetadata(app) {
  const info = currentFileInfo(app);
  const slice = currentSlice(app, info);
  const descriptor = slice?.info?.descriptor
    ?? slice?.descriptor
    ?? info?.productDescriptor
    ?? app?.backend?.platformInfo?.productDescriptor
    ?? null;
  return descriptor?.formatMetadata ?? {};
}

function sourceCompleteness(array, fallback = 'complete') {
  if (array?.unsupported === true) return 'unsupported';
  if (array?.complete === false || array?.capped === true || array?.queryLimited === true) return 'partial';
  return fallback;
}

function pageArray(values, page, completeness = 'complete', status = {}) {
  const { offset, limit } = pageSpec(page);
  const source = Array.isArray(values) ? values : [];
  const items = source.slice(offset, offset + limit);
  const next = offset + items.length < source.length ? offset + items.length : null;
  return {
    value: items,
    page: Object.freeze({ offset, limit, returned:items.length, total:source.length, next }),
    status: {
      ...status,
      completeness,
      paged:true,
    },
  };
}

function applyLegacyPresentation(app, value) {
  if (!value?.model) return;
  const start = value.startAddr ?? value.startAddress ?? value.model?.startAddress ?? null;
  if (start == null) return;
  const region = executableRegionFor(app, start);
  if (!region) return;
  app.semantic = { regionId:region.id, model:value.model, result:value };
  if (storeValue(app, 'currentRegion') === region) {
    try { app.viewer?.setBlockOverlay?.(region.id, buildOverlay(value.model)); } catch { /* presentation is best effort */ }
  }
}

function installFunctionQueryRoutes(app, directFetch) {
  if (!app) return;

  if (typeof directFetch === 'function') {
    const current = app._fetchFunctionModel;
    if (!current?.[QUERY_ROUTED_FETCH]) {
      const routed = async function routedFunctionModel(functionId, options = {}) {
        const queries = app.analysisQueries;
        if (!queries || typeof queries.snapshot !== 'function' || typeof queries.function !== 'function') {
          return directFetch(normalizeAddress(functionId) ?? functionId, options);
        }
        const snapshot = await queries.snapshot(options);
        const result = await queries.function(snapshot, functionId, options);
        if (result.completeness === 'unsupported' || result.value == null) {
          const error = new Error('analysis-query-function-unavailable');
          error.code = 'ANALYSIS_QUERY_FUNCTION_UNAVAILABLE';
          throw error;
        }
        return result.value;
      };
      Object.defineProperty(routed, QUERY_ROUTED_FETCH, { value:directFetch });
      app._fetchFunctionModel = routed;
    }
  }

  const currentAnalyze = app.analyzeFunctionAt;
  if (typeof currentAnalyze === 'function' && !currentAnalyze?.[QUERY_ROUTED_ANALYZE]) {
    const routed = async function routedAnalyzeFunctionAt(functionId, options = {}) {
      const queries = app.analysisQueries;
      if (!queries || typeof queries.snapshot !== 'function' || typeof queries.function !== 'function') {
        return currentAnalyze.call(app, functionId, options);
      }
      const snapshot = await queries.snapshot(options);
      const result = await queries.function(snapshot, functionId, options);
      if (result.completeness === 'unsupported' || result.value == null) return null;
      applyLegacyPresentation(app, result.value);
      return result.value;
    };
    Object.defineProperty(routed, QUERY_ROUTED_ANALYZE, { value:currentAnalyze.bind(app) });
    app.analyzeFunctionAt = routed;
  }
}

export function createAppAnalysisQueryAdapter(app) {
  const existingFetch = typeof app?._fetchFunctionModel === 'function' ? app._fetchFunctionModel : null;
  const directFetch = existingFetch?.[QUERY_ROUTED_FETCH]
    ?? (existingFetch ? existingFetch.bind(app) : null);

  let metadataEpoch = null;
  let metadataPromise = null;
  const metadataSummary = async (options = {}) => {
    const epoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
    if (metadataEpoch === epoch && metadataPromise) return metadataPromise;
    metadataEpoch = epoch;
    metadataPromise = typeof app?.backend?.binaryMetadata === 'function'
      ? Promise.resolve(app.backend.binaryMetadata('summary')).catch(() => null)
      : Promise.resolve(null);
    return metadataPromise;
  };

  const resolveLiveAbi = async (architecture, options = {}) => {
    const descriptor = descriptorMetadata(app);
    const metadata = await metadataSummary(options);
    const explicitAbi = descriptor.abi ?? metadata?.summary?.abi ?? metadata?.metadata?.abi ?? null;
    const formatId = formatIdFor(app);
    const bits = Number(descriptor.bits ?? metadata?.summary?.bits ?? 64);
    let platform = normalizePlatform(descriptor.platform ?? metadata?.summary?.platform);

    if (architecture === 'riscv64') {
      if (explicitAbi) {
        const explicit = resolveABIPlugin({ architecture, platform:platform ?? 'unix', abiId:String(explicitAbi) });
        return explicit?.supported
          ? { supported:true, abiId:explicit.id, platform:platform ?? 'unix' }
          : { supported:false, reason:'riscv-explicit-abi-unsupported' };
      }
      const flags = metadata?.metadata?.flags;
      if (flags == null) return { supported:false, reason:'riscv-elf-flags-unavailable' };
      const selected = riscvAbiFromElfFlags(flags, { bits });
      if (!selected?.supported || !selected.abiId) return { supported:false, reason:selected?.reason || 'riscv-abi-unproven' };
      platform ??= 'unix';
      return { supported:true, abiId:selected.abiId, platform, evidence:'elf-e-flags' };
    }

    if (architecture === 'x86_64') {
      if (!platform) platform = formatId === 'pe' ? 'windows' : formatId === 'elf' ? 'unix' : null;
      const resolved = resolveABIPlugin({ architecture, platform, ...(explicitAbi ? { abiId:String(explicitAbi) } : {}) });
      if (!resolved?.supported) return { supported:false, reason:'x86-64-abi-unproven' };
      return { supported:true, abiId:resolved.id, platform:platform ?? 'unknown' };
    }

    return { supported:false, reason:`semantic-function-unsupported-architecture:${architecture || 'unknown'}` };
  };

  const produceLiveFunction = async (functionId, options = {}) => {
    const range = validatedRangeFor(app, functionId);
    if (!range?.ok) return unsupported(functionId, range?.reason || 'function-range-unavailable');
    const architecture = liveArchitecture(app);
    const symbols = app?.symbols;
    const name = symbols?.nameAt?.(range.start) ?? symbols?.label?.(range.start) ?? null;

    if (supportsArm64SemanticAnalysis(architecture)) {
      if (!app?.backend || !range.region || !storeValue(app, 'canDisassemble') || !symbols?.functionCount) {
        return unsupported(functionId, 'arm64-function-producer-unavailable');
      }
      const alignment = Math.max(1, Number(
        storeValue(app, 'instructionAlignment')
        ?? storeValue(app, 'capability')?.instructionAlignment
        ?? 4
      ));
      if (alignment !== 4) return unsupported(functionId, 'arm64-legacy-producer-requires-4-byte-instructions');
      const width = 4n;
      if ((range.start - BigInt(range.region.vmAddr)) % width !== 0n) {
        return unsupported(functionId, 'function-start-misaligned');
      }
      const startRow = Number((range.start - BigInt(range.region.vmAddr)) / width);
      const maxRegionRow = Math.max(0, Number(BigInt(range.region.size) / width) - 1);
      const endRow = Math.min(
        Number((range.end - BigInt(range.region.vmAddr) + width - 1n) / width) - 1,
        maxRegionRow,
      );
      if (endRow < startRow) return unsupported(functionId, 'function-range-empty');
      const result = await analyzeFunctionCached(
        app.backend,
        range.region,
        startRow,
        endRow,
        symbols,
        options.onProgress,
        options,
      );
      const truncated = result?.truncated === true;
      const rangePartial = range.complete === false;
      const completeness = truncated ? 'truncated' : rangePartial ? 'partial' : 'complete';
      const value = {
        ...result,
        functionId:functionIdOf(range.start),
        architectureId:architecture,
        startAddress:range.start,
        endAddress:range.end,
        name,
        completeness:{
          complete:completeness === 'complete',
          reason:truncated ? 'analysis-budget' : range.reason || null,
          provenance:range.provenance,
          regionId:range.region.id,
        },
      };
      return wrappedValue(value, completeness, {
        completeness,
        reason:value.completeness.reason,
        architecture,
        producer:'legacy-arm64-compatibility',
      });
    }

    if (!['x86_64', 'riscv64'].includes(architecture) || typeof app?.backend?.analyzeSemanticFunction !== 'function') {
      return unsupported(functionId, `function-analysis-unsupported-architecture:${architecture || 'unknown'}`);
    }

    const span = range.end - range.start;
    if (span <= 0n) return unsupported(functionId, 'function-range-empty');
    const bounded = span > BigInt(X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES);
    const length = Number(bounded ? BigInt(X86_SEMANTIC_FUNCTION_MAX_DECODE_BYTES) : span);
    const abi = await resolveLiveAbi(architecture, options);
    if (!abi.supported) return unsupported(functionId, abi.reason);
    const sliceIndex = Number(storeValue(app, 'sliceIndex') ?? 0);
    const canonical = await app.backend.analyzeSemanticFunction({
      address:range.start,
      length,
      architecture,
      abiId:abi.abiId,
      platform:abi.platform,
      sliceIndex:sliceIndex < 0 ? 0 : sliceIndex,
      name:name ?? undefined,
      completeness:bounded || range.complete === false ? 'partial' : 'complete',
      signal:options.signal ?? null,
      onIdentityProgress:options.onIdentityProgress ?? options.onProgress,
    });
    const completeness = bounded ? 'truncated' : range.complete === false ? 'partial' : completenessOf(canonical);
    const value = {
      ...canonical,
      functionId:functionIdOf(range.start),
      startAddress:range.start,
      endAddress:range.start + BigInt(length),
      requestedEndAddress:range.end,
      name,
      truncated:bounded,
      complete:completeness === 'complete',
    };
    return wrappedValue(value, completeness, {
      completeness,
      reason:bounded ? 'semantic-function-decode-budget' : range.reason || null,
      architecture,
      abiId:abi.abiId,
      abiEvidence:abi.evidence ?? null,
      producer:'canonical-semantic-function',
    });
  };

  const loadFunctionResult = async (functionId, options = {}) => {
    if (typeof app?.analyzeFunction === 'function') {
      const value = await app.analyzeFunction(functionId, options);
      if (value != null) return wrappedValue(value);
    }
    if (directFetch) {
      const address = normalizeAddress(functionId);
      const value = await directFetch(address ?? functionId, options);
      if (value != null) return wrappedValue(value);
    }
    return produceLiveFunction(functionId, options);
  };

  const adapter = {
    async currentIdentity(options = {}) {
      if (options.signal?.aborted) {
        const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('AbortError');
        error.name = 'AbortError';
        throw error;
      }
      const fileInfo = currentFileInfo(app);
      const project = storeValue(app, 'project') ?? app?.workspace?.project ?? app?.project ?? null;
      let binaryId = app?.backend?.binaryId
        ?? fileInfo?.binaryId
        ?? fileInfo?.sha256
        ?? fileInfo?.hash
        ?? project?.binaryHash
        ?? project?.binary?.hash
        ?? null;
      if (!binaryId && typeof app?.backend?.ensureBinaryId === 'function') {
        try {
          binaryId = await app.backend.ensureBinaryId({
            signal: options.signal ?? null,
            onProgress: options.onIdentityProgress ?? options.onProgress,
          });
        } catch (error) {
          if (options.signal?.aborted || error?.name === 'AbortError' || error?.stale) throw error;
        }
      }
      if (!binaryId && typeof app?.ensureAnalysisIdentity === 'function') {
        try { binaryId = await app.ensureAnalysisIdentity(); } catch { /* handled below */ }
      }
      if (!binaryId) {
        const error = new Error('analysis-query-binary-unbound');
        error.code = 'ANALYSIS_QUERY_BINARY_UNBOUND';
        throw error;
      }
      const projectRevision = Number(
        project?.revision
        ?? app?.projectRevision
        ?? app?.workspace?.bindingRevision
        ?? 0
      );
      const analysisEpoch = Number(app?.backend?.gen ?? app?.analysisEpoch ?? 0);
      return {
        binaryId: String(binaryId),
        projectRevision: Number.isFinite(projectRevision) ? projectRevision : 0,
        artifactVersions: artifactVersionsFor(app),
        analysisEpoch: Number.isFinite(analysisEpoch) ? analysisEpoch : 0,
      };
    },

    async binaryInfo(snapshot, options = {}) {
      const info = currentFileInfo(app);
      const slice = currentSlice(app, info);
      const capability = storeValue(app, 'capability') ?? slice?.capability ?? info?.capability ?? null;
      const value = {
        binaryId:snapshot.binaryId,
        name:info?.name ?? storeValue(app, 'file')?.name ?? null,
        size:info?.size ?? storeValue(app, 'file')?.size ?? null,
        formatId:formatIdFor(app) || info?.format ?? null,
        architecture:liveArchitecture(app) || null,
        sliceIndex:Number(storeValue(app, 'sliceIndex') ?? -1),
        capability,
        regions:(storeValue(app, 'regions') || []).map((region) => ({
          id:region.id,
          name:region.name ?? null,
          section:region.section ?? null,
          vmAddr:region.vmAddr,
          size:region.size,
          exec:region.exec === true,
          read:region.read === true,
          write:region.write === true,
        })),
      };
      return wrappedValue(value, info ? 'complete' : 'partial', {
        completeness:info ? 'complete' : 'partial',
        reason:info ? null : 'file-info-unavailable',
      });
    },

    async functions(snapshot, query = {}, page = {}, options = {}) {
      const symbols = app?.symbols;
      if (!symbols?.funcs) return unsupported(null, 'function-index-unavailable');
      const needle = String(query?.text ?? query?.name ?? '').trim().toLowerCase();
      const addressNeedle = normalizeAddress(query?.address ?? null);
      const scanLimit = Math.min(symbols.funcs.length, MAX_FUNCTION_SCAN);
      const matches = [];
      for (let index = 0; index < scanLimit; index++) {
        if (options.signal?.aborted) {
          const error = options.signal.reason instanceof Error ? options.signal.reason : new Error('AbortError');
          error.name = 'AbortError';
          throw error;
        }
        const address = BigInt(symbols.funcs[index]);
        if (addressNeedle != null && address !== addressNeedle) continue;
        const name = symbols.nameAt?.(address) ?? null;
        if (needle && !String(name ?? '').toLowerCase().includes(needle)
          && !address.toString(16).includes(needle.replace(/^0x/, ''))) continue;
        const fn = symbols.functionAt?.(address) ?? null;
        matches.push({
          id:functionIdOf(address),
          address,
          name,
          end:fn?.end ?? null,
          size:fn?.end != null && fn.end > address ? fn.end - address : null,
          evidence:symbols.functionEvidence?.(address) ?? null,
        });
      }
      const sourceComplete = symbols.functionStartsComplete === true && scanLimit === symbols.funcs.length;
      const completeness = sourceComplete ? 'complete' : 'partial';
      return pageArray(matches, page, completeness, {
        reason:sourceComplete ? null : (scanLimit < symbols.funcs.length ? 'function-scan-budget' : 'function-discovery-incomplete'),
        scanned:scanLimit,
        totalKnown:symbols.funcs.length,
      });
    },

    async functionById(snapshot, functionId, options = {}) {
      return loadFunctionResult(functionId, options);
    },

    async instructions(snapshot, range, page = {}, options = {}) {
      const requested = typeof range === 'object' && range != null ? range : { functionId:range };
      let start = normalizeAddress(requested.start ?? requested.address);
      let end = normalizeAddress(requested.end);
      if (start == null && requested.functionId != null) {
        const functionRange = validatedRangeFor(app, requested.functionId);
        if (!functionRange?.ok) return unsupported(requested.functionId, functionRange?.reason || 'function-range-unavailable');
        start = functionRange.start;
        end = functionRange.end;
      }
      if (start == null) return unsupported(null, 'instruction-range-start-required');
      const maximumBytes = 1024 * 1024;
      let length = Number(requested.length ?? (end == null ? 4096n : end - start));
      if (!Number.isSafeInteger(length) || length <= 0) return unsupported(null, 'instruction-range-invalid');
      const truncatedByBudget = length > maximumBytes;
      length = Math.min(maximumBytes, length);
      const architecture = liveArchitecture(app);
      if (typeof app?.backend?.disassembleAt === 'function') {
        const decoded = await app.backend.disassembleAt(start, {
          architecture,
          length,
          signal:options.signal ?? null,
        });
        if (decoded?.supported && decoded?.found) {
          const rows = (decoded.instructions || []).map((instruction, index) => ({
            id:instruction.instructionId ?? `${functionIdOf(instruction.address ?? start)}:${index}`,
            address:instruction.address == null ? null : BigInt(instruction.address),
            size:Number(instruction.length ?? instruction.size ?? 0),
            mnemonic:String(instruction.mnemonic ?? instruction.instructionFamily ?? ''),
            operands:String(instruction.opStr ?? instruction.operands ?? ''),
            raw:instruction,
          }));
          return pageArray(rows, page, truncatedByBudget ? 'truncated' : 'complete', {
            reason:truncatedByBudget ? 'instruction-read-budget' : null,
            architecture,
          });
        }
      }
      const modelResult = await loadFunctionResult(requested.functionId ?? start, options);
      const model = modelResult?.value?.model ?? null;
      if (!model?.instructions) return unsupported(requested.functionId ?? start, 'instruction-producer-unavailable');
      const rows = model.instructions.map((instruction, index) => ({
        id:instruction.id ?? `${functionIdOf(instruction.address ?? start)}:${index}`,
        address:instruction.address ?? null,
        size:Number(instruction.size ?? 4),
        mnemonic:String(instruction.mnemonic ?? instruction.mn ?? ''),
        operands:String(instruction.operands ?? instruction.ops ?? ''),
        row:instruction.row ?? index,
      }));
      return pageArray(rows, page, modelResult.status?.completeness ?? completenessOf(modelResult.value));
    },

    async semanticIR(snapshot, functionId, options = {}) {
      if (typeof app?.getSemanticIR === 'function') {
        const value = await app.getSemanticIR(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const modelResult = await loadFunctionResult(functionId, options);
      const model = modelResult?.value ?? null;
      const ir = semanticIRFromModel(model);
      return wrappedValue(ir, modelResult?.status?.completeness ?? completenessOf(model))
        ?? unsupported(functionId, model ? 'semantic-ir-v2-unavailable' : 'function-producer-unavailable');
    },

    async cfg(snapshot, functionId, options = {}) {
      if (typeof app?.getCFG === 'function') {
        const value = await app.getCFG(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const modelResult = await loadFunctionResult(functionId, options);
      const model = modelResult?.value ?? null;
      const cfg = cfgFromModel(model);
      return wrappedValue(cfg, modelResult?.status?.completeness ?? completenessOf(model))
        ?? unsupported(functionId, model ? 'cfg-unavailable' : 'function-producer-unavailable');
    },

    async callers(snapshot, functionId, page = {}, options = {}) {
      if (typeof app?.ensureProgram !== 'function') return unsupported(functionId, 'program-index-unavailable');
      const address = normalizeAddress(functionId);
      if (address == null) return unsupported(functionId, 'function-address-invalid');
      const program = await app.ensureProgram(options.onProgress);
      if (!program || typeof program.callersOf !== 'function') return unsupported(functionId, 'program-index-unavailable');
      const { offset, limit } = pageSpec(page);
      const source = program.callersOf(address, Math.min(MAX_PAGE_LIMIT, offset + limit));
      const values = Array.from(source || []).map((item) => ({
        id:item.addr == null ? `site:${functionIdOf(item.site)}` : functionIdOf(item.addr),
        address:item.addr ?? null,
        site:item.site ?? null,
        count:item.count ?? 1,
      }));
      return pageArray(values, page, sourceCompleteness(source), {
        reason:source?.incompleteReason ?? null,
      });
    },

    async callees(snapshot, functionId, page = {}, options = {}) {
      if (typeof app?.ensureProgram !== 'function') return unsupported(functionId, 'program-index-unavailable');
      const range = validatedRangeFor(app, functionId);
      if (!range?.ok) return unsupported(functionId, range?.reason || 'function-range-unavailable');
      const program = await app.ensureProgram(options.onProgress);
      if (!program || typeof program.calleesOf !== 'function') return unsupported(functionId, 'program-index-unavailable');
      const { offset, limit } = pageSpec(page);
      const source = program.calleesOf(range.start, range.end, Math.min(MAX_PAGE_LIMIT, offset + limit));
      const values = Array.from(source || []).map((item) => ({
        id:functionIdOf(item.addr),
        address:item.addr,
        site:item.site ?? null,
        count:item.count ?? 1,
      }));
      return pageArray(values, page, sourceCompleteness(source), {
        reason:source?.incompleteReason ?? null,
      });
    },

    async xrefs(snapshot, entityId, page = {}, options = {}) {
      if (typeof app?.ensureProgram !== 'function') return unsupported(entityId, 'program-index-unavailable');
      const address = normalizeAddress(entityId);
      if (address == null) return unsupported(entityId, 'xref-address-invalid');
      const program = await app.ensureProgram(options.onProgress);
      if (!program) return unsupported(entityId, 'program-index-unavailable');
      const { offset, limit } = pageSpec(page);
      const requestLimit = Math.min(MAX_PAGE_LIMIT, offset + limit);
      const refs = typeof program.refSitesTo === 'function' ? program.refSitesTo(address, 1n, requestLimit) : [];
      const calls = typeof program.callSitesTo === 'function' ? program.callSitesTo(address, requestLimit) : [];
      const values = [
        ...Array.from(refs || []).map((item) => ({
          id:`ref:${functionIdOf(item.site)}:${functionIdOf(item.target)}`,
          kind:'reference',
          site:item.site,
          target:item.target,
          refKind:item.kind ?? null,
        })),
        ...Array.from(calls || []).map((item) => ({
          id:`call:${functionIdOf(item.site)}:${functionIdOf(address)}`,
          kind:'call',
          site:item.site,
          target:address,
          caller:item.caller ?? null,
        })),
      ].sort((left, right) => {
        const a = BigInt(left.site ?? 0), b = BigInt(right.site ?? 0);
        return a < b ? -1 : a > b ? 1 : left.kind.localeCompare(right.kind);
      });
      const completeness = sourceCompleteness(refs, sourceCompleteness(calls));
      return pageArray(values, page, completeness, {
        reason:refs?.incompleteReason ?? calls?.incompleteReason ?? null,
      });
    },

    async types(snapshot, scope, page = {}, options = {}) {
      if (typeof app?.getTypes === 'function') {
        const value = await app.getTypes(scope, options);
        if (value != null) return wrappedValue(value);
      }
      const functionId = scope?.functionId ?? scope?.address ?? scope;
      const modelResult = await loadFunctionResult(functionId, options);
      const legacyModel = modelResult?.value?.model ?? null;
      if (!legacyModel) return unsupported(functionId, 'typed-function-projection-unavailable');
      const inferred = inferTypes(legacyModel);
      return wrappedValue(inferred, modelResult?.status?.completeness ?? completenessOf(modelResult?.value), {
        inference:true,
      });
    },

    async evidence(snapshot, query = {}, page = {}, options = {}) {
      if (typeof app?.getEvidence === 'function') {
        const value = await app.getEvidence(query, options);
        if (value != null) return pageArray(Array.isArray(value) ? value : [value], page);
      }
      const report = app?.autoReport?.report ?? null;
      const values = [];
      for (const item of report?.deep || []) values.push(item);
      for (const item of report?.confirmed || report?.settled || []) if (!values.includes(item)) values.push(item);
      if (query?.functionId != null) {
        const modelResult = await loadFunctionResult(query.functionId, options);
        for (const item of modelResult?.value?.decompiler?.evidence || []) {
          values.push({ kind:'decompiler', functionId:query.functionId, evidence:item });
        }
      }
      if (!values.length) return unsupported(query?.functionId ?? null, 'evidence-store-unavailable');
      return pageArray(values, page, report?.truncated ? 'partial' : 'complete');
    },

    async decompile(snapshot, functionId, options = {}) {
      if (typeof app?.getDecompile === 'function') {
        const value = await app.getDecompile(functionId, options);
        if (value != null) return wrappedValue(value);
      }
      const modelResult = await loadFunctionResult(functionId, options);
      const value = modelResult?.value;
      if (value?.decompiler) return wrappedValue(value.decompiler, modelResult.status?.completeness ?? completenessOf(value));
      if (!value?.model) return unsupported(functionId, 'decompiler-projection-unavailable');
      const address = normalizeAddress(functionId) ?? value.startAddr ?? value.startAddress ?? null;
      const output = decompile(value.model, {
        name:address == null ? null : app?.symbols?.nameAt?.(address),
        addr:address,
      });
      return wrappedValue(output, modelResult.status?.completeness ?? completenessOf(value));
    },

    async search(snapshot, query, page = {}, options = {}) {
      if (typeof app?.querySearch === 'function') {
        const value = await app.querySearch(query, options);
        return pageArray(Array.isArray(value) ? value : value?.results || [], page, completenessOf(value), {
          reason:value?.truncationReason ?? null,
        });
      }
      if (!query || typeof query !== 'object' || typeof app?.backend?.search !== 'function') {
        return unsupported(null, 'typed-search-producer-unavailable');
      }
      const result = await app.backend.search(query, options.onProgress);
      const values = Array.isArray(result?.results) ? result.results : [];
      return pageArray(values, page, result?.capped || result?.cancelled ? 'partial' : 'complete', {
        reason:result?.cancelled ? 'cancelled' : result?.capped ? 'search-result-cap' : null,
      });
    },

    async causalPath(snapshot, source, sink, options = {}) {
      if (typeof app?.queryCausalPath === 'function') {
        const value = await app.queryCausalPath(source, sink, options);
        return wrappedValue(value);
      }
      return unsupported(source?.functionId ?? source ?? null, 'causal-path-producer-unavailable');
    },
  };

  installFunctionQueryRoutes(app, directFetch);
  return adapter;
}
