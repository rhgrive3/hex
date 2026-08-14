import fs from 'node:fs';
const p = 'js/worker.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace('const objectId = new Uint32Array(32);', 'const regObjectId = new Uint32Array(32);');
s = s.replaceAll('objectId[', 'regObjectId[');
fs.writeFileSync(p, s);
