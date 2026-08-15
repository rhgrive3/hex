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

export function collectRelrRelocations(r, tags, image, bits) {
  const va=one(tags,DT_RELR), size64=one(tags,DT_RELRSZ);
  if (va == null || size64 == null || size64 === 0n) return [];
  const word=bits===64?8:4, ent=one(tags,DT_RELRENT) ?? BigInt(word);
  if (ent !== BigInt(word)) { partial(image,`DT_RELRENT ${ent} does not match pointer size ${word}`); return []; }
  const off=vaToOffset(image,va), size=safe(size64);
  if (off==null||size==null||off+size>r.length) { partial(image,'DT_RELR table is outside the file'); return []; }
  if (size % word) partial(image,'DT_RELRSZ is not a multiple of DT_RELRENT');
  const out=[]; let base=0n; const wordBits=BigInt(word*8);
  const count=Math.min(Math.floor(size/word),10_000_000);
  for(let i=0;i<count;i++){
    const entry=word===8?r.u64(off+i*word):BigInt(r.u32(off+i*word));
    if((entry&1n)===0n){ out.push({address:entry,symIndex:0,type:null,addend:null,source:'PT_DYNAMIC-RELR',relative:true}); base=entry+BigInt(word); continue; }
    for(let bit=1n;bit<wordBits;bit++) if(entry&(1n<<bit)) out.push({address:base+(bit-1n)*BigInt(word),symIndex:0,type:null,addend:null,source:'PT_DYNAMIC-RELR',relative:true});
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

function decodeAndroidTable(r, va, size64, image, bits, rela, source) {
  const off=vaToOffset(image,va), size=safe(size64); if(off==null||size==null||off+size>r.length){partial(image,`${source} table is outside the file`);return [];}
  const end=off+size; if(size<4||r.u8(off)!==0x41||r.u8(off+1)!==0x50||r.u8(off+2)!==0x53||r.u8(off+3)!==0x32){partial(image,`${source} is not APS2 encoded`);return [];}
  const st={p:off+4}, out=[];
  try {
    const relocationCount=readSleb(r,st,end); if(relocationCount<0n||relocationCount>10_000_000n) throw new Error('relocation count exceeds budget');
    let relocationOffset=readSleb(r,st,end), relocationAddend=0n, decoded=0n;
    while(decoded<relocationCount){
      const groupSize=readSleb(r,st,end), flags=readSleb(r,st,end); if(groupSize<=0n||groupSize>relocationCount-decoded) throw new Error('invalid relocation group size');
      const groupedDelta=!!(flags&GROUPED_BY_OFFSET_DELTA), groupedInfo=!!(flags&GROUPED_BY_INFO), hasAddend=!!(flags&GROUP_HAS_ADDEND), groupedAddend=!!(flags&GROUPED_BY_ADDEND);
      const groupDelta=groupedDelta?readSleb(r,st,end):0n, groupInfo=groupedInfo?readSleb(r,st,end):0n, groupAddend=hasAddend&&groupedAddend?readSleb(r,st,end):0n;
      for(let i=0n;i<groupSize;i++,decoded++){
        relocationOffset+=groupedDelta?groupDelta:readSleb(r,st,end);
        const info=groupedInfo?groupInfo:readSleb(r,st,end);
        if(hasAddend) relocationAddend+=groupedAddend?groupAddend:readSleb(r,st,end); else if(rela) relocationAddend=0n;
        if(relocationOffset<0n||info<0n) throw new Error('negative relocation field');
        const symIndex=bits===64?Number(info>>32n):Number(info>>8n), type=bits===64?Number(info&0xffffffffn):Number(info&0xffn);
        if(!Number.isSafeInteger(symIndex)||!Number.isSafeInteger(type)) throw new Error('relocation info exceeds safe integer range');
        out.push({address:relocationOffset,symIndex,type,addend:rela?relocationAddend:null,source});
      }
    }
  } catch(error){partial(image,`${source}: ${error.message}`);}
  return out;
}

export function collectAndroidPackedRelocations(r,tags,image,bits){
  const out=[]; const rel=one(tags,DT_ANDROID_REL), relsz=one(tags,DT_ANDROID_RELSZ), rela=one(tags,DT_ANDROID_RELA), relasz=one(tags,DT_ANDROID_RELASZ);
  if(rel!=null&&relsz!=null) out.push(...decodeAndroidTable(r,rel,relsz,image,bits,false,'PT_DYNAMIC-ANDROID-REL'));
  if(rela!=null&&relasz!=null) out.push(...decodeAndroidTable(r,rela,relasz,image,bits,true,'PT_DYNAMIC-ANDROID-RELA'));
  return out;
}

export function parseDynamicSymbolVersions(r,tags,image,symbolCount,stringAt){
  const out=new Map(), versym=one(tags,DT_VERSYM); if(versym==null||symbolCount<=0)return out;
  const voff=vaToOffset(image,versym); if(voff==null||voff+symbolCount*2>r.length){partial(image,'DT_VERSYM table is truncated');return out;}
  const names=new Map();
  const verdef=one(tags,DT_VERDEF), verdefnum=safe(one(tags,DT_VERDEFNUM)??0n);
  if(verdef!=null&&verdefnum){let p=vaToOffset(image,verdef);for(let i=0;p!=null&&i<Math.min(verdefnum,65536);i++){if(p+20>r.length){partial(image,'DT_VERDEF is truncated');break;}const ndx=r.u16(p+4)&0x7fff,aux=r.u32(p+12),next=r.u32(p+16),ap=p+aux;if(ap+8>r.length){partial(image,'DT_VERDEF auxiliary entry is truncated');break;}const name=stringAt(BigInt(r.u32(ap)));if(name)names.set(ndx,{name,definition:true,library:null});if(!next)break;p+=next;}}
  const verneed=one(tags,DT_VERNEED), verneednum=safe(one(tags,DT_VERNEEDNUM)??0n);
  if(verneed!=null&&verneednum){let p=vaToOffset(image,verneed);for(let i=0;p!=null&&i<Math.min(verneednum,65536);i++){if(p+16>r.length){partial(image,'DT_VERNEED is truncated');break;}const cnt=r.u16(p+2),file=stringAt(BigInt(r.u32(p+4))),aux=r.u32(p+8),next=r.u32(p+12);let ap=p+aux;for(let j=0;j<cnt&&j<65536;j++){if(ap+16>r.length){partial(image,'DT_VERNEED auxiliary entry is truncated');break;}const other=r.u16(ap+6)&0x7fff,name=stringAt(BigInt(r.u32(ap+8))),anext=r.u32(ap+12);if(name)names.set(other,{name,definition:false,library:file||null});if(!anext)break;ap+=anext;}if(!next)break;p+=next;}}
  for(let i=0;i<symbolCount;i++){const raw=r.u16(voff+i*2),index=raw&0x7fff;if(index<=1)continue;const named=names.get(index);out.set(i,{index,hidden:!!(raw&0x8000),name:named?.name||null,library:named?.library||null,definition:named?.definition??null});}
  image.metadata.symbolVersions={entries:out.size,named:[...out.values()].filter(v=>v.name).length};
  return out;
}
