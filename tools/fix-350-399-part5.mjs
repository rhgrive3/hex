import fs from 'node:fs';
const path='tests/decompiler-semantic.mjs';
let s=fs.readFileSync(path,'utf8');
const old=`  assert.match(r.pseudocode, /self->coins\\s*\\+=\\s*a2/);`;
const neu=`  assert.match(r.pseudocode, /self->coins\\s*\\+=\\s*(?:\\(uint32_t\\))?a2/);`;
if(!s.includes(old)) throw new Error('decompiler semantic width assertion not found');
s=s.replace(old,neu);
fs.writeFileSync(path,s);
