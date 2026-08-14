import fs from 'node:fs';
const p='tools/apply-fix322.mjs';
let s=fs.readFileSync(p,'utf8');
const old=`  if (!s.includes(old)) throw new Error('feature cap anchor missing');
  write(p, s.replace(old, neu));`;
const neu=`  if (s.includes(old)) write(p, s.replace(old, neu));`;
if(!s.includes(old)) throw new Error('staged feature patch guard missing');
fs.writeFileSync(p,s.replace(old,neu));
