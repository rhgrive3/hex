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

/*
 * Some textual disassemblers emit direct control-flow targets without '#'.
 * arm64.parseOperands then (correctly) leaves them as `other`; that must not
 * make an otherwise direct branch disappear from Semantic IR. Accept only a
 * strict integer token for known direct-control mnemonics. Arbitrary labels,
 * symbol expressions and strings remain unresolved rather than guessed.
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

function asmText(insn) {
  const mn = String(insn?.mnemonic || insn?.mn || '').trim();
  const ops = typeof insn?.operands === 'string'
    ? insn.operands
    : typeof insn?.operandsText === 'string'
      ? insn.operandsText
      : Array.isArray(insn?.ops)
        ? insn.ops.map((o) => o?.text || '').filter(Boolean).join(', ')
        : String(insn?.ops || '');
  return `${mn}${ops.trim() ? ' ' + ops.trim() : ''}`.trim() || 'unknown';
}

function faithfulIrCfg(result, model, opts, reason) {
  const ir = result?.ir;
  if (!ir?.blocks?.length) return result;
  const lines = [];
  const sig = result.signature || result.lines?.find((l) => l.kind === 'sig')?.text || 'void sub(void)';
  lines.push({ kind: 'sig', indent: 0, text: sig, row: model.instructions?.[0]?.row ?? null, addr: model.instructions?.[0]?.address ?? null, note: null });
  lines.push({ kind: 'ctrl', indent: 0, text: '{', row: model.instructions?.[0]?.row ?? null, addr: null, note: null });

  const blocks = ir.blocks.slice().sort((a, b) => a.startRow - b.startRow);
  for (let pos = 0; pos < blocks.length; pos++) {
    const block = blocks[pos];
    const addr = blockAddress(result, model, opts, block.index);
    lines.push({ kind: 'label', indent: 1, text: `${labelAddress(result, model, opts, block.index)}:`, row: block.startRow, addr, note: null });
    const rows = (model.instructions || []).filter((i) => i.row >= block.startRow && i.row <= block.endRow);
    for (let ri = 0; ri < rows.length; ri++) {
      const insn = rows[ri];
      const mn = String(insn.mnemonic || insn.mn || '').toLowerCase();
      const isLast = ri === rows.length - 1;
      if (isLast && mn === 'b' && block.succ?.length === 1) {
        lines.push({ kind: 'stmt', indent: 2, text: `goto ${labelAddress(result, model, opts, block.succ[0])};`, row: insn.row, addr: insn.address ?? null, note: null });
        continue;
      }
      if (isLast && /^(?:b\.[a-z]{2}|cbz|cbnz|tbz|tbnz)$/.test(mn)) {
        const targets = (block.succ || []).map((s) => labelAddress(result, model, opts, s)).join(', ');
        lines.push({ kind: 'stmt', indent: 2, text: `__asm(${JSON.stringify(asmText(insn))});${targets ? ` /* successors: ${targets} */` : ''}`, row: insn.row, addr: insn.address ?? null, note: null });
        continue;
      }
      if (isLast && mn === 'br') {
        lines.push({ kind: 'stmt', indent: 2, text: `__asm(${JSON.stringify(asmText(insn))});`, row: insn.row, addr: insn.address ?? null, note: null });
        continue;
      }
      if (isLast && mn === 'ret') {
        lines.push({ kind: 'stmt', indent: 2, text: '__asm("ret");', row: insn.row, addr: insn.address ?? null, note: null });
        continue;
      }
      lines.push({ kind: 'stmt', indent: 2, text: `__asm(${JSON.stringify(asmText(insn))});`, row: insn.row, addr: insn.address ?? null, note: null });
    }
    const next = blocks[pos + 1]?.index;
    if (block.succ?.length === 1 && block.succ[0] !== next) {
      const last = rows.at(-1);
      const mn = String(last?.mnemonic || last?.mn || '').toLowerCase();
      if (!/^(?:b|ret|br|b\.[a-z]{2}|cbz|cbnz|tbz|tbnz)$/.test(mn)) {
        lines.push({ kind: 'stmt', indent: 2, text: `goto ${labelAddress(result, model, opts, block.succ[0])};`, row: block.endRow, addr: null, note: null });
      }
    }
  }
  lines.push({ kind: 'ctrl', indent: 0, text: '}', row: model.instructions?.at?.(-1)?.row ?? null, addr: null, note: null });

  result.lines = lines;
  result.pseudocode = textOf(lines);
  result.summary = '構造化を断定できない共有cleanup経路があるため、Semantic IRのCFGをラベルとedgeを保った形で表示しています。';
  result.warnings = [...(result.warnings || []), reason];
  result.evidence = [...(result.evidence || []), { reason: 'faithful Semantic IR CFG fallback', op: 'cfg', row: null, address: null }];
  result.coverage = { ...(result.coverage || {}), mode: 'linear', total: ir.blocks.length, emitted: ir.blocks.length, missing: 0 };
  result.ctx = { ...(result.ctx || {}), faithfulIrCfg: true };
  result.semantic = true;
  return result;
}

function hasNonNaturalBackwardEdge(_model, result) {
  const ir = result?.ir;
  if (!ir?.blocks?.length) return false;
  const isNaturalBackEdge = (from, to) => !!ir.dominators?.[from]?.has?.(to);
  for (const block of ir.blocks) {
    for (const succ of block.succ || []) {
      const dst = ir.blocks[succ];
      if (!dst) continue;
      if (dst.startRow < block.startRow && !isNaturalBackEdge(block.index, succ)) return true;
    }
  }
  return false;
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
          `Semantic IR covers ${reachable}/${total} Basic Blocks; disconnected or indirect targets are shown with the faithful CFG fallback.`,
        ), model, opts);
      }

      if (hasNonNaturalBackwardEdge(semanticModel, result)) {
        return finalize(faithfulIrCfg(
          result,
          semanticModel,
          opts,
          'A backward control-flow edge is not a proven natural loop; shared cleanup is shown with faithful Semantic IR labels/gotos.',
        ), semanticModel, opts);
      }

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
