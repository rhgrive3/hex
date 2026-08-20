import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Emulator } from '../js/emu.js';
import { buildSemanticModel } from '../js/blocks.js';
import { buildValues, bin, constNode, constOf, render } from '../js/expr.js';
import { findValueUpdates, amountOf } from '../js/dataflow.js';
import { summarizeFunction } from '../js/interproc.js';
import { sanitizePointer } from '../js/objc-legacy.js';
import { FieldIndex } from '../js/fields.js';
import { buildIR, OP, mustAlias, mayAliasProvenance, getSemanticMigrationMode, setSemanticMigrationMode } from '../js/ir.js';

const BASE = 0x730000000n;
function model(lines, base = BASE) {
  const rows = lines.map((line,row) => { const text=String(line).trim(), i=text.indexOf(' '); return { row, address:base+BigInt(row)*4n, mn:i<0?text:text.slice(0,i), ops:i<0?'':text.slice(i+1) }; });
  const rowOfAddress = (address) => { const d=BigInt(address)-base; return d<0n||d>=BigInt(rows.length*4)?null:Number(d/4n); };
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress});
}
function valueAt(lines,row,reg) { return buildValues(model(lines)).defAt(row,reg); }
async function exec(emu,mn,ops) { return emu.execute(mn,ops,0x1000n); }

// #789: A64 SDIV/UDIV divisor zero is exactly zero, width-exact.
assert.equal(constOf(bin('sdiv',constNode(123n),constNode(0n),64)),0n);
assert.equal(constOf(bin('udiv',constNode(123n),constNode(0n),32)),0n);
assert.equal(constOf(bin('sdiv',constNode(-0x80000000n),constNode(-1n),32)),-0x80000000n);

// #801: nested signed division preserves the observable intermediate 32-bit wrap.
assert.equal(constOf(valueAt(['mov w0, #0x80000000','mov w1, #-1','sdiv w2, w0, w1','mov w3, #2','sdiv w4, w2, w3'],4,'x4')),0xc0000000n);

// #819: same-address loads separated by a store are not folded as one value.
{
  const v=valueAt(['ldr x0, [x1]','str x2, [x1]','ldr x3, [x1]','sub x4, x0, x3'],3,'x4');
  assert.notEqual(constOf(v),0n);
}

// #820: a partially overlapping stack store invalidates the prior wider cached value.
{
  const v=valueAt(['str x0, [sp, #0]','str w1, [sp, #4]','ldr x2, [sp, #0]'],2,'x2');
  assert.equal(v?.k,'mem');
}

// #821: SBFX sign extends; UBFX does not.
assert.equal(constOf(valueAt(['mov x1, #0x80','sbfx x0, x1, #0, #8'],1,'x0')),-128n);
assert.equal(constOf(valueAt(['mov x1, #0x80','ubfx x0, x1, #0, #8'],1,'x0')),128n);
assert.equal(constOf(valueAt(['mov w1, #0x80','sbfx w0, w1, #0, #8'],1,'x0')),0xffffff80n);

// #822: carry/overflow producers are not rewritten as ordinary result-vs-zero comparisons.
assert.equal(constOf(valueAt(['mov w1, #0xffffffff','mov w2, #1','adds w0, w1, w2','cset w3, cs'],3,'x3')),1n);
assert.equal(constOf(valueAt(['mov w0, #1','mov w1, #1','bics wzr, w0, w1','cset w2, ne'],3,'x2')),0n);
{
  const n=valueAt(['subs w0, w1, w2','cset w3, cs'],1,'x3');
  const core=n?.k==='un'&&n.op==='uxt32'?n.a:n;
  assert.ok(core?.cmp,'SUBS must remain compare-compatible');
  assert.equal(core?.predicate ?? null,null);
  assert.ok(!render(n).includes('NZCV'));
}

// #790: non-commutative computation paths retain source operand side.
{
  const left=model(['ldr w8, [x19, #0x20]','mov w9, #10','sub w10, w8, w9','str w10, [x19, #0x30]','ret']);
  const right=model(['ldr w8, [x19, #0x20]','mov w9, #10','sub w10, w9, w8','str w10, [x19, #0x30]','ret']);
  const lu=findValueUpdates(left).find(u=>u.store?.row===3), ru=findValueUpdates(right).find(u=>u.store?.row===3);
  assert.equal(lu.steps.at(-1).sourceOperandIndex,0); assert.equal(ru.steps.at(-1).sourceOperandIndex,1);
  assert.equal(amountOf(left,lu).amount.sourceOnLeft,true); assert.equal(amountOf(right,ru).amount.sourceOnLeft,false);
}

// #806: implicit same-instruction W->X view remains transparent, real truncation does not.
{
  const good=summarizeFunction(model(['add w0, w0, #1','ret']),{returnEvidence:true});
  assert.equal(good.classification.simpleArithmeticWrapper,true);
  assert.equal(good.returns[0].bits,32);
  const truncated=summarizeFunction(model(['add x1, x0, #1','mov w0, w1','ret']),{returnEvidence:true});
  assert.equal(truncated.classification.simpleArithmeticWrapper,false);
}

// #807: explicit dyld formats are bit-exact; bind/unknown formats fail closed.
{
  const target=0x123456789n, high8=0xABn, raw=target|(high8<<36n);
  assert.equal(sanitizePointer(raw,0x100000000n,2),0xAB00000123456789n);
  assert.equal(sanitizePointer(target,0x100000000n,6),0x223456789n);
  assert.equal(sanitizePointer(raw|(1n<<63n),0x100000000n,2),null);
  assert.equal(sanitizePointer(raw,0x100000000n,999),null);
  // legacy/no-format behavior remains available rather than silently selecting a format.
  assert.notEqual(sanitizePointer(raw,0x100000000n),null);
}

// #827/#828: compat stack coordinates are total/signed and forwarding is width exact.
function compatIR(lines) {
  const m=model(lines); const prev=getSemanticMigrationMode(); setSemanticMigrationMode('semantic-v2-compat');
  try { return buildIR(m); } finally { setSemanticMigrationMode(prev); }
}
{
  const ir=compatIR(['add x29, sp, #16','str x0, [x29, #-8]','ldr x1, [sp, #8]','ldr x2, [sp, #-8]','ret']);
  const a=ir.instructions.filter(i=>i.op===OP.LOAD||i.op===OP.STORE);
  assert.equal(a[0].loc.disp,8n); assert.equal(a[1].loc.disp,8n); assert.equal(a[2].loc.disp,-8n);
  assert.equal(mustAlias(a[0].loc,a[1].loc),true); assert.equal(mustAlias(a[0].loc,a[2].loc),false);
  assert.notEqual(a[0].loc.key,a[2].loc.key,'distinct signed SP coordinates must not share one location identity');
}
{
  const ir=compatIR(['str x0, [sp, #0]','ldr w1, [sp, #0]','ldr x2, [sp, #0]','ret']);
  const a=ir.instructions.filter(i=>i.op===OP.LOAD||i.op===OP.STORE);
  assert.equal(a[1].reachingStore,undefined,'store64 must not compat-forward into load32');
  assert.ok(a[2].reachingStore,'same-width exact stack access may forward');
}

// #832 source invariant: cross-kind GLOBAL clobber is conservative while local STACK separation is proof-gated.
{
  const src=fs.readFileSync(new URL('../js/architecture/compat/ir-core-arm64-aapcs64-v1.js',import.meta.url),'utf8');
  assert.match(src,/pair\.has\(MK\.FIELD\).*pair\.has\(MK\.GLOBAL\).*return true/s);
  assert.match(src,/pair\.has\(MK\.FIELD\).*pair\.has\(MK\.STACK\).*stackPointerProvenanceOf/s);
}

// #838: entry-self provenance is produced by IR; call-return x0 loses it. FieldIndex trusts only that proof.
{
  const fields=new FieldIndex({classes:[{name:'Player',instanceSize:64,ivars:[{name:'_hp',offset:32,size:4}],properties:[],methods:[],classMethods:[]}]});
  const entry=model(['ldr w8, [x0, #0x20]','add w8, w8, #1','str w8, [x0, #0x20]','ret']);
  const eu=findValueUpdates(entry).find(u=>u.store?.row===2); assert.equal(eu.location.self,true);
  assert.equal(fields.resolveAccess({base:'x0',disp:32n,self:eu.location.self},'Player').certain,true);
  const post=model(['bl #0x730001000','ldr w8, [x0, #0x20]','add w8, w8, #1','str w8, [x0, #0x20]','ret']);
  const pu=findValueUpdates(post).find(u=>u.store?.row===3);
  assert.ok(!pu?.location?.self);
  assert.equal(fields.resolveAccess({base:'x0',disp:32n,self:pu?.location?.self===true},'Player').certain,false);
}

// #833 — GPR<->FP and FP<->FP FMOV preserve raw IEEE bits.
{
  const emu=new Emulator(); emu.set('x0',0x7ff8123456789abcn); await exec(emu,'fmov','d0, x0'); await exec(emu,'fmov','x1, d0');
  assert.equal(emu.get('x1'),0x7ff8123456789abcn);
  emu.set('w2',0x80000000n); await exec(emu,'fmov','s1, w2'); await exec(emu,'fmov','w3, s1'); assert.equal(emu.get('w3'),0x80000000n);
  await exec(emu,'fmov','d2, d0'); await exec(emu,'fmov','x4, d2'); assert.equal(emu.get('x4'),0x7ff8123456789abcn);
}

// #803 — FMADD is single-rounding fused and differs from FMUL+FADD counterexamples.
{
  const emu=new Emulator();
  for (const [r,b] of [['w0',0x3f800001n],['w1',0x3f7ffffen],['w2',0xbf800000n]]) emu.set(r,b);
  await exec(emu,'fmov','s0, w0'); await exec(emu,'fmov','s1, w1'); await exec(emu,'fmov','s2, w2');
  await exec(emu,'fmadd','s3, s0, s1, s2'); await exec(emu,'fmov','w3, s3'); assert.equal(emu.get('w3'),0xa8800000n);
  await exec(emu,'fmul','s4, s0, s1'); await exec(emu,'fadd','s4, s4, s2'); await exec(emu,'fmov','w4, s4'); assert.notEqual(emu.get('w4'),emu.get('w3'));
}
{
  const emu=new Emulator();
  for (const [r,b] of [['x0',0x3ff0000000000001n],['x1',0x3feffffffffffffen],['x2',0xbff0000000000000n]]) emu.set(r,b);
  await exec(emu,'fmov','d0, x0'); await exec(emu,'fmov','d1, x1'); await exec(emu,'fmov','d2, x2');
  await exec(emu,'fmadd','d3, d0, d1, d2'); await exec(emu,'fmov','x3, d3'); assert.equal(emu.get('x3'),0xb970000000000000n);
}

console.log('reopened 31 reconciliation focused regressions: PASS');
