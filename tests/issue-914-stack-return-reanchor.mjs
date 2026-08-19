import assert from 'node:assert/strict';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline.js';

function value(id, reg, bits = 64, kind = 'def') {
  return { id, reg, bits, kind, uses: [], def: null, const: null };
}
const av = (v) => ({ value:v });

const loaded = value(1, 'x0');
const one = value(2, 'x9'); one.const = 1n;
const added = value(3, 'x0');
const loc = { kind:'stack', key:'stack:16', disp:16n, size:8 };
const load = { id:10, op:'load', row:0, block:0, address:0x1000n, dst:loaded, loc, addr:{ baseReg:'sp', disp:16n, size:8 }, args:[] }; loaded.def = load;
const constant = { id:11, op:'const', row:1, block:0, address:0x1004n, dst:one, args:[], extra:{ value:1n } }; one.def = constant;
const add = { id:12, op:'bin', sub:'add', row:2, block:0, address:0x1008n, dst:added, args:[av(loaded), av(one)] }; added.def = add;
const ret = { id:13, op:'ret', row:3, block:0, address:0x100cn, args:[] };
loaded.uses.push(add); one.uses.push(add); added.uses.push(ret);

const ir = {
  values:[loaded, one, added],
  instructions:[load, constant, add, ret],
  args:new Map(),
  blocks:[{ index:0, startRow:0, endRow:3, succ:[], insts:[load, constant, add, ret] }],
};
const result = {
  semantic:true,
  ir,
  types:{ values:new Map(), locations:new Map() },
  lines:[
    {kind:'sig', indent:0, text:'long f(void)'},
    {kind:'ctrl', indent:0, text:'{'},
    {kind:'stmt', indent:1, text:'return x0;', row:3, addr:0x100cn},
    {kind:'ctrl', indent:0, text:'}'},
  ],
  warnings:[], evidence:[], summary:'issue-914', coverage:{mode:'structured'},
};

const enhanced = enhanceSemanticDecompilation(result, { calls:[] }, {
  abiAdapter:semanticAbiAdapter(AAPCS64_ABI),
  functionPrototype:{ returnType:'long', parameters:[] },
  decompilerTimeBudgetMs:1000,
});
const output = enhanced.semanticAst?.outputs?.find((item) => item.name === 'return');
assert.ok(output, 'semantic return output must exist');
assert.equal(output.expression?.kind, 'binary', 'post-pass must not rewind return to historical stack load');
assert.equal(output.expression?.op, 'add', 'ADD after stack load must remain the return root');
assert.match(enhanced.pseudocode, /return[\s\S]*\+\s*1/,
  `pseudocode must preserve +1 after stack load: ${enhanced.pseudocode}`);
console.log('issue 914 stack return re-anchor regression: PASS');
