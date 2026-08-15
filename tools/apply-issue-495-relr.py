from pathlib import Path

p=Path('js/binary/elf-extended.js')
text=p.read_text()
if "./relocation-budget.js" not in text:
    text="import { createRelocationBudget } from './relocation-budget.js';\n\n"+text

if 'export function collectRelrRelocations(r, tags, image, bits, context = null) {' in text:
    p.write_text(text)
    raise SystemExit(0)

start=text.index('export function collectRelrRelocations(r, tags, image, bits) {')
end=text.index('\nfunction readSleb(r, state, end) {', start)
new=r'''function dynamicBudget(image, limits = {}) {
  return createRelocationBudget({
    limits,
    onLimit(message) { partial(image, `relocation decode budget exceeded: ${message}`); },
  });
}

function relocationContext(image, context) {
  const c = context && typeof context === 'object' ? context : {};
  return {
    out: Array.isArray(c.out) ? c.out : [],
    budget: c.budget || dynamicBudget(image, c.limits || {}),
  };
}

export function collectRelrRelocations(r, tags, image, bits, context = null) {
  const { out, budget } = relocationContext(image, context);
  const va=one(tags,DT_RELR), size64=one(tags,DT_RELRSZ);
  if (va == null || size64 == null || size64 === 0n || budget.stopped) return out;
  const word=bits===64?8:4, ent=one(tags,DT_RELRENT) ?? BigInt(word);
  if (ent !== BigInt(word)) { partial(image,`DT_RELRENT ${ent} does not match pointer size ${word}`); return out; }
  const off=vaToOffset(image,va), size=safe(size64);
  if (off==null||size==null||off+size>r.length) { partial(image,'DT_RELR table is outside the file'); return out; }
  if (!budget.claimInput(size, 'DT_RELR')) return out;
  if (size % word) partial(image,'DT_RELRSZ is not a multiple of DT_RELRENT');
  let base=0n; const wordBits=BigInt(word*8);
  const count=Math.floor(size/word);
  outer: for(let i=0;i<count;i++){
    if (!budget.step()) break;
    const entry=word===8?r.u64(off+i*word):BigInt(r.u32(off+i*word));
    if((entry&1n)===0n){
      if (!budget.push(out,{address:entry,symIndex:0,type:null,addend:null,source:'PT_DYNAMIC-RELR',relative:true},'DT_RELR')) break;
      base=entry+BigInt(word);
      continue;
    }
    for(let bit=1n;bit<wordBits;bit++) {
      if (!budget.step()) break outer;
      if(entry&(1n<<bit)) {
        if (!budget.push(out,{address:base+(bit-1n)*BigInt(word),symIndex:0,type:null,addend:null,source:'PT_DYNAMIC-RELR',relative:true},'DT_RELR')) break outer;
      }
    }
    base+=(wordBits-1n)*BigInt(word);
  }
  return out;
}
'''
text=text[:start]+new+text[end:]
p.write_text(text)
