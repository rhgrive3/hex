import assert from 'node:assert/strict';
import { matchFunctions } from '../js/recognition/matcher.js';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { buildExpressionForTesting } from '../js/decompiler/pipeline-core.js';
import { evaluateNZCVCondition, buildNZCVConditionExpression } from '../js/decompiler/flag-semantics.js';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';
import { legacyNoteKeyFor } from '../js/names.js';

const bytes=(...xs)=>Uint8Array.from(xs);
// #194: reverse-side competition alone is ambiguity.
{
  const common={bytes:bytes(1,2,3,4,5,6,7,8),cfg:{blocks:1,edges:0,exits:1},strings:['same'],imports:[]};
  const before=[{...common,address:1n},{...common,address:2n}];
  const after=[{...common,address:3n}];
  const r=matchFunctions(before,after,{threshold:0.5});
  assert.equal(r.matches.length,1); assert.equal(r.matches[0].ambiguous,true);
  assert.ok(r.matches[0].candidates.some((x)=>x.side==='before'));
}
function asm(lines, base=0x100000000n){return lines.map((line,i)=>{const s=line.trim(),sp=s.indexOf(' ');return {row:i,address:base+BigInt(i)*4n,mn:sp<0?s:s.slice(0,sp),ops:sp<0?'':s.slice(sp+1)};});}
function build(lines,opts={}){const base=0x100000000n;const rowOfAddress=(a)=>{const r=a-base;return r<0n||r>=BigInt(lines.length)*4n?null:Number(r/4n)};const model=buildSemanticModel(asm(lines,base),{startRow:0,endRow:lines.length-1,rowOfAddress});return buildIR(model,{rowOfAddress,...opts});}
// #410: caller-saved SIMD/FP regs are clobbered, while a typed v0 result survives.
{
  const ir=build(['fmov d16, #1.0','bl #0x100001000','fmov d1, d16','ret']);
  const call=ir.instructions.find((x)=>x.op===OP.CALL); assert.ok(call);
  assert.ok(ir.values.some((v)=>v.reg==='v16'&&v.def===call&&v.clobbered));
}
{
  const ir=build(['bl #0x100001000','ret'],{callPrototypeFor:()=>({returnType:'double',returnBits:64})});
  const call=ir.instructions.find((x)=>x.op===OP.CALL); assert.equal(call.dst?.reg,'v0');
}
// #411: RET is void when unknown, v0 when function prototype says floating point.
{
  const ir=build(['ret']); const ret=ir.instructions.find((x)=>x.op===OP.RET); assert.equal(ret.args.length,0);
}
{
  const ir=build(['fmov d0, #1.0','ret'],{returnType:'double'}); const ret=ir.instructions.find((x)=>x.op===OP.RET); assert.equal(ret.args[0]?.value?.reg,'v0');
}
// #412 unsigned narrow load truncates a wider stored constant.
{
  const ir=build(['mov x8, #0x1234','strb w8, [sp, #8]','ldrb w9, [sp, #8]','ret']);
  const load=ir.instructions.find((x)=>x.op===OP.LOAD); assert.equal(load.dst.const,0x34n);
}
// #413 extension then shift.
{
  const ir=build(['mov x8, #0xFFFFFFFF','add x9, x0, w8, uxtw #2','ret']);
  const v=ir.values.filter((x)=>x.reg==='x9').pop();
  // x0 is unknown, but the shifted constant operand must be represented on the BIN arg.
  const bin=v.def; assert.equal(bin.args[1].shift.op,'uxtw'); assert.equal(bin.args[1].shift.amount,2);
}
// #414 MOVN shift precedes complement; #416 MOVK source is not shifted twice.
{
  const ir=build(['movn x8, #1, lsl #16','ret']); const v=ir.values.filter((x)=>x.reg==='x8').pop(); assert.equal(v.const,BigInt.asUintN(64,~(1n<<16n)));
}
{
  const ir=build(['movz x8, #0','movk x8, #0x1234, lsl #16','ret']); const v=ir.values.filter((x)=>x.reg==='x8').pop(); assert.equal(v.const,0x12340000n);
}
// #417 UBFIZ/SBFIZ are insertion/left-shift semantics, not bit_extract.
{
  const src={id:1,bits:64,kind:'arg',reg:'x1',uses:[]}; const inst={id:1,op:'bfx',extra:{toward:'left',lsb:8,width:8,signed:false},args:[{value:src}],dst:null}; const v={id:2,bits:64,def:inst,uses:[]};inst.dst=v;
  const out=buildExpressionForTesting(v,{ir:{values:[src,v],args:new Map()},model:{calls:[]}}); assert.notEqual(out.kind==='intrinsic'&&out.name==='bit_extract',true); assert.match(printExpression(out),/<< 8/);
}
// #418 BFXIL selects source bits at lsb but inserts at destination bit 0.
{
  const old={id:1,bits:64,kind:'arg',reg:'x0',uses:[]},src={id:2,bits:64,kind:'arg',reg:'x1',uses:[]}; const inst={id:3,op:'bfi',extra:{bitfieldKind:'bfxil',lsb:8,width:8},args:[{value:old},{value:src}],dst:null};const v={id:3,bits:64,def:inst,uses:[]};inst.dst=v;
  const text=printExpression(buildExpressionForTesting(v,{ir:{values:[old,src,v],args:new Map()},model:{calls:[]}})); assert.match(text,/>> 8/); assert.doesNotMatch(text,/bit_insert/);
}
// #404 logical flags and #419 unordered FP flags are exact.
assert.equal(evaluateNZCVCondition('and','cs',0x80n,0xffn,8),false);
assert.equal(evaluateNZCVCondition('and','mi',0x80n,0xffn,8),true);
assert.equal(evaluateNZCVCondition('fsub','vs',NaN,1,64),true);
assert.equal(evaluateNZCVCondition('fsub','cs',NaN,1,64),true);
assert.equal(evaluateNZCVCondition('fsub','eq',NaN,1,64),false);
{
  const c=buildNZCVConditionExpression('fsub','vs',expr.floatConstant(NaN),expr.floatConstant(1),64); assert.equal(c.kind,'intrinsic');
}
// #408 float constants have distinct AST/literal identity.
assert.equal(printExpression(expr.floatConstant(1.5,64)),'1.5');
assert.equal(printExpression(expr.floatConstant(1,32)),'1.0f');
assert.equal(printExpression(expr.floatConstant(NaN,64)),'NAN');
// #422 confidence is fail-closed; non-proof facts are not VERIFIED.
{
  assert.equal(semanticEvidenceItems([{kind:'read',confidence:NaN,evidence:[{row:1}]}]).length,0);
  const weak=semanticEvidenceItems([{kind:'read',confidence:0.8,evidence:[{row:1}]}]); assert.equal(weak[0].family,FAMILY.USAGE);
  const proof=semanticEvidenceItems([{kind:'read',confidence:0.8,verified:true,evidence:[{row:1}]}]); assert.equal(proof[0].family,FAMILY.VERIFIED);
}
// #423 partial/failed runtime execution never becomes VERIFIED.
for (const bad of [{ok:false},{status:'timeout'},{complete:false,touchedFields:[{offset:1}]},{truncated:true,touchedFields:[{offset:1}]}]) assert.equal(runtimeEvidenceItems(bad).length,0);
assert.equal(runtimeEvidenceItems({ok:true,touchedFields:[{offset:1}]}).length,1);
// #432 active FAT slice UUID is mandatory and selected explicitly.
{
  const file={name:'A',size:10},info={slices:[{info:{uuid:'U0'}},{info:{uuid:'U1'}}]};
  assert.equal(legacyNoteKeyFor(file,info),null); assert.equal(legacyNoteKeyFor(file,info,1),'A|10|U1');
}
console.log('lowest-20 issue regression tests: ok');
