import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildValues, render } from '../../js/expr.js';

const BASE=0x730000000n;
const rows=[
  {row:0,address:BASE,mn:'fcmp',ops:'s0, s1'},
  {row:1,address:BASE+4n,mn:'cset',ops:'w2, eq'},
  {row:2,address:BASE+8n,mn:'ret',ops:''},
];
const rowOfAddress=(address)=>Number((BigInt(address)-BASE)/4n);
const model=buildSemanticModel(rows,{startRow:0,endRow:2,rowOfAddress});
const node=buildValues(model).defAt(1,'x2');
const inner=node?.k==='un'&&node.op==='uxt32'?node.a:node;
assert.equal(inner?.k,'sel');
assert.ok(inner?.predicate == null, 'FCMP is not mislabeled as the integer NZCV-exact producer model');
assert.ok(inner?.cmp == null, 'unsupported FP flag semantics do not become a fabricated integer compare');
assert.match(render(inner), /flag_eq|cond|\?/i, 'rendering remains explicitly unresolved rather than falsely exact');
console.log('issue #822 unsupported-producer regression: ok');
