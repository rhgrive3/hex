import fs from 'node:fs/promises';

const path = 'tests/decompiler-pipeline.mjs';
let source = await fs.readFile(path, 'utf8');
function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing decompiler-pipeline ABI anchor: ${before.slice(0,120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous decompiler-pipeline ABI anchor: ${before.slice(0,120)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
`import assert from 'node:assert/strict';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline.js';`,
`import assert from 'node:assert/strict';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline.js';`);

replaceOnce(
`const enhanced = enhanceSemanticDecompilation(result, { calls:[] }, { fieldFor: (_reg, off) => off === 32n ? { name:'hp' } : null, decompilerTimeBudgetMs:1000 });`,
`const enhanced = enhanceSemanticDecompilation(result, { calls:[] }, {
  fieldFor: (_reg, off) => off === 32n ? { name:'hp' } : null,
  abiAdapter:semanticAbiAdapter(AAPCS64_ABI),
  functionPrototype:{ returnType:'void', parameters:[{ type:'Player *' }, { type:'int32' }] },
  decompilerTimeBudgetMs:1000,
});`);

await fs.writeFile(path, source);
console.log('decompiler pipeline fixture now supplies explicit AAPCS64 ABI evidence');
