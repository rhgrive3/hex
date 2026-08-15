import { createRelocationBudget } from './relocation-budget.js';
import { createDynamicSymbolBudget } from './dynamic-symbol-budget.js';

const DT_RELRSZ = 35n;
const DT_RELR = 36n;
const DT_RELRENT = 37n;
const DT_ANDROID_REL = 0x6000000fn;
const DT_ANDROID_RELSZ = 0x60000010n;
const DT_ANDROID_RELA = 0x60000011n;
const DT_ANDROID_RELASZ = 0x60000012n;
const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;

const GROUPED_BY_INFO = 1n;
const GROUPED_BY_OFFSET_DELTA = 2n;
const GROUPED_BY_ADDEND = 4n;
const GROUP_HAS_ADDEND = 8n;

function one(tags, tag) { return tags.get(tag)?.[0] ?? null; }
function safe(v) { const n=Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; }
function vaToOffset(image, va) { const off=image.addressToOffset(va); return off == null ? null : safe(off); }
function partial(image, message) {
  image.metadata.programDynamicPartial = true;
  const list=image.metadata.programDynamicDiagnostics ||= [];
  if (!list.includes(message)) list.push(message);
  image.warnings.push(`PT_DYNAMIC: ${message}`);
}

function dynamicBudget(image, limits = {}) {
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

function readSleb(r, state, end) {
  let value=0n, shift=0n, byte=0;
  for(let i=0;i<10;i++){
    if(state.p>=end) throw new Error('truncated SLEB128');
    byte=r.u8(state.p++); value|=BigInt(byte&0x7f)<<shift; shift+=7n;
    if(!(byte&0x80)){ if((byte&0x40)&&shift<64n)value|=(-1n)<<shift; return value; }
  }
  throw new Error('SLEB128 exceeds 10 bytes');
}

function decodeAndroidTable(r, va, size64, image, bits, rela, source, budget, out) {
  if (budget.stopped) return out;
  const off=vaToOffset(image,va), size=safe(size64);
  if(off==null||size==null||off+size>r.length){partial(image,`${source} table is outside the file`);return out;}
  if (!budget.claimInput(size, source)) return out;
  const end=off+size;
  if(size<4||r.u8(off)!==0x41||r.u8(off+1)!==0x50||r.u8(off+2)!==0x53||r.u8(off+3)!==0x32){partial(image,`${source} is not APS2 encoded`);return out;}
  const st={p:off+4};
  try {
    const relocationCount=readSleb(r,st,end);
    if(relocationCount<0n) throw new Error('negative relocation count');
    let relocationOffset=readSleb(r,st,end), relocationAddend=0n, decoded=0n;
    while(decoded<relocationCount && !budget.stopped){
      if (!budget.step()) break;
      const groupSize=readSleb(r,st,end), flags=readSleb(r,st,end);
      if(groupSize<=0n||groupSize>relocationCount-decoded) throw new Error('invalid relocation group size');
      const groupedDelta=!!(flags&GROUPED_BY_OFFSET_DELTA), groupedInfo=!!(flags&GROUPED_BY_INFO), hasAddend=!!(flags&GROUP_HAS_ADDEND), groupedAddend=!!(flags&GROUPED_BY_ADDEND);
      const groupDelta=groupedDelta?readSleb(r,st,end):0n, groupInfo=groupedInfo?readSleb(r,st,end):0n, groupAddend=hasAddend&&groupedAddend?readSleb(r,st,end):0n;
      for(let i=0n;i<groupSize && !budget.stopped;i++,decoded++){
        if (!budget.step()) break;
        relocationOffset+=groupedDelta?groupDelta:readSleb(r,st,end);
        const info=groupedInfo?groupInfo:readSleb(r,st,end);
        if(hasAddend) relocationAddend+=groupedAddend?groupAddend:readSleb(r,st,end); else if(rela) relocationAddend=0n;
        if(relocationOffset<0n||info<0n) throw new Error('negative relocation field');
        const symIndex=bits===64?Number(info>>32n):Number(info>>8n), type=bits===64?Number(info&0xffffffffn):Number(info&0xffn);
        if(!Number.isSafeInteger(symIndex)||!Number.isSafeInteger(type)) throw new Error('relocation info exceeds safe integer range');
        if (!budget.push(out,{address:relocationOffset,symIndex,type,addend:rela?relocationAddend:null,source},source)) break;
      }
    }
  } catch(error){ if (!budget.stopped) partial(image,`${source}: ${error.message}`); }
  return out;
}

export function collectAndroidPackedRelocations(r,tags,image,bits,context=null){
  const { out, budget } = relocationContext(image, context);
  const rel=one(tags,DT_ANDROID_REL), relsz=one(tags,DT_ANDROID_RELSZ), rela=one(tags,DT_ANDROID_RELA), relasz=one(tags,DT_ANDROID_RELASZ);
  if(rel!=null&&relsz!=null) decodeAndroidTable(r,rel,relsz,image,bits,false,'PT_DYNAMIC-ANDROID-REL',budget,out);
  if(!budget.stopped&&rela!=null&&relasz!=null) decodeAndroidTable(r,rela,relasz,image,bits,true,'PT_DYNAMIC-ANDROID-RELA',budget,out);
  return out;
}


function symbolBudgetContext(image, context) {
  const c = context && typeof context === 'object' ? context : {};
  return c.budget || createDynamicSymbolBudget({
    limits:c.limits || {},
    onLimit(message){ partial(image, `dynamic symbol decode budget exceeded: ${message}`); },
  });
}

export function parseDynamicSymbolVersions(r,tags,image,symbolCount,stringAt,context=null){
  const out=new Map(), versym=one(tags,DT_VERSYM); if(versym==null||symbolCount<=0)return out;
  const budget=symbolBudgetContext(image,context);
  const count=Math.min(symbolCount,budget.limits.maxSymbolRecords);
  if(symbolCount>count)partial(image,`DT_VERSYM symbol count ${symbolCount} exceeds record limit ${count}; clamped`);
  const voff=vaToOffset(image,versym); if(voff==null||voff+count*2>r.length){partial(image,'DT_VERSYM table is truncated');return out;}
  if(!budget.claimInput(count*2,'DT_VERSYM'))return out;
  const names=new Map();
  const verdef=one(tags,DT_VERDEF), verdefnum=safe(one(tags,DT_VERDEFNUM)??0n);
  if(verdef!=null&&verdefnum){let p=vaToOffset(image,verdef);for(let i=0;p!=null&&i<Math.min(verdefnum,65536)&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERDEF decode'))break;
    if(p+20>r.length){partial(image,'DT_VERDEF is truncated');break;}
    if(!budget.claimInput(20,'DT_VERDEF'))break;
    const ndx=r.u16(p+4)&0x7fff,aux=r.u32(p+12),next=r.u32(p+16),ap=p+aux;
    if(ap+8>r.length){partial(image,'DT_VERDEF auxiliary entry is truncated');break;}
    if(!budget.claimInput(8,'DT_VERDEF auxiliary'))break;
    const name=stringAt(BigInt(r.u32(ap)));
    if(name){if(!budget.claimOutput(1,96,'DT_VERDEF names'))break;names.set(ndx,{name,definition:true,library:null});}
    if(!next)break;p+=next;
  }}
  const verneed=one(tags,DT_VERNEED), verneednum=safe(one(tags,DT_VERNEEDNUM)??0n);
  if(verneed!=null&&verneednum&&!budget.stopped){let p=vaToOffset(image,verneed);for(let i=0;p!=null&&i<Math.min(verneednum,65536)&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERNEED decode'))break;
    if(p+16>r.length){partial(image,'DT_VERNEED is truncated');break;}
    if(!budget.claimInput(16,'DT_VERNEED'))break;
    const cnt=r.u16(p+2),file=stringAt(BigInt(r.u32(p+4))),aux=r.u32(p+8),next=r.u32(p+12);let ap=p+aux;
    for(let j=0;j<cnt&&j<65536&&!budget.stopped;j++){
      if(!budget.step(1,'DT_VERNEED auxiliary decode'))break;
      if(ap+16>r.length){partial(image,'DT_VERNEED auxiliary entry is truncated');break;}
      if(!budget.claimInput(16,'DT_VERNEED auxiliary'))break;
      const other=r.u16(ap+6)&0x7fff,name=stringAt(BigInt(r.u32(ap+8))),anext=r.u32(ap+12);
      if(name){if(!budget.claimOutput(1,112,'DT_VERNEED names'))break;names.set(other,{name,definition:false,library:file||null});}
      if(!anext)break;ap+=anext;
    }
    if(!next)break;p+=next;
  }}
  for(let i=0;i<count&&!budget.stopped;i++){
    if(!budget.step(1,'DT_VERSYM decode'))break;
    const raw=r.u16(voff+i*2),index=raw&0x7fff;if(index<=1)continue;
    if(!budget.claimOutput(1,96,'DT_VERSYM entries'))break;
    const named=names.get(index);out.set(i,{index,hidden:!!(raw&0x8000),name:named?.name||null,library:named?.library||null,definition:named?.definition??null});
  }
  image.metadata.symbolVersions={entries:out.size,named:[...out.values()].filter(v=>v.name).length,complete:!budget.stopped};
  return out;
}

