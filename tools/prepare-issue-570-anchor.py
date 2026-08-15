from pathlib import Path
p=Path('js/binary/macho-dyld.js')
s=p.read_text()
old="""  const importsBase=base+importsOffset, stringsBase=base+symbolsOffset;
  if(importsBase<base||importsBase>base+dc.size||stringsBase<base||stringsBase>base+dc.size){markChainedPartial(image,'chained import/string offsets leave payload');return [];}
  let entrySize=0;if(importsFormat===1)entrySize=4;else if(importsFormat===2)entrySize=8;else if(importsFormat===3)entrySize=16;else {markChainedPartial(image,`unsupported chained imports format ${importsFormat}`);return [];}
  if(importsCount>Math.floor((base+dc.size-importsBase)/entrySize)){markChainedPartial(image,'chained imports table exceeds payload');return [];}
  const parsed=[];
  for(let i=0;i<importsCount;i++){
    const p=importsBase+i*entrySize; let ordinal,weak,nameOffset,addend=0n;
    if(importsFormat===1){const raw=r.u32(p);ordinal=signExtend(raw&0xff,8);weak=!!(raw&0x100);nameOffset=raw>>>9;}
    else if(importsFormat===2){const raw=r.u32(p);ordinal=signExtend(raw&0xff,8);weak=!!(raw&0x100);nameOffset=raw>>>9;addend=BigInt(r.i32(p+4));}
    else {const lo=r.u32(p),hi=r.u32(p+4);ordinal=signExtend(lo&0xffff,16);weak=!!(lo&0x10000);nameOffset=hi;addend=r.i64(p+8);}
    const strp=stringsBase+nameOffset; if(strp<stringsBase||strp>=base+dc.size)continue;
    const name=r.cstring(strp,base+dc.size-strp); if(!name)continue;
    const imp={name,library:dylibForOrdinal(image,ordinal),ordinal,weak,addend,source:'chained-fixups',sites:[],chainedIndex:i};image.imports.push(imp);parsed[i]=imp;
  }"""
new="""  const importsStart = base + importsOffset, symbolsStart = base + symbolsOffset;
  if(importsStart<base||importsStart>base+dc.size||symbolsStart<base||symbolsStart>base+dc.size){markChainedPartial(image,'chained import/string offsets leave payload');return [];}
  let entrySize=0;if(importsFormat===1)entrySize=4;else if(importsFormat===2)entrySize=8;else if(importsFormat===3)entrySize=16;else {markChainedPartial(image,`unsupported chained imports format ${importsFormat}`);return [];}
  if(importsCount>Math.floor((base+dc.size-importsStart)/entrySize)){markChainedPartial(image,'chained imports table exceeds payload');return [];}
  const parsed=[];
  for (let i = 0; i < importsCount; i++) {
    const p = importsStart + i * entrySize;
    let libOrdinal = 0, weak = false, nameOffset = 0, addend = 0n;
    if(importsFormat===1){const raw=r.u32(p);libOrdinal=signExtend(raw&0xff,8);weak=!!(raw&0x100);nameOffset=raw>>>9;}
    else if(importsFormat===2){const raw=r.u32(p);libOrdinal=signExtend(raw&0xff,8);weak=!!(raw&0x100);nameOffset=raw>>>9;addend=BigInt(r.i32(p+4));}
    else {const lo=r.u32(p),hi=r.u32(p+4);libOrdinal=signExtend(lo&0xffff,16);weak=!!(lo&0x10000);nameOffset=hi;addend=r.i64(p+8);}
    const np = symbolsStart + nameOffset;
    const name = np < dc.offset + dc.size ? r.cstring(np, dc.offset + dc.size - np) : '';
    if (!name) continue;
    const library = dylibForOrdinal(image, libOrdinal);
    const imp = { name, library, ordinal: libOrdinal, weak, addend, source: 'chained-fixups', sites: [], chainedIndex:i };
    image.imports.push(imp); parsed[i] = imp;
  }"""
if old not in s: raise SystemExit('current compact chained import block anchor missing')
p.write_text(s.replace(old,new,1))
