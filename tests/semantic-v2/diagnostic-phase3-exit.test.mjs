import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { irFor, setSemanticMigrationMode, OP, readModifyWrite } from '../../js/ir.js';
import { findValueUpdates, amountOf } from '../../js/dataflow.js';
import { semanticFacts } from '../../js/semantic.js';
import { summarizeFunction } from '../../js/interproc.js';
import { symbolicExecute } from '../../js/symbolic/executor.js';
import { decompile } from '../../js/decompile.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100000000n;
const json = (value) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? `${v}n` : v);
function modelOf(lines, opts = {}) {
  const base = opts.base ?? BASE;
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return { row, address: base + BigInt(row * 4), mn: split < 0 ? line : line.slice(0, split), ops: split < 0 ? '' : line.slice(split + 1) };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - base;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return { model: buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress, name:opts.name || null, symbolFor:opts.symbolFor || (() => null) }), rowOfAddress, base };
}
function value(v) {
  if (!v) return null;
  return { id:v.id, kind:v.kind, reg:v.reg, bits:v.bits, const:v.const, semanticValueId:v.semanticValueId, semanticSsaValueId:v.semanticSsaValueId, def:v.def ? { id:v.def.id, op:v.def.op, sub:v.def.sub, row:v.def.row } : null };
}
function inst(i) {
  if (!i) return null;
  return { id:i.id, op:i.op, sub:i.sub, row:i.row, cond:i.cond, dst:value(i.dst), args:(i.args || []).map((a) => value(a?.value)), loc:i.loc ? { kind:i.loc.kind, key:i.loc.key, disp:i.loc.disp, base:i.loc.base, address:i.loc.address } : null, returnReg:i.returnReg, extra:i.extra };
}

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);

  {
    const { model } = modelOf(['mov x19, x0','ldr w9, [x20, #0x30]','ldr w8, [x19, #0x20]','sub w8, w8, w9','str w8, [x19, #0x20]','ret']);
    const updates = findValueUpdates(model);
    console.log('P3_DIAG_AMOUNT', json(updates.map((u) => ({ location:u.location, steps:u.steps, amount:amountOf(model, u), ir:{ load:inst(u.ir?.load), store:inst(u.ir?.store) } }))));
  }

  {
    const { model } = modelOf(['str w2, [x0, #0x20]','str w3, [sp, #0x10]','ldr w4, [sp, #0x10]','ret']);
    const ir = irFor(model);
    console.log('P3_DIAG_ALIAS', json({ instructions:ir.instructions.filter((i) => i.op === OP.LOAD || i.op === OP.STORE).map(inst), rmw:readModifyWrite(ir).map((r) => ({ location:r.location, load:inst(r.load), store:inst(r.store) })) }));
  }

  {
    const { model } = modelOf(['ldr w8, [x19, #0x20]','add w8, w8, w21','cmp w8, w22','csel w8, w22, w8, gt','str w8, [x19, #0x20]','ret']);
    const ir = irFor(model);
    console.log('P3_DIAG_CLAMP', json({ instructions:ir.instructions.map(inst), facts:semanticFacts(ir).map((f) => ({ kind:f.kind, row:f.row, relation:f.relation, clampKind:f.clampKind, location:f.location })) }));
  }

  {
    const { model } = modelOf(['ldr w8, [x19, #0x20]','add w8, w8, #5','str w8, [x19, #0x30]','ret']);
    const ir = irFor(model);
    console.log('P3_DIAG_TRANSFER', json({ instructions:ir.instructions.map(inst), facts:semanticFacts(ir).map((f) => ({ kind:f.kind, row:f.row, source:f.source, sink:f.sink, value:f.value })) }));
  }

  {
    const { model } = modelOf(['add x0, x0, #5','ret']);
    const ir = irFor(model, { returnType:'int64', decoderSemanticVersion:'diag-wrapper' });
    const summary = summarizeFunction(model, { returnEvidence:true, ir:{ returnType:'int64', decoderSemanticVersion:'diag-wrapper-summary' } });
    console.log('P3_DIAG_WRAPPER', json({ instructions:ir.instructions.map(inst), args:[...(ir.args?.entries?.() || [])].map(([k,v]) => [k,value(v)]), summary }));
  }

  {
    const { model } = modelOf(['cmp x0, #0','b.le #0x100000010','mov x0, #1','ret','mov x0, #0','ret']);
    const ir = irFor(model);
    const result = symbolicExecute(ir, { timeoutMs:1000 });
    console.log('P3_DIAG_SYMBOLIC', json({ instructions:ir.instructions.map(inst), args:[...(ir.args?.entries?.() || [])].map(([k,v]) => [k,value(v)]), paths:result.paths.map((p) => ({ constraints:p.constraintText, returnValue:p.returnValue })) }));
  }

  {
    const { model, rowOfAddress } = modelOf(['sub sp, sp, #16','str w0, [sp, #12]','ldr w8, [sp, #12]','add w8, w8, #1','str w8, [sp, #8]','ldr w0, [sp, #8]','add sp, sp, #16','ret']);
    const ir = irFor(model, { rowOfAddress, returnType:'int32', decoderSemanticVersion:'diag-o0' });
    const r = decompile(model, { addr:BASE, name:'diag_o0', rowOfAddress, returnType:'int32', beginner:false });
    console.log('P3_DIAG_O0', json({ ret:inst(ir.instructions.find((i) => i.op === OP.RET)), instructions:ir.instructions.map(inst), pseudocode:r.pseudocode, semantic:r.semantic, semanticOutputs:r.semanticAst?.outputs, semanticInputs:r.semanticAst?.inputs, warnings:r.warnings }));
  }

  {
    const base = 0x100000490n, PUTS = 0x100001000n;
    const fixture = modelOf(['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4',`bl #0x${PUTS.toString(16)}`,'ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'], { base, name:'apply_damage', symbolFor:(addr) => BigInt(addr) === PUTS ? '_puts' : null });
    fixture.model.calls = [{ row:16, name:'_puts', target:PUTS }];
    attachTexts(fixture.model, new Map([['4294968756', 'damage dealt to enemy']]));
    const r = decompile(fixture.model, { addr:base, name:'apply_damage', rowOfAddress:fixture.rowOfAddress, returnType:'int32', receiverType:'Unit', beginner:false, symbolFor:(addr) => BigInt(addr) === PUTS ? '_puts' : null, fieldFor:(_base, off) => off === 0x20n ? { name:'hp', type:'int32' } : off === 0x24n ? { name:'damageRate', type:'uint32' } : null });
    console.log('P3_DIAG_DECOMP', json({ semantic:r.semantic, legacyFallback:r.legacyFallback, warnings:r.warnings, unknownInstructions:r.ctx?.semanticIRFallback?.unsupportedInstructions ?? r.ctx?.unknownInstructions, coverage:r.coverage, pseudocode:r.pseudocode, irUnknown:r.ir?.instructions?.filter((i) => i.op === OP.UNKNOWN).map(inst) }));
  }
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('phase3 exit diagnostics: PASS');
