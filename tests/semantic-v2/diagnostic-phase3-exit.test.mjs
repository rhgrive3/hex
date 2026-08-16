import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { irFor, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { findValueUpdates, amountOf } from '../../js/dataflow.js';
import { semanticFacts } from '../../js/semantic.js';
import { summarizeFunction } from '../../js/interproc.js';
import { symbolicExecute } from '../../js/symbolic/executor.js';
import { decompile } from '../../js/decompile.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const json = (x) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? `${v}n` : v);
function modelOf(lines, opts = {}) {
  const base = opts.base ?? BASE;
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return { row, address:base + BigInt(row * 4), mn:split < 0 ? line : line.slice(0, split), ops:split < 0 ? '' : line.slice(split + 1) };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - base;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return { model:buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress, name:opts.name || null, symbolFor:opts.symbolFor || (() => null) }), rowOfAddress };
}
function v(x) { return x ? { id:x.id, kind:x.kind, reg:x.reg, bits:x.bits, const:x.const, def:x.def ? { op:x.def.op, sub:x.def.sub, row:x.def.row } : null } : null; }
function i(x) { return x ? { op:x.op, sub:x.sub, row:x.row, cond:x.cond, dst:v(x.dst), args:(x.args || []).map((a) => v(a?.value)), loc:x.loc ? { kind:x.loc.kind, key:x.loc.key, disp:x.loc.disp, address:x.loc.address } : null, addr:x.addr ? { baseReg:x.addr.baseReg, disp:x.addr.disp, precise:x.addr.precise } : null, returnReg:x.returnReg, kind:x.extra?.kind, target:x.extra?.target } : null; }
function o(x) { return x ? { kind:x.kind, disp:x.disp, row:x.row, base:x.base, locationKey:x.locationKey } : null; }

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  {
    const { model } = modelOf(['mov x19, x0','ldr w9, [x20, #0x30]','ldr w8, [x19, #0x20]','sub w8, w8, w9','str w8, [x19, #0x20]','ret']);
    const updates = findValueUpdates(model);
    console.log('P3_AMOUNT', json(updates.map((u) => ({ loc:{disp:u.location?.disp,key:u.location?.key}, steps:u.steps.map((s) => ({op:s.op,row:s.row,other:s.other,otherOrigin:o(s.otherOrigin)})), amount:{ amount:o(amountOf(model,u)?.amount), ops:amountOf(model,u)?.ops } }))));
  }
  {
    const { model } = modelOf(['ldr w8, [x19, #0x20]','add w8, w8, w21','cmp w8, w22','csel w8, w22, w8, gt','str w8, [x19, #0x20]','ret']);
    const ir = irFor(model);
    console.log('P3_CLAMP', json({ instructions:ir.instructions.map(i), facts:semanticFacts(ir).map((f) => ({kind:f.kind,row:f.row,relation:f.relation,clampKind:f.clampKind})) }));
  }
  {
    const { model } = modelOf(['ldr w8, [x19, #0x20]','add w8, w8, #5','str w8, [x19, #0x30]','ret']);
    const ir = irFor(model);
    console.log('P3_TRANSFER', json({ memory:ir.instructions.filter((x) => x.op === OP.LOAD || x.op === OP.STORE).map(i), facts:semanticFacts(ir).map((f) => ({kind:f.kind,row:f.row,source:f.source ? {kind:f.source.kind,disp:f.source.disp} : null,sink:f.sink ? {kind:f.sink.kind,disp:f.sink.disp} : null})) }));
  }
  {
    const { model } = modelOf(['add x0, x0, #5','ret']);
    const ir = irFor(model, { returnType:'int64', decoderSemanticVersion:'diag-wrapper' });
    const summary = summarizeFunction(model, { returnEvidence:true, ir:{ returnType:'int64', decoderSemanticVersion:'diag-wrapper-summary' } });
    console.log('P3_WRAPPER', json({ instructions:ir.instructions.map(i), args:[...(ir.args?.entries?.() || [])].map(([k,x]) => [k,v(x)]), returns:summary?.returns, classification:summary?.classification }));
  }
  {
    const { model } = modelOf(['cmp x0, #0','b.le #0x100000010','mov x0, #1','ret','mov x0, #0','ret']);
    const ir = irFor(model);
    const result = symbolicExecute(ir, { timeoutMs:1000 });
    console.log('P3_SYMBOLIC', json({ instructions:ir.instructions.map(i), args:[...(ir.args?.entries?.() || [])].map(([k,x]) => [k,v(x)]), paths:result.paths.map((p) => ({status:p.status,constraints:p.constraintText,returnValue:p.returnValue})) }));
  }
  {
    const { model, rowOfAddress } = modelOf(['sub sp, sp, #16','str w0, [sp, #12]','ldr w8, [sp, #12]','add w8, w8, #1','str w8, [sp, #8]','ldr w0, [sp, #8]','add sp, sp, #16','ret']);
    const ir = irFor(model, { rowOfAddress, returnType:'int32', decoderSemanticVersion:'diag-o0' });
    const r = decompile(model, { addr:BASE, name:'diag_o0', rowOfAddress, returnType:'int32', beginner:false });
    console.log('P3_O0', json({ ret:i(ir.instructions.find((x) => x.op === OP.RET)), memory:ir.instructions.filter((x) => x.op === OP.LOAD || x.op === OP.STORE).map(i), semantic:r.semantic, outputs:r.semanticAst?.outputs, inputs:r.semanticAst?.inputs, pseudocode:r.pseudocode }));
  }
  {
    const base = 0x100000490n, PUTS = 0x100001000n;
    const fixture = modelOf(['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4',`bl #0x${PUTS.toString(16)}`,'ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'], { base, name:'apply_damage', symbolFor:(addr) => BigInt(addr) === PUTS ? '_puts' : null });
    fixture.model.calls = [{ row:16, name:'_puts', target:PUTS }];
    attachTexts(fixture.model, new Map([['4294968756', 'damage dealt to enemy']]));
    const r = decompile(fixture.model, { addr:base, name:'apply_damage', rowOfAddress:fixture.rowOfAddress, returnType:'int32', receiverType:'Unit', beginner:false, symbolFor:(addr) => BigInt(addr) === PUTS ? '_puts' : null, fieldFor:(_base, off) => off === 0x20n ? { name:'hp', type:'int32' } : off === 0x24n ? { name:'damageRate', type:'uint32' } : null });
    console.log('P3_DECOMP', json({ semantic:r.semantic, legacyFallback:r.legacyFallback, warnings:r.warnings, unsupported:r.ctx?.semanticIRFallback?.unsupportedInstructions ?? r.ctx?.unknownInstructions, unknowns:r.ir?.instructions?.filter((x) => x.op === OP.UNKNOWN).map(i) }));
  }
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}
console.log('phase3 exit diagnostics: PASS');