import fs from 'node:fs/promises';

async function read(path) { return fs.readFile(path, 'utf8'); }
async function write(path, content) { await fs.writeFile(path, content); }
async function replaceOnce(path, before, after) {
  const source = await read(path);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing compiler-truth ABI anchor in ${path}: ${before.slice(0,120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous compiler-truth ABI anchor in ${path}: ${before.slice(0,120)}`);
  await write(path, source.slice(0, first) + after + source.slice(first + before.length));
}

for (const path of ['tests/compiler-truth/extended.mjs', 'tests/compiler-truth/language-matrix.mjs']) {
  await replaceOnce(path,
`import { decompile } from '../../js/decompile.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';`,
`import { decompile } from '../../js/decompile.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';`);
}

await replaceOnce('tests/compiler-truth/extended.mjs',
`const optimizations = ['-O2', '-O3', '-Os', '-Oz'];`,
`const optimizations = ['-O2', '-O3', '-Os', '-Oz'];
const compilerTruthAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);`);
await replaceOnce('tests/compiler-truth/extended.mjs',
`      returnType,
      decompilerTimeBudgetMs: 180,`,
`      returnType,
      abiAdapter:compilerTruthAbiAdapter,
      decompilerTimeBudgetMs: 180,`);

await replaceOnce('tests/compiler-truth/language-matrix.mjs',
`const optimizations = ['-O0','-O1','-O2','-O3','-Os','-Oz'];`,
`const optimizations = ['-O0','-O1','-O2','-O3','-Os','-Oz'];
const compilerTruthAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);`);
await replaceOnce('tests/compiler-truth/language-matrix.mjs',
`    returnType:'int32',
    decompilerTimeBudgetMs:120,`,
`    returnType:'int32',
    abiAdapter:compilerTruthAbiAdapter,
    decompilerTimeBudgetMs:120,`);

console.log('remaining ARM64 compiler-truth fixtures now supply explicit AAPCS64 ABI evidence');
