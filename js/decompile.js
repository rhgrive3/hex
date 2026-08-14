/* IR-first compatibility facade. The previous decompiler is retained verbatim in decompile-legacy.js and is used only when Semantic IR cannot produce a result. */
import { decompile as legacyDecompile } from './decompile-legacy.js';
import { decompileSemantic } from './decompiler/semantic.js';
import { repairCanonicalPostTestLoop } from './decompiler/loop-repair.js';
import { structureKnownSwitches } from './decompiler/switch.js';

// Preserve every historical helper export (stackNaming, decompiledText, etc.).
// Explicit exports below intentionally override only the public decompile entry.
export * from './decompile-legacy.js';
export { decompileSemantic } from './decompiler/semantic.js';
export { structureKnownSwitches } from './decompiler/switch.js';
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

function finalize(result, model, opts) {
  result = structureKnownSwitches(result, model, opts);
  return normalizeCompatibility(result);
}

function blockAddress(result, model, opts, bi) {
  const b = result?.ir?.blocks?.[bi];
  if (!b) return opts.addr ?? model.instructions?.[0]?.address ?? 0n;
  return model.instructions?.find((x) => x.row === b.startRow)?.address
    ?? opts.addrOfRow?.(b.startRow)
    ?? (opts.addr ?? model.instructions?.[0]?.address ?? 0n) + BigInt(b.startRow || 0) * 4n;
}

function hasNonNaturalBackwardEdge(_model, result) {
  const ir = result?.ir;
  if (!ir?.blocks?.length) return false;
  const loops = ir.loops || [];
  const insideSameNaturalLoop = (from, to) => loops.some((loop) =>
    loop?.nodes?.has?.(from) && loop.nodes.has(to));

  // Use the Semantic IR CFG itself, not parser-specific instruction fields.
  // A physically backward CFG edge is only source-loop evidence when both ends
  // belong to the same dominator-proven natural loop. Otherwise it is shared
  // cleanup/tail control flow and must remain explicit.
  for (const block of ir.blocks) {
    for (const succ of block.succ || []) {
      const dst = ir.blocks[succ];
      if (!dst) continue;
      if (dst.startRow < block.startRow && !insideSameNaturalLoop(block.index, succ)) return true;
    }
  }
  return false;
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
        return finalize(augmentLegacy(
          legacyDecompile(model, opts),
          `Semantic IR covers ${reachable}/${total} Basic Blocks; disconnected or indirect targets are shown with the faithful CFG fallback.`,
        ), model, opts);
      }

      // A backward CFG edge that does not form a dominator-proven natural loop
      // is typically shared cleanup/tail code. Turning it into a loop or silently
      // inlining it would change the visible control-flow contract, so keep
      // explicit labels/gotos until the IR has a stronger region proof.
      if (hasNonNaturalBackwardEdge(model, result)) {
        return finalize(augmentLegacy(
          legacyDecompile(model, opts),
          'A backward control-flow edge is not a proven natural loop; shared cleanup is shown with faithful labels/gotos.',
        ), model, opts);
      }

      result = repairCanonicalPostTestLoop(result, (bi) => blockAddress(result, model, opts, bi));
      if (result.coverage) {
        result.coverage.total = total;
        result.coverage.emitted = result.coverage.emitted ?? total;
      }
      return finalize(result, model, opts);
    }
  } catch (error) {
    return finalize(augmentLegacy(
      legacyDecompile(model, opts),
      `Semantic IR decompiler fallback: ${error && error.message ? error.message : 'unknown error'}`,
    ), model, opts);
  }
  return finalize(augmentLegacy(legacyDecompile(model, opts), 'Semantic IR is unavailable for this function.'), model, opts);
}
