import fs from 'node:fs';
function edit(path,fn){const a=fs.readFileSync(path,'utf8'),b=fn(a);if(a===b)throw new Error('no change '+path);fs.writeFileSync(path,b)}
function once(s,a,b,label){const i=s.indexOf(a);if(i<0)throw new Error('missing '+label);if(s.indexOf(a,i+a.length)>=0)throw new Error('ambiguous '+label);return s.slice(0,i)+b+s.slice(i+a.length)}

edit('js/decompiler/pipeline-core.js',s=>{
  s=once(s,
`function buildArg(arg, state, flags = {}) {
  if (!arg) return expr.unknown('missing-arg');
  let out = buildValue(valueOf(arg), state, flags);
  const operandBits = Number(arg.bits || 0);
  const valueBits = Number(out?.bits || valueOf(arg)?.bits || 0);
  if (operandBits > 0 && valueBits > operandBits) {
    out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }
  return applyShift(out, arg.shift);
}`,
`function buildArg(arg, state, flags = {}) {
  if (!arg) return expr.unknown('missing-arg');
  let out = buildValue(valueOf(arg), state, flags);
  const operandBits = Number(arg.bits || 0);
  const valueBits = Number(out?.bits || valueOf(arg)?.bits || 0);
  if (operandBits > 0 && valueBits > operandBits) {
    // Preserve the operand wrapper width (#356), but keep constants canonical.
    // Wrapping wzr/#0 in a trunc node prevents select/compare idiom matching even
    // though the bitvector value is already exact at every width.
    if (out?.kind === 'const') out = expr.constant(BigInt.asUintN(operandBits, out.value), operandBits, out.signed, out.source);
    else out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }
  return applyShift(out, arg.shift);
}`,'#356 constant width normalization');

  s=once(s,
`  const a = buildArg(d.args?.[0], state), b = buildArg(d.args?.[1], state);
  const info = COND[cond] || null;`,
`  const a = buildArg(d.args?.[0], state);
  let b = buildArg(d.args?.[1], state);
  // ARM compare immediates inherit the register operand width. The IR wrapper
  // does not need to duplicate that width on the immediate itself, so canonicalize
  // the constant here before structural min/max matching.
  if (b?.kind === 'const' && a?.bits && b.bits !== a.bits) b = expr.constant(BigInt.asUintN(Number(a.bits), b.value), Number(a.bits), b.signed, b.source);
  const info = COND[cond] || null;`,'#356 compare immediate width');
  return s;
});

edit('tests/issues-350-399.mjs',s=>{
  s=once(s,
`import { buildIR, OP } from '../js/ir.js';`,
`import { buildIR, OP } from '../js/ir.js';
import { decompile } from '../js/decompile.js';`,'#356 focused import');
  const anchor=`await test('#360 plain LDR is not positive unsigned evidence',()=>{const ir=build(['ldr w1, [x0]','ret']);const load=ir.instructions.find(x=>x.op===OP.LOAD);eq(load.dst.signed,null)});`;
  const extra=`${anchor}
await test('#356 W-register reads keep 32-bit semantics',()=>{const rows=asm(['add w1, w0, #1','ret']);const rowOfAddress=a=>{const d=a-BASE;return d<0n||d>=8n?null:Number(d/4n)};const model=buildSemanticModel(rows,{startRow:0,endRow:1,rowOfAddress});const r=decompile(model,{addr:BASE,name:'widthRead',rowOfAddress,beginner:false});ok(/\\(uint32_t\\)a1/.test(r.pseudocode),r.pseudocode)});
await test('#356 width preservation keeps signed CSEL clamp recognizable',()=>{const lines=['ldr w8, [x0, #0x20]','sub w8, w8, w1','cmp w8, #0','csel w8, wzr, w8, lt','str w8, [x0, #0x20]','ret'];const rows=asm(lines);const rowOfAddress=a=>{const d=a-BASE;return d<0n||d>=BigInt(lines.length*4)?null:Number(d/4n)};const model=buildSemanticModel(rows,{startRow:0,endRow:lines.length-1,rowOfAddress});const r=decompile(model,{addr:BASE,name:'damage',rowOfAddress,receiverType:'Player',beginner:false,fieldFor:(_base,off)=>off===0x20n?{name:'hp',type:'int32'}:null});ok(/self->hp\\s*=\\s*max\\(/.test(r.pseudocode),r.pseudocode)});`;
  s=once(s,anchor,extra,'#356 focused regressions');
  return s;
});
