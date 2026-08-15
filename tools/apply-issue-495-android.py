from pathlib import Path

p=Path('js/binary/elf-extended.js')
text=p.read_text()
start=text.index('function decodeAndroidTable(r, va, size64, image, bits, rela, source) {')
end=text.index('\nexport function parseDynamicSymbolVersions(', start)
new=r'''function decodeAndroidTable(r, va, size64, image, bits, rela, source, budget, out) {
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

'''
text=text[:start]+new+text[end:]
p.write_text(text)
