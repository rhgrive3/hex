import fs from 'node:fs/promises';

const path = 'tests/compiler-truth/run-core.mjs';
let source = await fs.readFile(path, 'utf8');
function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing compiler-truth anchor: ${before.slice(0,120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous compiler-truth anchor: ${before.slice(0,120)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
`import { decompile } from '../../js/decompile.js';\nimport { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';`,
`import { decompile } from '../../js/decompile.js';\nimport { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';\nimport { AAPCS64_ABI } from '../../js/targets/abi/index.js';\nimport { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';`);

replaceOnce(
`const opts = ['-O0','-O1','-O2','-O3','-Os','-Oz'];`,
`const opts = ['-O0','-O1','-O2','-O3','-Os','-Oz'];\nconst compilerTruthAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);`);

replaceOnce(
`      const result = decompile(model, { name:fn, addr:model.instructions[0].address, rowOfAddress:(a)=>rowMap.get(a?.toString()) ?? null, returnType, decompilerTimeBudgetMs:120 });`,
`      const result = decompile(model, { name:fn, addr:model.instructions[0].address, rowOfAddress:(a)=>rowMap.get(a?.toString()) ?? null, returnType, abiAdapter:compilerTruthAbiAdapter, decompilerTimeBudgetMs:120 });`);

replaceOnce(
`const preResult = decompile(prebuilt, { name:'max_prebuilt', addr:0x200000n, returnType:'int32', rowOfAddress:(a)=>preMap.get(a?.toString()) ?? null, decompilerTimeBudgetMs:120 });`,
`const preResult = decompile(prebuilt, { name:'max_prebuilt', addr:0x200000n, returnType:'int32', rowOfAddress:(a)=>preMap.get(a?.toString()) ?? null, abiAdapter:compilerTruthAbiAdapter, decompilerTimeBudgetMs:120 });`);

await fs.writeFile(path, source);
console.log('compiler-truth now supplies explicit AAPCS64 ABI evidence');
