import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinary, auditBinary, fingerprintImage } from '../js/binary/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['battlecats','TsumTsum','YWP'].map((x)=>path.join(root,x));
const results=[];
for(const file of files){
  if(!fs.existsSync(file)) continue;
  const bytes=new Uint8Array(fs.readFileSync(file));
  const before=process.memoryUsage().heapUsed;
  const t0=performance.now();
  const image=openBinary(bytes);
  const parseMs=performance.now()-t0;
  const audit=auditBinary(image);
  const fp=fingerprintImage(image);
  const after=process.memoryUsage().heapUsed;
  results.push({
    file:path.basename(file), bytes:bytes.length, format:image.format, arch:image.arch,
    parseMs:Number(parseMs.toFixed(2)), heapDeltaMiB:Number(((after-before)/1048576).toFixed(2)),
    sections:image.sections.length, imports:image.imports.length,
    importSites:image.imports.reduce((n,x)=>n+(x.sites?.length||0),0),
    functions:image.functions.length, symbols:image.symbols.length, exports:image.exports.length,
    auditErrors:audit.errors, auditWarnings:audit.warnings,
    executableFingerprint:fp.hash,
  });
}
console.log(JSON.stringify(results,null,2));
