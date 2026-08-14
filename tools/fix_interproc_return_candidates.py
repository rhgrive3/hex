from pathlib import Path

path=Path('js/interproc.js')
s=path.read_text()
anchor="""function simpleReturnExpression(ret) {\n  if (!ret || !ret.args || !ret.args[0] || !ret.args[0].value) return null;\n  let v = ret.args[0].value;\n"""
replacement="""function summaryReturnCandidate(ir, ret) {\n  const explicit = ret?.args?.[0]?.value || null;\n  if (explicit) return { value: explicit, inferred: false };\n\n  // #130 deliberately makes an untyped RET carry no x0 SSA use. Interprocedural\n  // summaries may still recognize a *locally defined, terminal* x0 value as a\n  // return-shaped heuristic, without mutating RET or promoting it to ABI truth.\n  // Entry x0 (VK.ARG) is intentionally rejected so setters/void-like functions\n  // do not become synthetic `return arg0` summaries merely because x0 survived.\n  const value = valueBefore(ir, ret, 'x0');\n  if (!value || value.kind === VK.ARG || !value.def) return { value: null, inferred: false };\n  if (value.def.row == null || ret.row == null || value.def.row >= ret.row) return { value: null, inferred: false };\n  const laterUse = (value.uses || []).some((use) => use !== ret && use.row != null && use.row > value.def.row && use.row < ret.row);\n  if (laterUse) return { value: null, inferred: false };\n  return { value, inferred: true };\n}\n\nfunction simpleReturnExpression(value) {\n  if (!value) return null;\n  let v = value;\n"""
if s.count(anchor)!=1:
    raise SystemExit(f'simpleReturnExpression anchor changed: {s.count(anchor)}')
s=s.replace(anchor,replacement,1)
old="""  for (const ret of ir.instructions || []) {\n    if (ret.op !== OP.RET) continue;\n    const v = ret.args && ret.args[0] && ret.args[0].value || null;\n    const descriptor = returnDescriptor(v);\n    const expr = simpleReturnExpression(ret);\n    returns.push(expr || descriptor);\n  }\n"""
new="""  for (const ret of ir.instructions || []) {\n    if (ret.op !== OP.RET) continue;\n    const candidate = summaryReturnCandidate(ir, ret);\n    const descriptor = returnDescriptor(candidate.value);\n    const expr = simpleReturnExpression(candidate.value);\n    const summary = expr || descriptor;\n    returns.push(candidate.inferred ? { ...summary, inferred: true, evidence: 'terminal-x0-definition' } : summary);\n  }\n"""
if s.count(old)!=1:
    raise SystemExit(f'summarize return loop anchor changed: {s.count(old)}')
s=s.replace(old,new,1)
path.write_text(s)

Path('tests/issues-130-interproc.mjs').write_text(r'''import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { summarizeFunction } from '../js/interproc.js';

const BASE=0x100000000n;
function modelOf(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=addr-BASE;return d>=0n&&d<BigInt(lines.length*4)?Number(d/4n):null};
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress});
}

const arithmetic=modelOf(['add x0, x0, #5','ret']);
assert.equal(irFor(arithmetic).instructions.find((i)=>i.op===OP.RET).args?.length||0,0,'IR RET stays ABI-unknown');
const wrapper=summarizeFunction(arithmetic);
assert.equal(wrapper.classification.simpleArithmeticWrapper,true);
assert.equal(wrapper.returns[0].kind,'argument-arithmetic');
assert.equal(wrapper.returns[0].inferred,true);

const getter=summarizeFunction(modelOf(['ldr x0, [x0, #0x20]','ret']));
assert.equal(getter.classification.getter,true);
assert.equal(getter.returns[0].kind,'field');

// x0 surviving from function entry is not enough to invent a return value.
const setter=summarizeFunction(modelOf(['str x2, [x0, #0x20]','ret']));
assert.equal(setter.classification.setter,true);
assert.equal(setter.returns[0].kind,'void');
assert.equal(setter.returns[0].inferred,undefined);

console.log('issue-130 interproc compatibility: ok');
''')

agg=Path('tests/issues-101-145.mjs')
a=agg.read_text()
needle="await import('./issues-130-compat.mjs');\n"
if "issues-130-interproc.mjs" not in a:
    if a.count(needle)!=1: raise SystemExit('aggregator anchor changed')
    agg.write_text(a.replace(needle,needle+"await import('./issues-130-interproc.mjs');\n",1))

print('interproc return-candidate compatibility fix staged')
