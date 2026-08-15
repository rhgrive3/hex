import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';

function u32(b,o,v){new DataView(b.buffer).setUint32(o,v,true)}
function u16(b,o,v){new DataView(b.buffer).setUint16(o,v,true)}
function u64(b,o,v){new DataView(b.buffer).setBigUint64(o,BigInt(v),true)}

const names=['','_undef','_common','_sect','_abs'];
const offsets=[]; let str='';
for(const n of names){offsets.push(str.length); str+=n+'\0';}
const strBytes=new TextEncoder().encode(str);
const symoff=56, nsyms=4, stroff=symoff+nsyms*16;
const b=new Uint8Array(stroff+strBytes.length);
u32(b,0,0xfeedfacf); u32(b,4,0x0100000c); u32(b,8,0); u32(b,12,2); u32(b,16,1); u32(b,20,24); u32(b,24,0); u32(b,28,0);
u32(b,32,2); u32(b,36,24); u32(b,40,symoff); u32(b,44,nsyms); u32(b,48,stroff); u32(b,52,strBytes.length);
function sym(i,nameIndex,type,sect,value){const p=symoff+i*16;u32(b,p,offsets[nameIndex]);b[p+4]=type;b[p+5]=sect;u16(b,p+6,0);u64(b,p+8,value);}
sym(0,1,0x01,0,0n);       // N_UNDF|N_EXT
sym(1,2,0x01,0,0x20n);    // common: n_value is size
sym(2,3,0x0f,1,0x1000n);  // N_SECT|N_EXT
sym(3,4,0x03,0,0x2000n);  // N_ABS|N_EXT
b.set(strBytes,stroff);

const image=parseMachO(b);
const byName=new Map(image.symbols.map(s=>[s.name,s]));
assert.equal(byName.get('_undef').defined,false);
assert.equal(byName.get('_undef').kind,'undefined');
assert.equal(byName.get('_common').defined,false);
assert.equal(byName.get('_common').common,true);
assert.equal(byName.get('_common').size,0x20n);
assert.equal(byName.get('_common').address,0n);
assert.equal(byName.get('_sect').defined,true);
assert.equal(byName.get('_sect').kind,'section');
assert.equal(byName.get('_abs').defined,true);
assert.equal(image.exports.some(e=>e.name==='_common'),false);
assert.equal(image.imports.some(e=>e.name==='_common'),false);
assert.equal(image.imports.some(e=>e.name==='_undef'),true);
console.log('issue #465 Mach-O symbol-type regression passed');
