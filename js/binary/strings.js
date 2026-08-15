function printableCodePoint(cp) {
  if (cp === 9) return true;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return cp <= 0x10ffff;
}
function utf8At(bytes, p, end) {
  const b0=bytes[p];
  if (b0 < 0x80) return {cp:b0,bytes:1};
  let n,min,cp;
  if (b0>=0xc2 && b0<=0xdf) { n=2; min=0x80; cp=b0&0x1f; }
  else if (b0>=0xe0 && b0<=0xef) { n=3; min=0x800; cp=b0&0x0f; }
  else if (b0>=0xf0 && b0<=0xf4) { n=4; min=0x10000; cp=b0&0x07; }
  else return null;
  if (p+n>end) return null;
  for(let i=1;i<n;i++){ const b=bytes[p+i]; if((b&0xc0)!==0x80) return null; cp=(cp<<6)|(b&0x3f); }
  if(cp<min || cp>0x10ffff || (cp>=0xd800&&cp<=0xdfff)) return null;
  return {cp,bytes:n};
}
function utf16At(bytes,p,end){
  if(p+2>end) return null;
  const u=bytes[p]|(bytes[p+1]<<8);
  if(u>=0xd800&&u<=0xdbff){
    if(p+4>end) return null; const v=bytes[p+2]|(bytes[p+3]<<8);
    if(v<0xdc00||v>0xdfff) return null;
    return {cp:0x10000+((u-0xd800)<<10)+(v-0xdc00),bytes:4};
  }
  if(u>=0xdc00&&u<=0xdfff) return null;
  return {cp:u,bytes:2};
}

export function scanStrings(image, opts = {}) {
  const min=Math.max(2,opts.minLength||4), max=Math.max(min,opts.maxLength||4096);
  const includeUtf16=opts.utf16!==false, includeExecutable=!!opts.includeExecutable;
  const bytes=image.bytes; if(!bytes) return [];
  const ranges=[];
  if(image.sections.length){ for(const x of image.sections){ if(!x.fileSize) continue; if(!includeExecutable&&x.perms&&x.perms.execute) continue; ranges.push({start:Number(x.fileOffset),size:Number(x.fileSize),section:x.name}); } }
  else ranges.push({start:0,size:bytes.length,section:null});
  const out=[], seen=new Set();
  for(const range of ranges){
    const start=Math.max(0,range.start), end=Math.min(bytes.length,start+Math.max(0,range.size));
    for(let p=start;p<end;){
      const first=utf8At(bytes,p,end); if(!first||!printableCodePoint(first.cp)){p++;continue;}
      const s=p; let q=p, chars=0;
      while(q<end&&chars<max){ const x=utf8At(bytes,q,end); if(!x||!printableCodePoint(x.cp)) break; q+=x.bytes; chars++; }
      if(chars>=min) emit(image,out,seen,s,q-s,'utf8',range.section);
      p=Math.max(q+(q<end?1:0),p+1);
    }
    if(!includeUtf16) continue;
    for(let parity=0;parity<2;parity++){
      let p=start + ((parity - (start & 1) + 2) & 1);
      while(p+1<end){
        const first=utf16At(bytes,p,end); if(!first||!printableCodePoint(first.cp)){p+=2;continue;}
        const s=p; let q=p, chars=0;
        while(q+1<end&&chars<max){ const x=utf16At(bytes,q,end); if(!x||!printableCodePoint(x.cp)) break; q+=x.bytes; chars++; }
        if(chars>=min) emit(image,out,seen,s,q-s,'utf16le',range.section);
        p=Math.max(q+(q<end?2:0),p+2);
      }
    }
  }
  return out;
}
function emit(image,out,seen,fileOffset,byteLength,encoding,section){
  const key=`${fileOffset}:${encoding}`; if(seen.has(key)) return; seen.add(key);
  const raw=image.bytes.subarray(fileOffset,fileOffset+byteLength);
  let text; try { text=new TextDecoder(encoding==='utf16le'?'utf-16le':'utf-8',{fatal:true}).decode(raw); } catch { return; }
  out.push({text,encoding,fileOffset:BigInt(fileOffset),address:image.offsetToAddress(BigInt(fileOffset)),byteLength,section});
}
