import fs from 'node:fs';
const path='tests/integration-review.mjs';
let s=fs.readFileSync(path,'utf8');
const old=`  const rmw = readModifyWrite(ir);
  assert.equal(rmw.length,1);
  assert.equal(rmw[0].location.kind, MK.UNKNOWN);
  assert.ok(!semanticFacts(ir).some((f) => f.kind === FACT.RMW && f.location?.kind !== MK.UNKNOWN));`;
const neu=`  const rmw = readModifyWrite(ir);
  // Unknown/indexed addresses are may-alias only. Treating two such accesses as
  // the same location fabricates an RMW proof (#358).
  assert.equal(rmw.length,0);
  assert.ok(!semanticFacts(ir).some((f) => f.kind === FACT.RMW));`;
if(!s.includes(old)) throw new Error('integration-review unknown-memory contract not found');
s=s.replace(old,neu);
fs.writeFileSync(path,s);
