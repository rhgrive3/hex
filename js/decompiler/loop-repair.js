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
  const branchContinues = target != null && headerAddress != null && BigInt(target) === BigInt(headerAddress);

  let cond = term.cond || term.extra?.cond || null;
  if (!cond) return null;
  if (!branchContinues) cond = inverseCondition(cond) || cond;
  const info = COND[cond];
  if (!info) return null;

  const flags = valueOf(term.args?.[term.args.length - 1]);
  const cmp = flags?.def;
  if (!cmp || cmp.op !== OP.CMP || cmp.args.length < 2) return null;
  const inside = iv.inside || (iv.phi?.incoming || []).find((x) => loop.nodes.has(x.from))?.value || null;
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

function termOf(block) {
  const xs = block?.insts || [];
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i].op === OP.CBR) return xs[i];
  return null;
}

function discoverPostTestInduction(result, loop, ordinal) {
  const block = result.ir?.blocks?.[loop.header];
  const term = termOf(block);
  if (!block || !term) return null;
  const flags = valueOf(term.args?.[term.args.length - 1]);
  const cmp = flags?.def;
  if (!cmp || cmp.op !== OP.CMP || cmp.args.length < 2) return null;

  for (const arg of cmp.args) {
    const updated = valueOf(arg);
    const stepDef = updated?.def;
    if (!stepDef || stepDef.op !== OP.BIN || !['add', 'sub'].includes(stepDef.sub)) continue;
    const a = valueOf(stepDef.args?.[0]);
    const b = valueOf(stepDef.args?.[1]);
    let prior = null, step = null;
    if (a && b?.const != null) {
      prior = a;
      step = stepDef.sub === 'add' ? b.const : -b.const;
    } else if (stepDef.sub === 'add' && b && a?.const != null) {
      prior = b;
      step = a.const;
    }
    if (!prior || step == null || step === 0n) continue;

    let init = null, phi = null;
    if (prior.def?.op === OP.PHI) {
      phi = prior.def;
      const outside = (phi.incoming || []).find((x) => !loop.nodes.has(x.from));
      init = outside?.value || null;
    }
    if (!init && prior.const != null) init = prior;
    if (!init) continue;

    return {
      loop, phi, value: prior, inside: updated,
      name: ordinal ? `i${ordinal}` : 'i', init, step,
      conditionInst: term, initText: constantText(init), conditionText: null,
      discoveredFrom: 'ir-def-use',
    };
  }
  return null;
}

function replacementRange(lines, term, label) {
  // Faithful/linear form: if (cond) goto header; goto exit;
  let start = lines.findIndex((l) =>
    typeof l.text === 'string' && l.text.includes(`goto ${label}`) &&
    (l.row === term.row || /^if\s*\(/.test(l.text)));
  if (start >= 0) {
    let end = start + 1;
    if (lines[end] && /^goto\s+loc_/.test(lines[end].text || '')) end++;
    return { start, end };
  }

  // Region structurer form: if (cond) { goto header; } else { ... }
  // The goto inserted for an already-visited block has no source row, so locate
  // the source CBR first and prove that its then-arm contains this back-edge.
  start = lines.findIndex((l) => l.row === term.row && /^if\s*\(.+\)\s*\{$/.test(l.text || ''));
  if (start < 0) return null;
  let hasBackEdge = false;
  let end = -1;
  const indent = lines[start].indent || 0;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i].text || '';
    if (text.includes(`goto ${label}`)) hasBackEdge = true;
    if ((lines[i].indent || 0) === indent && text === '}') { end = i + 1; break; }
  }
  return hasBackEdge && end > start ? { start, end } : null;
}

/**
 * Repair the canonical post-test loop that a generic if/else region pass can
 * accidentally consume first: one Basic Block updates an induction value and
 * conditionally branches back to itself (source-level do/while).
 *
 * The preferred proof is the normal PHI induction recovery. If that helper was
 * too strict, this pass independently verifies the same fact from IR def-use:
 * BIN with constant step -> CMP -> CBR self, plus a proven outside PHI initial
 * value. It never reparses ARM64 text and never invents a loop from addresses.
 */
export function repairCanonicalPostTestLoop(result, blockAddress) {
  if (!result?.semantic || !result.ir) return result;
  if ((result.lines || []).some((l) => /\b(?:for|while)\s*\(|\bdo\s*\{/.test(l.text || ''))) return result;

  const byHeader = new Map();
  for (const iv of result.ctx?.inductions || []) byHeader.set(iv.loop?.header, iv);
  let ordinal = byHeader.size;

  for (const loop of result.ir.loops || []) {
    if (!loop || loop.nodes?.size !== 1 || loop.exits?.size !== 1 || !loop.nodes.has(loop.header)) continue;
    const block = result.ir.blocks?.[loop.header];
    if (!block || block.succ?.length !== 2 || !block.succ.includes(loop.header)) continue;

    const iv0 = byHeader.get(loop.header) || discoverPostTestInduction(result, loop, ordinal++);
    if (!iv0 || iv0.step == null || !iv0.init) continue;
    const term = iv0.conditionInst || termOf(block);
    if (!term || term.op !== OP.CBR) continue;

    // Pure register SSA updates are not emitted as standalone statements. If a
    // memory write/call/other side effect is already visible in this block, a
    // narrow repair cannot safely reorder it, so retain faithful control flow.
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
    const range = replacementRange(result.lines || [], term, label);
    if (!range) continue;

    const type = result.types?.values?.get(iv.value.id)?.name;
    const typeName = !type || type === 'unknown' ? 'int64' : type;
    const step = iv.step === 1n ? `${iv.name}++;` : iv.step === -1n ? `${iv.name}--;` : `${iv.name} += ${iv.step};`;
    const indent = result.lines[range.start].indent || 1;
    const replacement = [
      { kind: 'stmt', indent, text: `${typeName} ${iv.name} = ${init};`, row: block.startRow, addr: headerAddr, note: null },
      { kind: 'ctrl', indent, text: 'do {', row: block.startRow, addr: headerAddr, note: null },
      { kind: 'stmt', indent: indent + 1, text: step, row: term.row, addr: term.address ?? null, note: null },
      { kind: 'ctrl', indent, text: `} while (${cond});`, row: term.row, addr: term.address ?? null, note: null },
    ];

    result.lines.splice(range.start, range.end - range.start, ...replacement);
    result.pseudocode = result.lines.map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n');
    result.warnings = (result.warnings || []).filter((w) => !/control-flow edge/.test(w));
    result.ctx = { ...(result.ctx || {}), loopRepair: iv0.discoveredFrom || 'ssa-post-test' };
    return result;
  }
  return result;
}
