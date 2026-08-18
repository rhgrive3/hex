import assert from 'node:assert/strict';
import { enhanceSemanticDecompilation } from '../js/decompiler/pipeline.js';

function val(id, reg, bits = 32, kind = 'def') { return { id, reg, bits, kind, uses: [], def: null, const: null }; }
function arg(id, reg, bits = 32) { return val(id, reg, bits, 'arg'); }
function av(v) { return { value: v }; }

const self = arg(1, 'x0', 64);
const damage = arg(2, 'x1', 32);
const loaded = val(3, 'x8', 32);
const zero = val(4, 'x9', 32); zero.const = 0n;
const sub = val(5, 'x10', 32);
const flags = val(6, 'nzcv', 4);
const selected = val(7, 'x11', 32);
const loc = { kind: 'field', key: 'field:1:32', base: self, disp: 32n, size: 4 };

const loadI = { id: 10, op: 'load', row: 0, block: 0, address: 0x1000n, dst: loaded, loc, addr: { base: self, disp: 32n, size: 4 }, args: [] }; loaded.def = loadI;
const constI = { id: 11, op: 'const', row: 1, block: 0, address: 0x1004n, dst: zero, args: [], extra: { value: 0n } }; zero.def = constI;
const subI = { id: 12, op: 'bin', sub: 'sub', row: 2, block: 0, address: 0x1008n, dst: sub, args: [av(loaded), av(damage)] }; sub.def = subI;
const cmpI = { id: 13, op: 'cmp', sub: 'sub', row: 3, block: 0, address: 0x100cn, dst: flags, args: [av(sub), av(zero)] }; flags.def = cmpI;
const selI = { id: 14, op: 'sel', sub: 'sel', cond: 'gt', row: 4, block: 0, address: 0x1010n, dst: selected, args: [av(sub), av(zero), av(flags)] }; selected.def = selI;
const storeI = { id: 15, op: 'store', row: 5, block: 0, address: 0x1014n, dst: null, loc, addr: { base: self, disp: 32n, size: 4 }, args: [av(selected)] };
const retI = { id: 16, op: 'ret', row: 6, block: 0, address: 0x1018n, args: [] };

for (const [v, use] of [[self, loadI],[damage,subI],[loaded,subI],[sub,cmpI],[sub,selI],[zero,cmpI],[zero,selI],[flags,selI],[selected,storeI]]) v.uses.push(use);
const ir = { values: [self,damage,loaded,zero,sub,flags,selected], instructions: [loadI,constI,subI,cmpI,selI,storeI,retI], args: new Map([['x0',self],['x1',damage]]), blocks: [{ index:0,startRow:0,endRow:6,succ:[],insts:[loadI,constI,subI,cmpI,selI,storeI,retI] }] };
const types = { values: new Map([[self.id,{name:'Player *',kind:'pointer',confidence:.9}],[damage.id,{name:'int32',kind:'integer',bits:32,signed:true,confidence:.9}],[loaded.id,{name:'int32',kind:'integer',bits:32,signed:true,confidence:.9}],[sub.id,{name:'int32',kind:'integer',bits:32,signed:true,confidence:.9}],[selected.id,{name:'int32',kind:'integer',bits:32,signed:true,confidence:.9}]]), locations: new Map() };
const result = { semantic:true, ir, types, lines:[{kind:'sig',indent:0,text:'void test(Player * a1, int32 a2)'},{kind:'ctrl',indent:0,text:'{'},{kind:'stmt',indent:1,text:'a1->field_20 = (a1->field_20 - a2 > 0 ? a1->field_20 - a2 : 0);',row:5,addr:0x1014n},{kind:'ctrl',indent:0,text:'}'}], warnings:[], evidence:[], summary:'fallback', coverage:{mode:'structured'} };
const enhanced = enhanceSemanticDecompilation(result, { calls:[] }, { fieldFor: (_reg, off) => off === 32n ? { name:'hp' } : null, decompilerTimeBudgetMs:1000 });
assert.ok(enhanced.semanticAst && enhanced.cAst);
assert.ok(enhanced.sourceMap.length >= 4);
assert.match(enhanced.pseudocode, /->hp = max\(/);
assert.ok(enhanced.rewriteStats.applications > 0);
assert.ok(enhanced.importantInputs.includes('a1'));
assert.ok(enhanced.sideEffects.some((x) => x.includes('hp')));
assert.ok(enhanced.metrics.sourceMappedNodes >= 4);
assert.ok(enhanced.highVariables.groups.length > 0);
console.log('decompiler semantic pipeline PASS');

await import('./issue-861-862-c-printer-signedness.mjs');
