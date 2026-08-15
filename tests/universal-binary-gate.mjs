import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinary, auditBinary } from '../js/binary/index.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const targets=[
  {file:'battlecats', imports:3000, sites:44000, functions:102800},
  {file:'TsumTsum', imports:3180, sites:54000, functions:152400},
  {file:'YWP', imports:2900, sites:92000, functions:293700},
];
let failed=false, ran=0;
for(const t of targets){
  const file=path.join(root,'.real-fixtures',t.file);
  if(!fs.existsSync(file)){console.log(`SKIP ${t.file}: fixture not present`);continue;}
  ran++;
  const bytes=new Uint8Array(fs.readFileSync(file));
  const start=performance.now();
  let image;
  try{image=openBinary(bytes);}catch(e){console.error(`FAIL ${t.file}: parse: ${e.stack||e}`);failed=true;continue;}
  const ms=performance.now()-start;
  const audit=auditBinary(image);
  const sites=image.imports.reduce((n,x)=>n+(x.sites?.length||0),0);
  const coverage=image.imports.length ? image.imports.filter((x)=>x.sites?.length).length/image.imports.length : 0;
  const checks=[
    ['format',image.format==='macho',image.format],
    ['arch',image.arch==='arm64',image.arch],
    ['imports',image.imports.length>=t.imports,`${image.imports.length} >= ${t.imports}`],
    ['binding-sites',sites>=t.sites,`${sites} >= ${t.sites}`],
    ['import-site-coverage',coverage>=0.90,`${(coverage*100).toFixed(2)}% >= 90%`],
    ['functions',image.functions.length>=t.functions,`${image.functions.length} >= ${t.functions}`],
    ['audit-errors',audit.errors===0,String(audit.errors)],
  ];
  console.log(`\n${t.file} (${(bytes.length/1048576).toFixed(1)} MiB, ${ms.toFixed(1)} ms)`);
  for(const [name,ok,detail] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}: ${detail}`); if(!ok)failed=true;}
}
if(!ran) console.log('\nNo large real-world fixtures were present; synthetic universal-binary tests remain authoritative for CI environments without them.');
if(failed) process.exit(1);
console.log('\nuniversal-binary gate: PASS');
