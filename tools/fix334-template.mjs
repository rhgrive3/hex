import fs from 'node:fs';
const p='tools/apply-fix334.mjs';
let s=fs.readFileSync(p,'utf8');
for (const raw of [
  '${args[0]}','${args[1]}','${args[2]}','${text}',
  '${printExpression(base)}','${printExpression(index)}','${name}'
]) s=s.replaceAll(raw, '\\' + raw);
fs.writeFileSync(p,s);
