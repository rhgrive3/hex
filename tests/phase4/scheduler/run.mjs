import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
const files=fs.readdirSync(directory,{withFileTypes:true})
  .filter((entry)=>entry.isFile()&&entry.name.endsWith('.test.mjs'))
  .map((entry)=>entry.name).sort((a,b)=>a.localeCompare(b));
if (!files.length) throw new Error('phase4 scheduler: no tests discovered');
for (const file of files) {
  process.stdout.write(`[phase4:scheduler] ${file}\n`);
  await import(pathToFileURL(path.join(directory,file)).href);
}
console.log(`phase4 scheduler: PASS (${files.length} files)`);
