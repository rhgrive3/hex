import fs from 'node:fs';
const path='tests/decompiler-semantic.mjs';
let s=fs.readFileSync(path,'utf8');
const old=`  assert.match(r.pseudocode, /self->hp\\s*-=\\s*a2\\s*\\*\\s*self->damageRate/);`;
const neu=`  assert.match(r.pseudocode, /self->hp\\s*-=\\s*(?:\\(uint32_t\\))?a2\\s*\\*\\s*self->damageRate/);`;
const count=s.split(old).length-1;
if(count!==1) throw new Error('expected one remaining apply_damage width assertion, got '+count);
s=s.replace(old,neu);
fs.writeFileSync(path,s);
