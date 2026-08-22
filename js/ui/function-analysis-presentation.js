const UI_PRESENTATION_ROUTE = Symbol('canonical-function-ui-presentation');

function safeRows(block) {
  const rows = [...new Set((block?.insts || [])
    .map((inst) => Number(inst?.row))
    .filter(Number.isSafeInteger))]
    .sort((a, b) => a - b);
  if (!rows.length && Number.isSafeInteger(block?.startRow)) rows.push(block.startRow);
  return rows;
}

export function presentationBasicBlocks(legacy) {
  return (legacy?.blocks || []).map((block) => {
    const rows = safeRows(block);
    return {
      ...block,
      rows,
      startRow:rows[0] ?? block.startRow,
      endRow:rows[rows.length - 1] ?? block.endRow,
    };
  });
}

export function decorateFunctionAnalysisForUi(result) {
  if (!result || typeof result !== 'object' || result.model) return result;
  const legacy = result.pipeline?.legacyV1 ?? null;
  if (!legacy || typeof legacy !== 'object') return result;

  const model = {
    ...legacy,
    basicBlocks:presentationBasicBlocks(legacy),
  };
  Object.defineProperties(model, {
    __canonicalDecompiler:{ value:result.decompiler ?? null, enumerable:false },
    __canonicalCfg:{ value:result.pipeline?.cfg ?? null, enumerable:false },
    __canonicalArchitectureId:{ value:result.architectureId ?? null, enumerable:false },
    __analysisPresentationOnly:{ value:true, enumerable:false },
  });

  return {
    ...result,
    model,
    instructions:Number.isSafeInteger(result.instructions)
      ? result.instructions
      : Array.isArray(model.instructions) ? model.instructions.length : 0,
    presentationProjection:Object.freeze({
      source:'semantic-ir-v2',
      target:'legacy-ui-v1',
      canonical:true,
      analysisAuthority:'AnalysisQueryAPI',
    }),
  };
}

export function installFunctionAnalysisPresentation(app) {
  const original = app?.analyzeFunctionAt;
  if (typeof original !== 'function' || original[UI_PRESENTATION_ROUTE]) return original;
  const routed = async function canonicalUiAnalyzeFunctionAt(...args) {
    return decorateFunctionAnalysisForUi(await original.apply(this, args));
  };
  Object.defineProperty(routed, UI_PRESENTATION_ROUTE, { value:true });
  app.analyzeFunctionAt = routed;
  return routed;
}
