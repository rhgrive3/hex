from pathlib import Path

# IR truncation/ABI result claims.
p=Path('js/ir-core.js'); t=p.read_text()
old="""function lift(insn) {
  const base = (insn.mnemonic || '').toLowerCase();
"""
new="""function callResultLocation(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  if (proto.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  }
  if (type || cls || proto.returnsValue === true) return { reg:'x0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  return null;
}

function lift(insn, opts = {}) {
  const base = (insn.mnemonic || '').toLowerCase();
"""
if t.count(old)!=1: raise SystemExit('lift signature mismatch')
t=t.replace(old,new)
old="""  if (insn.isReturn) { push({ op: OP.RET, srcs: [{ t: 'reg', reg: 'x0', bits: 64 }] }); return out; }
  if (insn.isCall) {
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg')
        ? [{ t: 'reg', reg: regKeyOf(ops[0]), bits: 64 }] : [],
      dstReg: 'x0', dstBits: 64,
      clobbers: CALL_CLOBBERS,
    });
    return out;
  }
"""
new="""  // AAPCS64 does not define a universal return register. Without prototype
  // evidence RET carries only control-flow semantics; consumers may recover a
  // return value from typed reaching definitions separately.
  if (insn.isReturn) { push({ op: OP.RET, srcs: [] }); return out; }
  if (insn.isCall) {
    const result = callResultLocation(insn, opts);
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg')
        ? [{ t: 'reg', reg: regKeyOf(ops[0]), bits: 64 }] : [],
      dstReg: result?.reg || null, dstBits: result?.bits || 64,
      returnEvidence: result ? 'prototype' : null,
      clobbers: CALL_CLOBBERS,
    });
    return out;
  }
"""
if t.count(old)!=1: raise SystemExit('RET/CALL lift block mismatch')
t=t.replace(old,new)
old="""  const insns = model.instructions.length > MAX_INSTRUCTIONS
    ? model.instructions.slice(0, MAX_INSTRUCTIONS)
    : model.instructions;

  const cfg = o.cfg || buildCfg(model, o);
"""
new="""  const truncatedByBudget = model.instructions.length > MAX_INSTRUCTIONS;
  const insns = truncatedByBudget ? model.instructions.slice(0, MAX_INSTRUCTIONS) : model.instructions;

  // The CFG and lifted instruction universe must be identical. A full-function
  // CFG paired with a 6000-instruction IR creates successors/PHIs whose defining
  // instructions do not exist. Clip block metadata to the same final row and
  // deliberately ignore a caller-supplied full CFG when the IR budget truncates.
  const maxRow = insns.length ? insns[insns.length - 1].row : -1;
  const cfgModel = truncatedByBudget ? {
    ...model,
    instructions: insns,
    basicBlocks: (model.basicBlocks || []).filter((b) => b.startRow <= maxRow).map((b) => ({
      ...b, endRow: Math.min(b.endRow, maxRow),
      rows: Array.isArray(b.rows) ? b.rows.filter((r) => r <= maxRow) : b.rows,
    })),
    semantic: (model.semantic || []).filter((b) => b.startRow <= maxRow).map((b) => ({ ...b, endRow: Math.min(b.endRow, maxRow) })),
  } : model;
  const cfg = truncatedByBudget ? buildCfg(cfgModel, o) : (o.cfg || buildCfg(cfgModel, o));
"""
if t.count(old)!=1: raise SystemExit('IR truncation block mismatch')
t=t.replace(old,new)
old="""    try { parts = lift(insn); } catch { parts = []; }
"""
new="""    try { parts = lift(insn, o); } catch { parts = []; }
"""
if t.count(old)!=1: raise SystemExit('lift call mismatch')
t=t.replace(old,new)
p.write_text(t)

# CFG edge correctness and O(log B) row lookup.
p=Path('js/cfg.js'); t=p.read_text()
old="""  const blockAtRow = (row) => {
    for (let i = 0; i < blocks.length; i++) {
      if (row >= blocks[i].startRow && row <= blocks[i].endRow) return i;
    }
    return -1;
  };
"""
new="""  // Preserve original block indices while indexing row intervals once.
  // Optimized/cold blocks need not be address ordered, so sort a side index and
  // binary-search it rather than repeatedly scanning all blocks.
  const blockIntervals = blocks.map((b, index) => ({ index, start:b.startRow, end:b.endRow }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  const blockAtRow = (row) => {
    let lo = 0, hi = blockIntervals.length - 1, candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blockIntervals[mid].start <= row) { candidate = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    for (let i = candidate; i >= 0 && blockIntervals[i].start <= row; i--) {
      if (row <= blockIntervals[i].end) return blockIntervals[i].index;
      if (blockIntervals[i].end < row && i < candidate - 1) break;
    }
    return -1;
  };
"""
if t.count(old)!=1: raise SystemExit('blockAtRow mismatch')
t=t.replace(old,new)
old="""        node.succ.push({ to: -1, kind: EDGE.JUMP, target: term.branchTarget, outside: true });
        node.isExit = true;
"""
new="""        node.succ.push({ to: -1, kind: isUncond ? EDGE.JUMP : EDGE.TAKEN, target: term.branchTarget, outside: true });
        // A conditional external target still has a local fallthrough path; it
        // is not an unconditional function exit.
        if (isUncond) node.isExit = true;
"""
if t.count(old)!=1: raise SystemExit('external edge mismatch')
t=t.replace(old,new)
old="""        kind: merge === a || merge === c ? 'if' : 'if-else',
        at: n.index, thenBlock: c, elseBlock: a, merge,
"""
new="""        kind: merge === a || merge === c ? 'if' : 'if-else',
        // TAKEN is the true branch; FALL is the false branch.
        at: n.index, thenBlock: a, elseBlock: c, merge,
"""
if t.count(old)!=1: raise SystemExit('then/else mapping mismatch')
t=t.replace(old,new)
p.write_text(t)

Path('tests/issues-129-134.mjs').write_text(r'''import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { buildCfg, EDGE } from '../js/cfg.js';

const BASE=0x100000000n;
function make(lines){
  const raw=lines.map((text,row)=>{const p=text.indexOf(' ');return {row,address:BASE+BigInt(row*4),mn:p<0?text:text.slice(0,p),ops:p<0?'':text.slice(p+1)}});
  const rowOfAddress=(a)=>{const d=BigInt(a)-BASE;return d>=0n&&d<BigInt(raw.length*4)?Number(d/4n):null};
  return {model:buildSemanticModel(raw,{startRow:0,endRow:raw.length-1,rowOfAddress}),rowOfAddress};
}

// #130: an untyped RET must not invent x0 as a semantic source.
{
  const {model,rowOfAddress}=make(['ret']);
  const ir=buildIR(model,{rowOfAddress});
  const ret=ir.instructions.find((i)=>i.op===OP.RET);
  assert.equal(ret.args.length,0);
}
// #131: an unknown CALL has no fabricated result; typed evidence may select v0.
{
  const target=BASE+8n;
  const {model,rowOfAddress}=make([`bl #0x${target.toString(16)}`,'ret','ret']);
  let ir=buildIR(model,{rowOfAddress});
  assert.equal(ir.instructions.find((i)=>i.op===OP.CALL).dst,null);
  ir=buildIR(model,{rowOfAddress,callPrototypeFor:()=>({returnType:'double',returnClass:'fp',returnBits:64})});
  assert.equal(ir.instructions.find((i)=>i.op===OP.CALL).dst?.reg,'v0');
}
// #132: conditional branch outside function is TAKEN, while fallthrough remains local.
{
  const raw=[{row:0,address:BASE,mn:'b.eq',ops:'#0x200000000'},{row:1,address:BASE+4n,mn:'ret',ops:''}];
  const model=buildSemanticModel(raw,{startRow:0,endRow:1,rowOfAddress:()=>null});
  const cfg=buildCfg(model,{rowOfAddress:()=>null});
  assert.ok(cfg.nodes[0].succ.some((s)=>s.outside&&s.kind===EDGE.TAKEN));
  assert.ok(cfg.nodes[0].succ.some((s)=>s.kind===EDGE.FALL));
}
// #133: taken successor is thenBlock, fallthrough successor is elseBlock.
{
  const {model,rowOfAddress}=make(['cmp w0, #0',`b.eq #0x${(BASE+16n).toString(16)}`,'mov w1, #1',`b #0x${(BASE+20n).toString(16)}`,'mov w1, #2','ret']);
  const cfg=buildCfg(model,{rowOfAddress});
  const shape=cfg.shapes.find((s)=>s.kind==='if-else');
  assert.ok(shape);
  const branch=cfg.nodes[shape.at];
  assert.equal(shape.thenBlock,branch.succ.find((s)=>s.kind===EDGE.TAKEN).to);
  assert.equal(shape.elseBlock,branch.succ.find((s)=>s.kind===EDGE.FALL).to);
}
console.log('issues-129-134: ok');
''')
print('patched issues 129-134')
