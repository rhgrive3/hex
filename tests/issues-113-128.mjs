import assert from 'node:assert/strict';
import { apiInfo, buildSemanticModel } from '../js/blocks.js';

const args=(name)=>apiInfo(name)?.args;
assert.deepEqual(args('bcopy'),['src','dst','size']);
assert.deepEqual(args('bzero'),['dst','size']);
assert.deepEqual(args('__memcpy_chk'),['dst','src','size','object_size']);
assert.deepEqual(args('calloc'),['count','size']);
assert.deepEqual(args('strnlen'),['str','maxlen']);
assert.deepEqual(args('strncmp'),['a','b','size']);
assert.deepEqual(args('strncpy'),['dst','src','size']);
assert.deepEqual(args('strlcpy'),['dst','src','dst_size']);
assert.deepEqual(args('strncat'),['dst','src','size']);
assert.deepEqual(args('snprintf'),['dst','size','format']);
assert.equal(apiInfo('snprintf').formatArg,2);
assert.deepEqual(args('strtol'),['str','endptr','base']);
assert.deepEqual(args('fprintf'),['stream','format']);
assert.equal(apiInfo('fprintf').formatArg,1);
assert.deepEqual(args('_os_log_impl'),['dso','log','type','format','buffer','size']);
assert.equal(apiInfo('_os_log_impl').formatArg,3);
assert.equal(apiInfo('objc_release').ret,null);
assert.deepEqual(args('objc_storeStrong'),['location','object']);
assert.equal(apiInfo('swift_release').ret,null);
assert.deepEqual(args('swift_allocObject'),['metadata','size','align_mask']);
assert.deepEqual(args('read'),['fd','buffer','count']);
assert.deepEqual(args('fread'),['ptr','size','count','stream']);
assert.deepEqual(args('connect'),['socket','address','address_len']);
assert.deepEqual(args('sendto'),['socket','buffer','length','flags','address','address_len']);
assert.deepEqual(args('getaddrinfo'),['node','service','hints','result_ptr']);

// #128: a per-row construction failure can no longer disappear silently.
const evil={row:7,address:0x101cn,get mn(){throw new Error('bad mnemonic')},ops:''};
const model=buildSemanticModel([evil],{startRow:7,endRow:7,rowOfAddress:()=>7});
assert.equal(model.instructions.length,1);
assert.equal(model.instructions[0].unknown,true);
assert.equal(model.diagnostics.length,1);
assert.equal(model.diagnostics[0].severity,'error');
assert.equal(model.diagnostics[0].row,7);
console.log('issues-113-128: ok');
