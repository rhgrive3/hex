from pathlib import Path

path=Path('js/symbolic/executor.js')
s=path.read_text()
old="import { OP, MK, COND } from '../ir.js';\n"
new="import { OP, MK, COND } from '../ir.js';\nimport { valueBefore } from '../dataflow-semantic.js';\n"
if s.count(old)!=1: raise SystemExit('executor import anchor changed')
s=s.replace(old,new,1)
old="""      if (inst.op === OP.RET) {\n        const value = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : null;\n        paths.push({\n          status: value && value.kind === SYM.UNKNOWN ? 'unknown' : 'complete',\n          reason: value && value.kind === SYM.UNKNOWN ? value.reason : null,\n          returnValue: value,\n          returnText: expressionText(value),\n"""
new="""      if (inst.op === OP.RET) {\n        const explicit = inst.args[0]?.value || null;\n        let candidate = explicit;\n        let inferredReturn = false;\n        if (!candidate) {\n          const terminal = valueBefore(ir, inst, 'x0');\n          // Keep #130's ABI truth intact: RET has no implicit x0 operand. The\n          // symbolic layer may expose a local terminal x0 expression only when\n          // it was actually defined inside this function and evaluates to a\n          // non-constant expression. This preserves field/dataflow experiments\n          // while refusing the weakest `mov x0,#imm; ret` void-like ambiguity.\n          if (terminal?.def && terminal.kind !== 'arg' && terminal.def.row != null && inst.row != null && terminal.def.row < inst.row) {\n            const evaluated = evalValue(terminal, state, ir, opts, memo, new Set());\n            if (evaluated && evaluated.kind !== SYM.UNKNOWN && evaluated.kind !== SYM.CONST) {\n              candidate = terminal; inferredReturn = true;\n            }\n          }\n        }\n        const value = candidate ? evalValue(candidate, state, ir, opts, memo, new Set()) : null;\n        paths.push({\n          status: value && value.kind === SYM.UNKNOWN ? 'unknown' : 'complete',\n          reason: value && value.kind === SYM.UNKNOWN ? value.reason : null,\n          returnValue: value,\n          returnText: expressionText(value),\n          returnInferred: inferredReturn,\n"""
if s.count(old)!=1: raise SystemExit(f'RET block anchor changed: {s.count(old)}')
s=s.replace(old,new,1)
path.write_text(s)

Path('tests/issues-130-symbolic.mjs').write_text(r'''import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { symbolicExecute } from '../js/symbolic/executor.js';

const BASE=0x100000000n;
function modelOf(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=addr-BASE;return d>=0n&&d<BigInt(lines.length*4)?Number(d/4n):null};
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress});
}

const model=modelOf(['ldr w8, [x0, #0x20]','str w1, [x0, #0x20]','add w0, w8, #1','ret']);
const ir=irFor(model), ret=ir.instructions.find((i)=>i.op===OP.RET);
assert.equal(ret.args?.length||0,0,'RET remains ABI-unknown');
const path=symbolicExecute(ir,{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
assert.ok(path); assert.match(path.returnText,/field\(/); assert.equal(path.returnInferred,true);

const ambiguous=symbolicExecute(irFor(modelOf(['mov x0, #7','ret'])),{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
assert.ok(ambiguous); assert.equal(ambiguous.returnValue,null); assert.equal(ambiguous.returnText,'?'); assert.equal(ambiguous.returnInferred,false);
console.log('issue-130 symbolic compatibility: ok');
''')
agg=Path('tests/issues-101-145.mjs')
a=agg.read_text(); needle="await import('./issues-130-interproc.mjs');\n"
if 'issues-130-symbolic.mjs' not in a:
  if a.count(needle)!=1: raise SystemExit('aggregator anchor changed')
  agg.write_text(a.replace(needle,needle+"await import('./issues-130-symbolic.mjs');\n",1))
print('symbolic return-candidate compatibility fix staged')
