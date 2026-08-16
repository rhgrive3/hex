import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { buildIR, OP, setSemanticMigrationMode } from '../../js/ir.js';
import { decompile } from '../../js/decompile.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const clean = (x) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? `${v}n` : v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
function fixture(lines, base, opts = {}) {
  const rows = lines.map((line, row) => {
    const p = line.indexOf(' ');
    return { row, address:base + BigInt(row * 4), mn:p < 0 ? line : line.slice(0,p), ops:p < 0 ? '' : line.slice(p+1) };
  });
  const rowOfAddress = (address) => {
    const d = BigInt(address) - base;
    return d < 0n || d >= BigInt(rows.length * 4) ? null : Number(d / 4n);
  };
  return { model:buildSemanticModel(rows, { startRow:0, endRow:rows.length-1, rowOfAddress, name:opts.name || null, symbolFor:opts.symbolFor || (() => null) }), rowOfAddress };
}
function iv(i) { return i ? {op:i.op,sub:i.sub,row:i.row,reg:i.reg,cond:i.cond,returnReg:i.returnReg,args:(i.args||[]).map((a)=>({reg:a?.value?.reg,kind:a?.value?.kind,bits:a?.value?.bits,def:a?.value?.def ? {op:a.value.def.op,sub:a.value.def.sub,row:a.value.def.row}:null})),loc:i.loc?{kind:i.loc.kind,disp:i.loc.disp,key:i.loc.key}:null,extra:i.extra,sourceInstructionIds:i.sourceInstructionIds}:null; }

setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
try {
  const O0 = 0x100000000n;
  const o0 = fixture(['sub sp, sp, #16','str w0, [sp, #12]','ldr w8, [sp, #12]','add w8, w8, #1','str w8, [sp, #8]','ldr w0, [sp, #8]','add sp, sp, #16','ret'], O0, {name:'o0_diag'});
  const o0ir = buildIR(o0.model, {rowOfAddress:o0.rowOfAddress,returnType:'int32',decoderSemanticVersion:'o0-diag'});
  const o0d = decompile(o0.model, {addr:O0,name:'o0_diag',rowOfAddress:o0.rowOfAddress,returnType:'int32',beginner:false});
  console.log(`::warning title=P3_O0_PUBLIC::${clean({
    ret:iv(o0ir?.instructions?.find((i)=>i.op===OP.RET)),
    memory:o0ir?.instructions?.filter((i)=>i.op===OP.LOAD||i.op===OP.STORE).map(iv),
    x0values:o0ir?.values?.filter((v)=>v.reg==='x0').map((v)=>({id:v.id,kind:v.kind,bits:v.bits,def:v.def?{op:v.def.op,sub:v.def.sub,row:v.def.row}:null,uses:(v.uses||[]).map((u)=>({op:u.op,row:u.row}))})),
    semantic:o0d.semantic,legacyFallback:o0d.legacyFallback,warnings:o0d.warnings,
    outputs:o0d.semanticAst?.outputs,inputs:o0d.semanticAst?.inputs,pseudocode:o0d.pseudocode,
  })}`);

  const base = 0x100000490n, PUTS = 0x100001000n;
  const x = fixture(['stp x29, x30, [sp, #-32]!','mov x29, sp','str x0, [sp, #16]','ldr w8, [x0, #0x20]','ldr w9, [x0, #0x24]','mul w9, w1, w9','sub w8, w8, w9','str w8, [x0, #0x20]','cmp w8, #0','b.gt #0x1000004C4','mov w8, #0','ldr x0, [sp, #16]','str w8, [x0, #0x20]','str w8, [sp, #12]','adrp x0, #0x100000000','add x0, x0, #0x5B4','bl #0x100001000','ldr w0, [sp, #12]','ldp x29, x30, [sp], #32','ret'], base, {name:'apply_damage',symbolFor:(a)=>BigInt(a)===PUTS?'_puts':null});
  x.model.calls=[{row:16,name:'_puts',target:PUTS}];
  attachTexts(x.model,new Map([['4294968756','damage dealt to enemy']]));
  const opts={addr:base,name:'apply_damage',rowOfAddress:x.rowOfAddress,returnType:'int32',receiverType:'Unit',beginner:false,symbolFor:(a)=>BigInt(a)===PUTS?'_puts':null,fieldFor:(_b,off)=>off===0x20n?{name:'hp',type:'int32'}:off===0x24n?{name:'damageRate',type:'uint32'}:null};
  const ir=buildIR(x.model,opts);
  const d=decompile(x.model,opts);
  console.log(`::warning title=P3_PROJECTED_UNKNOWN::${clean({
    unknowns:ir?.instructions?.filter((i)=>i.op===OP.UNKNOWN||i.op===OP.CLOBBER).map(iv),
    semantic:d.semantic,legacyFallback:d.legacyFallback,warnings:d.warnings,ctxUnknown:d.ctx?.unknownInstructions,
    pseudocode:d.pseudocode,
  })}`);
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}
console.log('final Phase 3 projected diagnostics: PASS');