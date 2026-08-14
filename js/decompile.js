/* IR-first compatibility facade. The previous decompiler is retained verbatim in decompile-legacy.js and is used only when Semantic IR cannot produce a result. */
import { decompile as legacyDecompile } from './decompile-legacy.js';
import { decompileSemantic } from './decompiler/semantic.js';
import { repairCanonicalPostTestLoop } from './decompiler/loop-repair.js';

// Preserve every historical helper export (stackNaming, decompiledText, etc.).
// Explicit exports below intentionally override only the public decompile entry.
export * from './decompile-legacy.js';
export { decompileSemantic } from './decompiler/semantic.js';
export { renderValue as renderSemanticValue, renderMemoryLocation, renderBranchCondition, recoverInductionVariables, reachingRegisterValue } from './decompiler/semantic.js';

function textOf(lines) {
  return (lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
}

function foldSelectIdiom(text) {
  if (typeof text !== 'string' || !text.includes('?')) return text;
  // CSEL frequently materializes the comparison constant as a separate SSA
  // value (e.g. WZR vs `cmp ..., #0`). Compare rendered values, not SSA ids.
  // Only fold when both non-selected expressions are textually identical, so
  // a prettier min/max can never change semantics.
  let m = text.match(/^(.+?=\s*)\((.+?)\s*<\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*\?\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*:\s*(.+)\);$/);
  if (m && m[3].trim() === m[4].trim() && m[2].trim() === m[5].trim()) {
    return `${m[1]}max(${m[2].trim()}, ${m[3].trim()});`;
  }
  m = text.match(/^(.+?=\s*)\((.+?)\s*>\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*\?\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*:\s*(.+)\);$/);
  if (m && m[3].trim() === m[4].trim() && m[2].trim() === m[5].trim()) {
    return `${m[1]}min(${m[2].trim()}, ${m[3].trim()});`;
  }
  return text;
}

function normalizeCompatibility(result) {
  if (!result) return result;
  // stackNaming() historically uses upper-case hexadecimal. Keep that public
  // textual contract even though IR stack-slot keys are lower-case internally.
  for (const l of result.lines || []) {
    if (!l || typeof l.text !== 'string') continue;
    l.text = l.text.replace(/\bvar_([0-9a-f]+)\b/g, (_m, h) => 'var_' + h.toUpperCase());
    l.text = foldSelectIdiom(l.text);
  }
  if (result.semantic) result.pseudocode = textOf(result.lines);
  return result;
}

function augmentLegacy(fallback, reason) {
  fallback.warnings = [...(fallback.warnings || []), reason];
  fallback.summary = fallback.summary || 'Semantic IR が安全に表現できない領域があるため、命令を省略しない互換表示へ切り替えました。';
  fallback.pseudocode = fallback.pseudocode || textOf(fallback.lines);
  fallback.evidence = fallback.evidence || [];
  fallback.semantic = false;
  fallback.legacyFallback = true;
  return fallback;
}

function blockAddress(result, model, opts, bi) {
  const b = result?.ir?.blocks?.[bi];
  if (!b) return opts.addr ?? model.instructions?.[0]?.address ?? 0n;
  return model.instructions?.find((x) => x.row === b.startRow)?.address
    ?? opts.addrOfRow?.(b.startRow)
    ?? (opts.addr ?? model.instructions?.[0]?.address ?? 0n) + BigInt(b.startRow || 0) * 4n;
}

export function decompile(model, opts = {}) {
  if (opts.semanticIR === false || opts.forceLegacyDecompiler === true) return legacyDecompile(model, opts);
  try {
    let result = decompileSemantic(model, opts);
    if (result) {
      // IR construction intentionally visits only reachable blocks. If the
      // function range also contains disconnected/indirectly-reachable blocks,
      // IR cannot claim coverage for them; this is a legitimate unsupported-IR
      // case and the faithful legacy CFG renderer is the safe fallback.
      const total = result.ir?.blocks?.length || 0;
      const reachable = result.coverage?.reachable ?? total;
      if (total > reachable) {
        return augmentLegacy(
          legacyDecompile(model, opts),
          `Semantic IR covers ${reachable}/${total} Basic Blocks; disconnected or indirect targets are shown with the faithful CFG fallback.`,
        );
      }

      result = repairCanonicalPostTestLoop(result, (bi) => blockAddress(result, model, opts, bi));
      if (result.coverage) {
        result.coverage.total = total;
        result.coverage.emitted = result.coverage.emitted ?? total;
      }
      return normalizeCompatibility(result);
    }
  } catch (error) {
    return augmentLegacy(
      legacyDecompile(model, opts),
      `Semantic IR decompiler fallback: ${error && error.message ? error.message : 'unknown error'}`,
    );
  }
  return augmentLegacy(legacyDecompile(model, opts), 'Semantic IR is unavailable for this function.');
}
