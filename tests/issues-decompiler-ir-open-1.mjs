import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSemanticModel } from '../js/blocks.js';
import { decompile } from '../js/decompile.js';

const pipe=fs.readFileSync('js/decompiler/pipeline-core.js','utf8');
const sem=fs.readFileSync('js/decompiler/semantic.js','utf8');
const loop=fs.readFileSync('js/decompiler/loop-repair.js','utf8');
const ir=fs.readFileSync('js/ir-core.js','utf8');
const pretty=fs.readFileSync('js/decompiler/pretty/c.js','utf8');

assert.doesNotMatch(pipe,/if \(d\.negate\)/);
assert.match(pipe,/d\.extra\?\.negate/);
const bs=pipe.slice(pipe.indexOf('function branchSucc'),pipe.indexOf('function branchCondition'));
assert.match(bs,/succ\.length !== 2/);
assert.doesNotMatch(bs,/yes:\s*succ\[0\]/);
assert.match(bs,/yes:\s*null, no:\s*null/);

const phi=pipe.slice(pipe.indexOf('function controllingBranchForMemoryPhi'),pipe.indexOf('function memoryNodeExpression'));
assert.match(phi,/yr\.filter\(Boolean\)\.length !== 1/);
assert.match(phi,/nr\.filter\(Boolean\)\.length !== 1/);
assert.match(phi,/yr\[noIndex\] \|\| nr\[yesIndex\]/);
assert.match(phi,/candidates\.length === 1/);
assert.doesNotMatch(phi,/candidates\.sort\(\(a, b\) => b\.row - a\.row\)/);

assert.match(ir,/addressDispOp/);
assert.match(ir,/writebackDispOp/);
assert.match(ir,/mem\?\.mode === 'post' \? 0n/);
assert.match(ir,/value: writebackDisp/);
assert.doesNotMatch(ir,/if \(irCache\.has\(model\)\)/);
assert.match(ir,/function irConfigurationKey/);
assert.match(ir,/prototypeRevision/);
assert.match(ir,/evidenceGeneration/);

const ret=sem.slice(sem.indexOf('function returnValueAt'),sem.indexOf('function feedsReturn'));
assert.doesNotMatch(ret,/candidate=reachingRegisterValue/);
assert.match(ret,/return reg \? reachingRegisterValue/);
const pret=pipe.slice(pipe.indexOf('function returnValueAt(inst, state)'),pipe.indexOf('function semanticFacts'));
assert.doesNotMatch(pret,/candidate=reachingRegisterValue/);
assert.match(pret,/return reg \? reachingRegisterValue/);
const faithful=sem.slice(sem.indexOf('function faithfulCfg'));
assert.match(faithful,/const rv = returnValueAt\(term, ctx\)/);

assert.match(pretty,/export function integerText/);
assert.match(sem,/import \{ integerText \}/);
assert.match(sem,/return integerText\(v, bits, signed\)/);
assert.match(sem,/d\.extra\?\.widen/);
assert.match(sem,/__arm64_ubfiz/);
assert.match(sem,/bitfieldKind === 'bfxil'/);
assert.match(sem,/cmp\.sub !== 'sub'/);
assert.match(loop,/renderNZCVCondition/);

function make(lines) {
  const base=0x100000000n;
  const raw=lines.map((text,row)=>{const p=text.indexOf(' ');return {row,address:base+BigInt(row*4),mn:p<0?text:text.slice(0,p),ops:p<0?'':text.slice(p+1)}});
  const rowOfAddress=(addr)=>Number((BigInt(addr)-base)/4n);
  return {model:buildSemanticModel(raw,{startRow:0,endRow:raw.length-1,rowOfAddress}),rowOfAddress,base};
}

// #130: unknown/void must not become a value return merely because x0 was
// defined in the RET block; trusted ABI/type evidence may select x0.
{
  const {model,rowOfAddress,base}=make(['mov x0, #7','ret']);
  const unknown=decompile(model,{addr:base,name:'unknown_ret',rowOfAddress,beginner:false});
  assert.doesNotMatch(unknown.pseudocode,/return\s+(?:7|0x7)\s*;/i,unknown.pseudocode);
  const trusted=decompile(model,{addr:base,name:'known_ret',rowOfAddress,returnType:'int64',beginner:false});
  assert.match(trusted.pseudocode,/return\s+(?:7|0x7)\s*;/i,trusted.pseudocode);
}

console.log('decompiler/IR open issue batch 1 guards passed');
