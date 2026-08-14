/* IR-first compatibility facade. The previous decompiler is retained verbatim in decompile-legacy.js and is used only when Semantic IR cannot produce a result. */
import { decompile as legacyDecompile } from './decompile-legacy.js';
import { decompileSemantic } from './decompiler/semantic.js';

// Preserve every historical helper export (stackNaming, etc.). Explicit exports
// below intentionally override only the public decompile entry point.
export * from './decompile-legacy.js';
export { decompileSemantic } from './decompiler/semantic.js';
export { renderValue as renderSemanticValue, renderMemoryLocation, renderBranchCondition, recoverInductionVariables, reachingRegisterValue } from './decompiler/semantic.js';

function normalizeCompatibility(result) {
  if (!result) return result;
  // stackNaming() historically uses upper-case hexadecimal. Keep that public
  // textual contract even though IR stack-slot keys are lower-case internally.
  for (const l of result.lines || []) {
    if (l && typeof l.text === 'string') l.text = l.text.replace(/\bvar_([0-9a-f]+)\b/g, (_m, h) => 'var_' + h.toUpperCase());
  }
  if (result.semantic) result.pseudocode = (result.lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
  return result;
}

export function decompile(model, opts = {}) {
  if (opts.semanticIR === false || opts.forceLegacyDecompiler === true) return legacyDecompile(model, opts);
  try {
    const result = decompileSemantic(model, opts);
    if (result) return normalizeCompatibility(result);
  } catch (error) {
    const fallback = legacyDecompile(model, opts);
    fallback.warnings = [...(fallback.warnings || []), `Semantic IR decompiler fallback: ${error && error.message ? error.message : 'unknown error'}`];
    fallback.summary = fallback.summary || 'Semantic IR の生成または変換に失敗したため、命令を省略しない互換表示へ切り替えました。';
    fallback.pseudocode = fallback.pseudocode || (fallback.lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
    fallback.evidence = fallback.evidence || [];
    fallback.semantic = false;
    fallback.legacyFallback = true;
    return fallback;
  }
  const fallback = legacyDecompile(model, opts);
  fallback.summary = fallback.summary || 'Semantic IR が利用できないため、互換Decompilerで表示しています。';
  fallback.pseudocode = fallback.pseudocode || (fallback.lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
  fallback.evidence = fallback.evidence || [];
  fallback.semantic = false;
  fallback.legacyFallback = true;
  return fallback;
}
