#!/usr/bin/env node
import fs from 'node:fs';
import { openBinary, auditBinary, capabilitiesOf, fingerprintImage, scanStrings } from '../js/binary/index.js';

const args=process.argv.slice(2);
const file=args.find((x)=>!x.startsWith('-'));
if(!file){
  console.error('Usage: node tools/binary-inspect.mjs <file> [--strings] [--json]');
  process.exit(2);
}
const bytes=new Uint8Array(fs.readFileSync(file));
const image=openBinary(bytes);
const audit=auditBinary(image);
const result={
  file,
  bytes:bytes.length,
  summary:image.summary(),
  capabilities:capabilitiesOf(image),
  audit:{ok:audit.ok,errors:audit.errors,warnings:audit.warnings,issues:audit.issues.slice(0,100)},
  fingerprint:fingerprintImage(image),
  libraries:image.libraries,
  importSample:image.imports.slice(0,50),
  exportSample:image.exports.slice(0,50),
  functionSample:image.functions.slice(0,50),
};
if(args.includes('--strings')){
  const strings=scanStrings(image,{minLength:5});
  result.strings={count:strings.length,sample:strings.slice(0,200)};
}
const json=JSON.stringify(result,(_,v)=>typeof v==='bigint'?'0x'+v.toString(16).toUpperCase():v,2);
if(args.includes('--json')) console.log(json);
else {
  const s=result.summary;
  console.log(`${file}`);
  console.log(`${s.format.toUpperCase()} ${s.arch} ${s.bits}-bit ${s.endian}-endian`);
  console.log(`sections ${s.sections} | functions ${s.functions} | imports ${s.imports} | exports ${s.exports} | symbols ${s.symbols}`);
  console.log(`libraries ${s.libraries} | audit ${audit.errors} errors / ${audit.warnings} warnings | fingerprint ${result.fingerprint.hash}`);
  if(image.metadata.chainedFixups?.bindingSites!=null) console.log(`Mach-O chained binding sites: ${image.metadata.chainedFixups.bindingSites}`);
  if(image.metadata.ehFrameHeader) console.log(`ELF unwind function seeds: ${image.metadata.ehFrameHeader.recoveredFunctions}/${image.metadata.ehFrameHeader.declaredFunctions}`);
  if(image.metadata.exceptionDirectory) console.log(`PE exception function seeds: ${image.metadata.exceptionDirectory.count}`);
}
