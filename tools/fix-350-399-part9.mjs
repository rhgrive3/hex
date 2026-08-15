import fs from 'node:fs';
const path='js/decompiler/pipeline-core.js';
let s=fs.readFileSync(path,'utf8');
const old=`  if (operandBits > 0 && valueBits > operandBits) {
    // Preserve the operand wrapper width (#356), but keep constants canonical.
    // Wrapping wzr/#0 in a trunc node prevents select/compare idiom matching even
    // though the bitvector value is already exact at every width.
    if (out?.kind === 'const') out = expr.constant(BigInt.asUintN(operandBits, out.value), operandBits, false, out.source);
    else out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }`;
const neu=`  if (operandBits > 0 && out?.kind === 'const') {
    // Constants have no inherent signedness at the machine level. Canonicalize
    // every operand-width constant, even when the SSA constant already happens
    // to have that width, so cmp #0 and wzr are structurally identical.
    out = expr.constant(BigInt.asUintN(operandBits, out.value), operandBits, false, out.source);
  } else if (operandBits > 0 && valueBits > operandBits) {
    out = expr.unary('trunc', out, operandBits, false, sourceOf(out), { fromBits:valueBits });
  }`;
if(!s.includes(old))throw new Error('buildArg constant canonicalization target missing');
s=s.replace(old,neu);
fs.writeFileSync(path,s);
