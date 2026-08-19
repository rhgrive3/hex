import fs from 'node:fs/promises';

const path = 'tests/decompiler-semantic.mjs';
let source = await fs.readFile(path, 'utf8');
const before = `  const r = decompile(model, { abiAdapter:testAbiAdapter,\n    addr: base, name: 'apply_damage', rowOfAddress, returnType: 'int32', receiverType: 'Unit', beginner: false,`;
const after = `  const r = decompile(model, { abiAdapter:testAbiAdapter,\n    addr: base, name: 'apply_damage', rowOfAddress, returnType: 'int32', receiverType: 'Unit', beginner: false,\n    functionPrototype:{ returnType:'int32', parameters:[{ type:'Unit *' }, { type:'int32' }] },`;
if (!source.includes(before)) throw new Error('missing apply_damage explicit-prototype anchor');
source = source.replace(before, after);
await fs.writeFile(path, source);
console.log('apply_damage fixture now carries its known AAPCS64 prototype');
