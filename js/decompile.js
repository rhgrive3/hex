/* IR-first compatibility facade. Legacy decompilation is used only when Semantic IR cannot faithfully cover a function/instruction. */
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

function asmCount(result) {
  let n = 0;
  for (const l of result?.lines || []) if ((l.kind === 'stmt' || l.kind === 'ctrl') && /__asm\(/.test(l.text || '')) n++;
  return n;
}

function foldSelectIdiom(text) {
  if (typeof text !== 'string' || !text.includes('?')) return text;
  let m = text.match(/^(.+?=\s*)\((.+?)\s*<\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*\?\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*:\s*(.+)\);$/);
  if (m && m[3].trim() === m[4].trim() && m[2].trim() === m[5].trim()) return `${m[1]}max(${m[2].trim()}, ${m[3].trim()});`;
  m = text.match(/^(.+?=\s*)\((.+?)\s*>\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*\?\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*:\s*(.+)\);$/);
  if (m && m[3].trim() === m[4].trim() && m[2].trim() === m[5].trim()) return `${m[1]}min(${m[2].trim()}, ${m[3].trim()});`;
  return text;
}

function normalizeCompatibility(result) {
  if (!result) return result;
  for (const l of result.lines || []) {
    if (!l || typeof l.text !== 'string') continue;
    l.text = l.text.replace(/\bvar_([0-9a-f]+)\b/g, (_m, h) => 'var_' + h.toUpperCase());
    l.text = foldSelectIdiom(l.text);
  }
  if (result.semantic) result.pseudocode = textOf(result.lines);
  return result;
}

function augmentLegacy(fallback, reason, semantic = null) {
  fallback.warnings = [...(fallback.warnings || []), reason];
  fallback.summary = fallback.summary || semantic?.summary || 'Semantic IR が安全に表現できない領域があるため、互換Decompilerへ切り替えました。';
  fallback.pseudocode = fallback.pseudocode || textOf(fallback.lines);
  fallback.evidence = [...(semantic?.evidence || []), ...(fallback.evidence || [])];
  fallback.semantic = false;
  fallback.legacyFallback = true;
  fallback.ctx = {
    ...(fallback.ctx || {}),
    semanticIRFallback: semantic ? {
      irPrimary: true,
      unsupportedInstructions: semantic.ctx?.unknownInstructions || 0,
      coverage: semantic.coverage || null,
      warnings: semantic.warnings || [],
    } : null,
  };
  // Keep the IR available to expert callers even when textual fallback is used.
  if (semantic?.ir && !fallback.ir) fallback.ir = semantic.ir;
  return fallback;
}

function finalize(result, model, opts) {
  result = structureKnownSwitches(result, model, opts);
  return normalizeCompatibility(result);
}

/*
 * Some textual disassemblers emit direct control-flow targets without '#'.
 * arm64.parseOperands then leaves them as `other`. Accept only a strict integer
 * token for known direct-control mnemonics; labels/symbol expressions are never
 * guessed into addresses.
 */
function strictTextAddress(op) {
  if (!op || op.k !== 'other') return null;
  const s = String(op.text || '').trim();
  if (!/^#?(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) return null;
  try { return BigInt(s.replace(/^#/, '')); } catch { return null; }
}

function semanticModelForDecompiler(model) {
  if (!model?.instructions?.length) return model;
  let changed = false;
  const instructions = model.instructions.map((insn) => {
    const mn = String(insn.mnemonic || insn.mn || '').toLowerCase();
    const directBranch = mn === 'b' || /^b\.[a-z]{2}$/.test(mn) || /^(?:cbz|cbnz|tbz|tbnz)$/.test(mn);
    const directCall = mn === 'bl';
    if ((!directBranch || insn.branchTarget != null) && (!directCall || insn.callTarget != null)) return insn;
    const ops = Array.isArray(insn.ops) ? insn.ops : [];
    const target = strictTextAddress(ops[ops.length - 1]);
    if (target == null) return insn;
    changed = true;
    return directCall ? { ...insn, callTarget: target } : { ...insn, branchTarget: target };
  });
  return changed ? { ...model, instructions } : model;
}

function blockAddress(result, model, opts, bi) {
  const b = result?.ir?.blocks?.[bi];
  if (!b) return opts.addr ?? model.instructions?.[0]?.address ?? 0n;
  return model.instructions?.find((x) => x.row === b.startRow)?.address
    ?? opts.addrOfRow?.(b.startRow)
    ?? (opts.addr ?? model.instructions?.[0]?.address ?? 0n) + BigInt(b.startRow || 0) * 4n;
}

function labelAddress(result, model, opts, bi) {
  return `loc_${BigInt(blockAddress(result, model, opts, bi)).toString(16).toUpperCase()}`;
}

function nonNaturalBackwardEdges(result) {
  const ir = result?.ir;
  if (!ir?.blocks?.length) return [];
  const edges = [];
  for (const block of ir.blocks) {
    for (const succ of block.succ || []) {
      const dst = ir.blocks[succ];
      if (!dst || dst.startRow >= block.startRow) continue;
      // Natural-loop definition: target dominates source.
      if (ir.dominators?.[block.index]?.has?.(succ)) continue;
      edges.push({ from: block, to: dst });
    }
  }
  return edges;
}

function ensureLegacyLabel(lines, row, label, address) {
  if (lines.some((l) => String(l.text || '').replace(/:$/, '') === label)) return;
  let at = lines.findIndex((l) => l.row != null && l.row >= row && l.kind !== 'sig');
  if (at < 0) at = Math.max(1, lines.findIndex((l) => l.kind === 'ctrl' && l.text === '}'));
  if (at < 0) at = lines.length;
  const indent = Math.max(1, lines[at]?.indent || 1);
  lines.splice(at, 0, { kind: 'label', indent, text: `${label}:`, row, addr: address, note: null });
}

function ensureLegacyGoto(lines, edge, label) {
  // Only synthesize an unconditional goto when IR proves a single successor.
  // Conditional non-natural edges keep the conservative Semantic IR CFG path.
  if ((edge.from.succ || []).length !== 1) return false;
  if (lines.some((l) => l.row === edge.from.endRow && String(l.text || '').includes(`goto ${label}`))) return true;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const r = lines[i]?.row;
    if (r != null && r <= edge.from.endRow) at = i;
  }
  if (at < 0) return false;
  const indent = Math.max(1, lines[at]?.indent || 1);
  lines.splice(at + 1, 0, { kind: 'stmt', indent, text: `goto ${label};`, row: edge.from.endRow, addr: null, note: null });
  return true;
}

/**
 * Keep legacy statement rendering for a rare non-natural shared-cleanup layout,
 * but graft in only the goto/label edges proven by Semantic IR. This avoids the
 * old false-loop bug without replacing an otherwise translatable function with
 * raw assembly.
 */
function legacyWithIrCleanupEdges(model, semanticModel, opts, semantic, edges) {
  const fallback = augmentLegacy(
    legacyDecompile(model, opts),
    'A backward control-flow edge is not a proven natural loop; Semantic IR supplies the shared-cleanup goto/label edge while legacy rendering handles statements.',
    semantic,
  );
  for (const edge of edges) {
    const label = labelAddress(semantic, semanticModel, opts, edge.to.index);
    const address = blockAddress(semantic, semanticModel, opts, edge.to.index);
    ensureLegacyLabel(fallback.lines || (fallback.lines = []), edge.to.startRow, label, address);
    if (!ensureLegacyGoto(fallback.lines, edge, label)) return null;
  }
  fallback.pseudocode = textOf(fallback.lines);
  fallback.coverage = { ...(semantic.coverage || {}), mode: 'linear', total: semantic.ir?.blocks?.length || 0, emitted: semantic.ir?.blocks?.length || 0, missing: 0 };
  fallback.ctx = { ...(fallback.ctx || {}), semanticCleanupEdges: edges.length };
  return fallback;
}

function preferLegacyForUnsupported(model, opts, semantic) {
  const unsupported = semantic?.ctx?.unknownInstructions || 0;
  if (!unsupported) return semantic;
  const legacy = augmentLegacy(
    legacyDecompile(model, opts),
    `Semantic IR has ${unsupported} unsupported instruction(s); only this unsupported function uses the isolated legacy expression fallback.`,
    semantic,
  );
  // The legacy path is a fallback, not an unconditional preference. If it is
  // actually less faithful (more raw assembly), keep the Semantic IR result.
  return asmCount(legacy) < asmCount(semantic) ? legacy : semantic;
}

export function decompile(model, opts = {}) {
  if (opts.semanticIR === false || opts.forceLegacyDecompiler === true) return legacyDecompile(model, opts);
  const semanticModel = semanticModelForDecompiler(model);
  try {
    let result = decompileSemantic(semanticModel, opts);
    if (result) {
      const total = result.ir?.blocks?.length || 0;
      const reachable = result.coverage?.reachable ?? total;
      if (total > reachable) {
        return finalize(augmentLegacy(
          legacyDecompile(model, opts),
          `Semantic IR covers ${reachable}/${total} Basic Blocks; disconnected or indirect targets use the isolated faithful fallback.`,
          result,
        ), model, opts);
      }

      const cleanupEdges = nonNaturalBackwardEdges(result);
      if (cleanupEdges.length) {
        const mixed = legacyWithIrCleanupEdges(model, semanticModel, opts, result, cleanupEdges);
        if (mixed) return finalize(mixed, semanticModel, opts);
      }

      result = preferLegacyForUnsupported(model, opts, result);
      if (!result.semantic) return finalize(result, semanticModel, opts);

      result = repairCanonicalPostTestLoop(result, (bi) => blockAddress(result, semanticModel, opts, bi));
      if (result.coverage) {
        result.coverage.total = total;
        result.coverage.emitted = result.coverage.emitted ?? total;
      }
      return finalize(result, semanticModel, opts);
    }
  } catch (error) {
    return finalize(augmentLegacy(
      legacyDecompile(model, opts),
      `Semantic IR decompiler fallback: ${error && error.message ? error.message : 'unknown error'}`,
    ), model, opts);
  }
  return finalize(augmentLegacy(legacyDecompile(model, opts), 'Semantic IR is unavailable for this function.'), model, opts);
}
