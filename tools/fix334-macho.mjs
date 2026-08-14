import fs from 'node:fs';
const p='js/binary/macho.js';
let s=fs.readFileSync(p,'utf8');
const old=`function parseFunctionStarts(r, dc, image) {
  if (!dc.size || dc.offset + dc.size > r.length) return;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let addr = image.imageBase;
  while (p < end) {
    const x = r.uleb(p);
    p = x.next;
    if (x.value === 0n) break;
    addr += x.value;
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
  }
}`;
const neu=`function parseFunctionStarts(r, dc, image) {
  if (!dc.size || dc.offset + dc.size > r.length) return 0;
  let p = dc.offset, count = 0;
  const end = dc.offset + dc.size;
  let addr = image.imageBase;
  const alignment = image.arch === 'arm64' ? 4n : 1n;
  while (p < end) {
    const x = r.uleb(p);
    p = x.next;
    if (x.value === 0n) break;
    const next = addr + x.value;
    if (next <= addr) { image.warnings.push('LC_FUNCTION_STARTS overflow/non-monotonic delta'); break; }
    addr = next;
    const exec = image.segments.find((seg) => seg.perms.execute && addr >= seg.address && addr < seg.address + seg.size);
    if (!exec || addr % alignment !== 0n) { image.warnings.push('LC_FUNCTION_STARTS rejected non-executable/misaligned start 0x' + addr.toString(16)); continue; }
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
    count++;
  }
  return count;
}`;
if(!s.includes(old)) throw new Error('current parseFunctionStarts anchor missing');
s=s.replace(old,neu);
fs.writeFileSync(p,s);
