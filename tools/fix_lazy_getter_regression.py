from pathlib import Path

path = Path('js/dataflow-semantic.js')
s = path.read_text()
old = """  for (const ret of ir.instructions || []) {\n    if (ret.op !== OP.RET || !ret.args[0] || !ret.args[0].value) continue;\n    const load = rootLoad(ret.args[0].value);\n    if (!load || !load.loc || load.loc.kind !== MK.FIELD) continue;\n    const location = locationShape(load, load.loc);\n    if (!location || location.key == null || covered.has(location.key)) continue;\n    covered.add(location.key);\n    const reg = ret.args[0].value.reg || 'x0';\n    out.push({\n"""
new = """  for (const ret of ir.instructions || []) {\n    if (ret.op !== OP.RET) continue;\n    // RET itself carries no universal x0 source (#130). For the compatibility\n    // getter fact only, a field load that is the reaching definition of x0 at\n    // the return site is independent structural evidence of a getter-shaped\n    // result. This does not attach x0 to RET and therefore cannot become a\n    // generic return-derived value for void functions.\n    const explicit = ret.args?.[0]?.value || null;\n    const candidate = explicit || valueBefore(ir, ret, 'x0');\n    if (!candidate) continue;\n    const load = rootLoad(candidate);\n    if (!load || !load.loc || load.loc.kind !== MK.FIELD) continue;\n    const location = locationShape(load, load.loc);\n    if (!location || location.key == null || covered.has(location.key)) continue;\n    covered.add(location.key);\n    const reg = candidate.reg || 'x0';\n    const confidence = explicit ? SCORE.high : SCORE.inferred;\n    out.push({\n"""
if s.count(old) != 1:
    raise SystemExit(f'returnedReads anchor changed: {s.count(old)} matches')
s = s.replace(old, new, 1)
s = s.replace("""      confidence: SCORE.high,\n      level: levelOf(SCORE.high),\n      evidence: updateEvidence('read', load),\n      ir: { location: load.loc, load, ret },\n""", """      confidence,\n      level: levelOf(confidence),\n      evidence: [\n        ...updateEvidence('read', load),\n        ...(explicit ? [] : [ev('return-candidate', ret.row, { reg:'x0', reason:'terminal-field-load', engine:'ir-semantic' })]),\n      ],\n      ir: { location: load.loc, load, ret, returnCandidate: !explicit },\n""", 1)
path.write_text(s)

Path('tests/issues-130-compat.mjs').write_text(r'''import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates } from '../js/dataflow.js';
import { irFor, OP } from '../js/ir.js';

const BASE=0x100000000n;
function build(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i)*4n,mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)};});
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress:(a)=>Number((a-BASE)/4n),symbolFor:()=>null});
}

const model=build(['mov x19, x0','ldr x8, [x19, #0x10]','str x0, [x19, #0x10]','ldr x0, [x19, #0x10]','ret']);
const ret=irFor(model).instructions.find((i)=>i.op===OP.RET);
assert.ok(ret);
assert.equal(ret.args?.length || 0,0,'#130 regression: untyped RET must not claim x0');
const updates=findValueUpdates(model).filter((u)=>u.location?.disp===0x10n);
const read=updates.find((u)=>u.kind==='read');
assert.ok(read,'terminal self-field load should remain a getter-shaped read');
assert.equal(read.ir?.returnCandidate,true);
assert.ok(updates.some((u)=>u.kind==='write'||u.kind==='move'));

// A non-field x0 definition must not become a synthetic getter/read fact.
const voidLike=build(['mov x0, #7','ret']);
assert.equal(findValueUpdates(voidLike).some((u)=>u.kind==='read'),false);
console.log('issue-130 compatibility regression: ok');
''')

agg=Path('tests/issues-101-145.mjs')
a=agg.read_text()
needle="await import('./issues-129-134.mjs');\n"
if "issues-130-compat.mjs" not in a:
    if a.count(needle)!=1: raise SystemExit('aggregator anchor changed')
    a=a.replace(needle, needle+"await import('./issues-130-compat.mjs');\n",1)
    agg.write_text(a)

print('lazy getter compatibility fix staged')
