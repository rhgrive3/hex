import fs from 'node:fs';
const path='js/binary/model.js';
let s=fs.readFileSync(path,'utf8');
const before="scalar(i.ordinal), i.weak ? '1' : '0', scalar(i.addend), scalar(i.pointerFormat)";
const after="scalar(i.ordinal), i.weak ? '1' : '0', scalar(i.addend ?? 0n), scalar(i.pointerFormat)";
if(!s.includes(before)) throw new Error('patched import identity expression not found');
s=s.replace(before,after);
fs.writeFileSync(path,s);
fs.rmSync('tools/fix-issues-48-60-adjust.mjs');
