import fs from 'node:fs/promises';

const path = 'tests/decompiler-semantic.mjs';
let source = await fs.readFile(path, 'utf8');
function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing decompiler-semantic ABI anchor: ${before.slice(0,120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous decompiler-semantic ABI anchor: ${before.slice(0,120)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
`import { decompile } from '../js/decompile.js';
import { buildIR, OP } from '../js/ir.js';`,
`import { decompile } from '../js/decompile.js';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';
import { buildIR, OP } from '../js/ir.js';`);
replaceOnce(
`const BASE = 0x100000000n;`,
`const BASE = 0x100000000n;
const testAbiAdapter = semanticAbiAdapter(AAPCS64_ABI);`);

const needle = `decompile(model, {`;
const count = source.split(needle).length - 1;
if (count !== 7) throw new Error(`expected 7 ARM64 decompile fixtures, found ${count}`);
source = source.split(needle).join(`decompile(model, { abiAdapter:testAbiAdapter,`);

await fs.writeFile(path, source);
console.log('all ARM64 decompiler-semantic fixtures now carry explicit AAPCS64 ABI evidence');
