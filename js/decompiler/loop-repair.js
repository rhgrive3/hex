import { COND, inverseCondition, OP } from '../ir.js';

function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function valueOf(a) { return a && a.value ? a.value : null; }
function same(a, b) { return !!a && !!b && a.id === b.id; }

function constantText(v) {
  if (!v || v.const == null) return null;
  const n = BigInt(v.const);
  const s = BigInt.asIntN(Math.min(64, Number(v.bits || 64)), n);
  return s >= -9n && s <= 99n ? s.toString() : (s < 0n ? s.toString() : `0x${n.toString(16).toUpperCase()}`);
}

function continuationCondition(iv) {
  const term = iv?.conditionInst;
  if (!term || term.op !== OP.CBR) return null;
  const loop = iv.loop;
  const target = term.extra?.target;
  const headerBlock = loop && loop.header != null ? iv._ir?.blocks?.[loop.header] : null;
  const headerAddress = headerBlock ? iv._blockAddress?.(loop.header) : null;
  let branchContinues = target != null && headerAddress != null && BigInt(target) === BigInt(headerAddress);

  let cond = term.cond || term.extra?.cond || null;
  if (!cond) return null;
  if (!branchContinues) cond = inverseCondition(cond) || cond;
  const info = COND[cond];
  if (!info) return null;

  const flags = valueOf(term.args?.[term.args.length - 1]);
  const cmp = flags?.def;
  if (!cmp || cmp.op !== OP.CMP || cmp.args.length < 2) return null;
  const inside = (iv.phi?.incoming || []).find((x) => loop.nodes.has(x.from))?.value || null;
  const render = (v) => {
    if (same(v, iv.value) || same(v, inside)) return iv.name;
    const c = constantText(v);
    return c != null ? c : null;
  };
  const a = render(valueOf(cmp.args[0]));
  const b = render(valueOf(cmp.args[1]));
  if (!a || (!info.vsZero && !b)) return null;
  return info.vsZero ? `${a} ${info.op} 0` : `${a} ${info.op} ${b}`;
}

/**
 * Repair the one canonical loop form that the general region structurer cannot
 * represent naturally: a single Basic Block that updates a PHI induction value
 * and conditionally branches back to itself (source-level do/while).
 *
 * This is intentionally narrow. We require SSA PHI proof, a constant step, one
 * loop exit, a self back-edge, and no already-emitted side effects in the loop
 * body. If any proof is missing, the faithful goto form is left untouched.
 */
export function repairCanonicalPostTestLoop(result, blockAddress) {
  if (!result?.semantic || !result.ir || !result.ctx?.inductions?.length) return result;
  if ((result.lines || []).some((l) => /\b(?:for|while)\s*\(|\bdo\s*\{/.test(l.text || ''))) return result;

  for (const iv0 of result.ctx.inductions) {
    const loop = iv0.loop;
    if (!loop || loop.nodes?.size !== 1 || loop.exits?.size !== 1 || !loop.nodes.has(loop.header)) continue;
    const block = result.ir.blocks?.[loop.header];
    if (!block || block.succ?.length !== 2 || !block.succ.includes(loop.header)) continue;
    if (iv0.step == null || !iv0.init) continue;

    const term = iv0.conditionInst;
    if (!term || term.op !== OP.CBR) continue;
    const emittedSideEffects = (result.lines || []).filter((l) =>
      l.row != null && l.row >= block.startRow && l.row <= block.endRow &&
      l.kind === 'stmt' && !/^goto\s+loc_/.test(l.text || ''));
    if (emittedSideEffects.length) continue;

    const iv = { ...iv0, _ir: result.ir, _blockAddress: blockAddress };
    const cond = continuationCondition(iv);
    const init = iv.initText || constantText(iv.init);
    if (!cond || !init) continue;

    const headerAddr = blockAddress(loop.header);
    const label = `loc_${hex(headerAddr)}`;
    const branchIndex = (result.lines || []).findIndex((l) =>
      l.row === term.row && typeof l.text === 'string' && l.text.includes(`goto ${label}`));
    if (branchIndex < 0) continue;

    const type = result.types?.values?.get(iv.value.id)?.name;
    const typeName = !type || type === 'unknown' ? 'int64' : type;
    const step = iv.step === 1n ? `${iv.name}++;` : iv.step === -1n ? `${iv.name}--;` : `${iv.name} += ${iv.step};`;
    const indent = result.lines[branchIndex].indent || 1;
    const replacement = [
      { kind: 'stmt', indent, text: `${typeName} ${iv.name} = ${init};`, row: block.startRow, addr: headerAddr, note: null },
      { kind: 'ctrl', indent, text: 'do {', row: block.startRow, addr: headerAddr, note: null },
      { kind: 'stmt', indent: indent + 1, text: step, row: term.row, addr: term.address ?? null, note: null },
      { kind: 'ctrl', indent, text: `} while (${cond});`, row: term.row, addr: term.address ?? null, note: null },
    ];

    // Remove the explicit conditional back-edge and its immediately following
    // explicit exit edge; normal fallthrough then reaches the already-emitted
    // exit block. This preserves exactly the proven loop and no more.
    let end = branchIndex + 1;
    if (result.lines[end] && /^goto\s+loc_/.test(result.lines[end].text || '')) end++;
    result.lines.splice(branchIndex, end - branchIndex, ...replacement);
    result.pseudocode = result.lines.map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
    result.warnings = (result.warnings || []).filter((w) => !/control-flow edge/.test(w));
    result.ctx.loopRepair = 'ssa-post-test';
    return result;
  }
  return result;
}
