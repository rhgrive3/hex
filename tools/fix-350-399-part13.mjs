import fs from 'node:fs';
const path='js/ir-core.js';
let s=fs.readFileSync(path,'utf8');
const old=`          const node = exact
            ? { kind: 'store', key, inst, block: bi, prev: top(key) }
            : { kind: 'clobber', key, inst, block: bi, reason: 'overlap-store' };`;
const neu=`          const node = exact
            ? { kind: 'store', key, inst, block: bi, prev: top(key) }
            : { kind: 'clobber', key, inst, block: bi, reason: 'overlap-store', unknownAlias: inst.loc.kind === MK.UNKNOWN };`;
if(!s.includes(old)) throw new Error('Memory-SSA overlap clobber target missing');
s=s.replace(old,neu);
fs.writeFileSync(path,s);
