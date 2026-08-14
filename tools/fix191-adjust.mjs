import fs from 'node:fs';
const path = 'js/ai/evidence.js';
let text = fs.readFileSync(path, 'utf8');
const before = "const bulk = rows.length > 1 || rows.some(({ key }) => key !== 'result');";
const after = "const bulk = rows.length > 1;";
if (!text.includes(before)) throw new Error('evidence bulk anchor missing');
fs.writeFileSync(path, text.replace(before, after));
