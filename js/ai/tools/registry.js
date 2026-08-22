import { createHexToolRegistry as createBaseHexToolRegistry, ToolRegistry } from './registry-base.js';
import { shortHash, stableSerialize } from './paging/cursor.js';

export { ToolRegistry };

function addressText(value) {
  if (value == null) return null;
  try { return `0x${BigInt(value).toString(16)}`; } catch { return String(value); }
}

function queryContext(context) {
  return context?.analysisAuthority === 'AnalysisQueryAPI';
}

function pageRows(value) {
  return Array.isArray(value?.results) ? value.results : [];
}

function continuation(value, offset, cursorFactory) {
  const out = { ...(value || {}) };
  const rows = pageRows(out);
  out.offset = Number.isSafeInteger(Number(out.offset)) ? Number(out.offset) : offset;
  out.returned = Number.isSafeInteger(Number(out.returned)) ? Number(out.returned) : rows.length;
  if (out.complete !== true && rows.length && !out.continuation && typeof cursorFactory === 'function') {
    out.continuation = { cursor:cursorFactory(offset + out.returned) };
  }
  return out;
}

function replace(registry, name, execute) {
  const current = registry.get(name);
  if (!current) return;
  registry.tools.set(name, Object.freeze({ ...current, execute }));
}

function queryPaging(registry, tool, params, cursor) {
  const codec = registry.observationStore.cursorCodec;
  const hash = shortHash(stableSerialize(params));
  let offset = 0;
  if (cursor) {
    const payload = codec.decode(cursor, {
      bindingKey:registry.observationStore.binding().key,
      kind:'tool-page',
    });
    if (payload.tool !== tool || payload.paramsHash !== hash) throw new Error('cursor-parameter-mismatch');
    offset = Math.max(0, Number(payload.offset) || 0);
  }
  const makeCursor = (next) => codec.encode({
    kind:'tool-page',
    bindingKey:registry.observationStore.binding().key,
    tool,
    paramsHash:hash,
    offset:next,
  });
  return { offset, makeCursor };
}

function assemblyLine(row) {
  return [addressText(row?.address), row?.mnemonic, row?.operands].filter(Boolean).join(' ');
}

async function augmentFunctionSummary(context, registry, base, address) {
  if (!base?.found || typeof context.getInstructions !== 'function') return base;
  const page = await context.getInstructions(address, {
    offset:0,
    limit:160,
    signal:registry.executionSignal,
  });
  const rows = pageRows(page);
  let pseudocode = base.pseudocodeExcerpt ?? null;
  if (!pseudocode && typeof context.decompile === 'function') {
    try {
      const text = await context.decompile(address, { signal:registry.executionSignal });
      if (typeof text === 'string') pseudocode = text.slice(0, 16000);
    } catch { /* decompile is optional; function truth still stands */ }
  }
  return {
    ...base,
    assemblyExcerpt:rows.map(assemblyLine).join('\n').slice(0, 30000),
    assemblyReturned:rows.length,
    assemblyTotal:Number.isFinite(Number(page?.total)) ? Number(page.total) : null,
    assemblyComplete:page?.complete === true,
    pseudocodeExcerpt:pseudocode,
    analysisAuthority:'AnalysisQueryAPI',
  };
}

function installQueryOverrides(registry, context) {
  if (!queryContext(context)) return registry;

  const originalGetFunction = registry.get('get_function')?.execute;
  if (originalGetFunction) replace(registry, 'get_function', async (args) =>
    augmentFunctionSummary(context, registry, await originalGetFunction(args), args.address));

  const originalCurrent = registry.get('get_current_function')?.execute;
  if (originalCurrent) replace(registry, 'get_current_function', async (args) => {
    const base = await originalCurrent(args);
    return base?.found && base.address != null
      ? augmentFunctionSummary(context, registry, base, base.address)
      : base;
  });

  const originalInspect = registry.get('inspect_function_region')?.execute;
  if (originalInspect) replace(registry, 'inspect_function_region', async (args) => {
    if (args.view !== 'assembly' || typeof context.getInstructions !== 'function') return originalInspect(args);
    const params = {
      functionAddress:args.functionAddress,
      view:args.view,
      aroundInstructionId:args.aroundInstructionId ?? null,
      radius:args.radius ?? null,
    };
    const paging = queryPaging(registry, 'inspect_function_region', params, args.cursor);
    const count = Math.max(1, Math.min(500, Number(args.count || (args.radius ? args.radius * 2 + 1 : 160))));
    const offset = args.cursor ? paging.offset : Math.max(0, Number(args.start) || 0);
    const page = await context.getInstructions(args.functionAddress, {
      offset,
      limit:count,
      signal:registry.executionSignal,
    });
    const rows = pageRows(page).map((row, index) => ({
      id:row?.id ?? row?.instructionId ?? offset + index,
      row:row?.row ?? null,
      address:addressText(row?.address),
      mnemonic:row?.mnemonic ?? '',
      operands:row?.operands ?? '',
    }));
    const complete = page?.complete === true;
    const out = {
      functionAddress:addressText(args.functionAddress),
      view:'assembly',
      results:rows,
      offset,
      returned:rows.length,
      total:Number.isFinite(Number(page?.total)) ? Number(page.total) : null,
      complete,
      truncated:!complete,
      reason:complete ? null : (page?.reason || 'result-limit'),
      analysisAuthority:'AnalysisQueryAPI',
    };
    if (!complete && rows.length) out.continuation = { cursor:paging.makeCursor(offset + rows.length) };
    return out;
  });

  for (const [tool, method, key, fallbackLimit] of [
    ['get_xrefs', 'getXrefs', 'address', 200],
    ['get_callers', 'getCallers', 'address', 100],
    ['get_callees', 'getCallees', 'address', 100],
  ]) {
    if (typeof context[method] !== 'function') continue;
    replace(registry, tool, async (args) => {
      const params = { [key]:args[key] };
      const paging = queryPaging(registry, tool, params, args.cursor);
      const limit = Math.max(1, Number(args.limit) || fallbackLimit);
      const value = await context[method](args[key], {
        limit,
        offset:paging.offset,
        signal:registry.executionSignal,
      });
      return continuation(value, paging.offset, paging.makeCursor);
    });
  }

  if (typeof context.getCallers === 'function' && typeof context.getCallees === 'function') {
    replace(registry, 'get_related_functions', async ({ functionAddress, limit = 24 }) => {
      const [callers, callees] = await Promise.all([
        context.getCallers(functionAddress, { limit, offset:0, signal:registry.executionSignal }),
        context.getCallees(functionAddress, { limit, offset:0, signal:registry.executionSignal }),
      ]);
      return {
        functionAddress:addressText(functionAddress),
        callers:pageRows(callers),
        callees:pageRows(callees),
        complete:callers?.complete === true && callees?.complete === true,
        truncated:callers?.complete !== true || callees?.complete !== true,
        reason:callers?.reason || callees?.reason || null,
        analysisAuthority:'AnalysisQueryAPI',
      };
    });
  }

  if (typeof context.findPaths === 'function') {
    replace(registry, 'find_paths', async ({ from, to, maxDepth = 6, maxPaths = 8, maxVisited = 10000 }) => {
      const value = await context.findPaths(from, to, {
        maxDepth,
        maxPaths,
        maxVisited,
        signal:registry.executionSignal,
      });
      return { ...(value || {}), analysisAuthority:'AnalysisQueryAPI' };
    });
  }

  return registry;
}

export function createHexToolRegistry(context = {}, options = {}) {
  return installQueryOverrides(createBaseHexToolRegistry(context, options), context);
}

export default createHexToolRegistry;
