from pathlib import Path
p=Path('js/binary/pe-loader.js'); s=p.read_text()
# Replace imports/exports region up to parseExceptionFunctions.
a=s.index('function markImportPartial')
b=s.index('\nexport function parseExceptionFunctions',a)
new=r'''const PE_IMPORT_LIMITS = Object.freeze({ descriptors:4096, thunks:250000, stringBytes:4096 });
const PE_EXPORT_LIMITS = Object.freeze({ functions:500000, names:250000, stringBytes:4096 });
function directoryFileRange(image, dir, minimum = 1) {
  if (!dir || !Number.isInteger(dir.rva) || !Number.isInteger(dir.size) || dir.rva <= 0 || dir.size < minimum) return null;
  const start=mappedFileRangeForRva(image,dir.rva); if(!start)return null;
  const endRva=dir.rva+dir.size-1; if(!Number.isSafeInteger(endRva)||endRva<dir.rva)return null;
  const last=mappedFileRangeForRva(image,endRva); if(!last||last.owner!==start.owner)return null;
  const end=last.start+1; if(end<start.start)return null;
  return {start:start.start,end,owner:start.owner};
}
function boundedCString(r, off, maxBytes) { return Number.isInteger(off)&&off>=0&&off<r.length ? r.cstring(off,Math.min(maxBytes,r.length-off)) : ''; }
function markImportPartial(image, message, reason='malformed-or-truncated') {
  image.metadata.peImports ||= { complete:true,truncatedTables:0,descriptors:0,thunks:0,reasons:[] };
  image.metadata.peImports.complete=false; image.metadata.peImports.truncatedTables++; image.metadata.peImports.reasons.push(reason); image.warnings.push(message);
}
export function parseImports(r, dir, image, limits = PE_IMPORT_LIMITS) {
  if (!dir || !dir.rva || !dir.size) return;
  const meta=image.metadata.peImports ||= {complete:true,truncatedTables:0,descriptors:0,thunks:0,reasons:[]};
  const range=directoryFileRange(image,dir,20);
  if(!range){markImportPartial(image,'PE import directory is not wholly file-backed','directory-out-of-range');return;}
  let off=range.start; const end=Math.min(r.length,range.end),ptrSize=image.bits===64?8:4; let totalThunks=0,terminatedDirectory=false;
  for(let guard=0;guard<limits.descriptors&&off+20<=end;guard++,off+=20){
    const originalFirstThunk=r.u32(off),timeDateStamp=r.u32(off+4),forwarderChain=r.u32(off+8),nameRva=r.u32(off+12),firstThunk=r.u32(off+16);
    if(!(originalFirstThunk||timeDateStamp||forwarderChain||nameRva||firstThunk)){terminatedDirectory=true;break;}
    meta.descriptors++;
    const nameRange=mappedFileRangeForRva(image,nameRva),nameOff=nameRange?.start??null;
    const library=nameOff==null?'':boundedCString(r,nameOff,limits.stringBytes);
    if(!library){markImportPartial(image,'PE import descriptor has invalid/unterminated library name','invalid-library-name');continue;}
    image.libraries.push(library);
    const thunkRva=originalFirstThunk||firstThunk,thunkRange=mappedFileRangeForRva(image,thunkRva),iatRange=mappedFileRangeForRva(image,firstThunk);
    if(!thunkRange||!iatRange){markImportPartial(image,`PE import thunk table for ${library} is not file-backed`,'thunk-out-of-range');continue;}
    let terminated=false;
    for(let index=0;totalThunks<limits.thunks;index++,totalThunks++){
      const thunkOff=thunkRange.start+index*ptrSize,iatOff=iatRange.start+index*ptrSize;
      if(thunkOff+ptrSize>thunkRange.end||iatOff+ptrSize>iatRange.end||thunkOff+ptrSize>r.length||iatOff+ptrSize>r.length)break;
      const raw=image.bits===64?r.u64(thunkOff):BigInt(r.u32(thunkOff)); if(raw===0n){terminated=true;break;}
      const ordinalMask=image.bits===64?0x8000000000000000n:0x80000000n;let name=null,ordinal=null,hint=null;
      if(raw&ordinalMask)ordinal=Number(raw&0xffffn);
      else{
        const masked=raw&(image.bits===64?0x7fffffffffffffffn:0x7fffffffn);if(masked>0xffffffffn){markImportPartial(image,`PE import name RVA is out of range for ${library}`,'invalid-name-rva');continue;}
        const nr=mappedFileRangeForRva(image,Number(masked)); if(!nr||nr.start+2>nr.end) {markImportPartial(image,`PE import name is not file-backed for ${library}`,'invalid-name-rva');continue;}
        hint=r.u16(nr.start);name=boundedCString(r,nr.start+2,Math.min(limits.stringBytes,nr.end-(nr.start+2)));if(!name){markImportPartial(image,`PE import name is malformed for ${library}`,'invalid-import-name');continue;}
      }
      const iatAddress=image.imageBase+BigInt(firstThunk+index*ptrSize);
      image.imports.push({name:name||`#${ordinal}`,library,ordinal,hint,source:'PE-import',sites:[{address:iatAddress,offset:BigInt(iatOff),kind:'iat'}]});
      meta.thunks++;
    }
    if(totalThunks>=limits.thunks){markImportPartial(image,'PE import global thunk budget exhausted','thunk-budget');break;}
    if(!terminated)markImportPartial(image,`PE import thunk table for ${library} has no terminator inside mapped range`,'unterminated-thunk-table');
  }
  if(!terminatedDirectory && off+20<=end) markImportPartial(image,'PE import descriptor budget exhausted','descriptor-budget');
  else if(!terminatedDirectory && off<end) markImportPartial(image,'PE import directory ended without a terminator','unterminated-directory');
}

function markExportPartial(image,message,reason='malformed-or-truncated'){
  image.metadata.peExports ||= {complete:true,truncatedTables:0,functions:0,names:0,reasons:[]};
  image.metadata.peExports.complete=false;image.metadata.peExports.truncatedTables++;image.metadata.peExports.reasons.push(reason);image.warnings.push(message);
}
export function parseExports(r, dir, image, limits = PE_EXPORT_LIMITS) {
  if(!dir||!dir.rva||dir.size<40)return;
  const meta=image.metadata.peExports ||= {complete:true,truncatedTables:0,functions:0,names:0,reasons:[]};
  const dr=directoryFileRange(image,dir,40);if(!dr){markExportPartial(image,'PE export directory is not wholly file-backed','directory-out-of-range');return;}
  const off=dr.start;if(off+40>r.length){markExportPartial(image,'PE export header is truncated','header-truncated');return;}
  const nameRva=r.u32(off+12),baseOrdinal=r.u32(off+16),numberOfFunctions=r.u32(off+20),numberOfNames=r.u32(off+24),addrFunctions=r.u32(off+28),addrNames=r.u32(off+32),addrOrdinals=r.u32(off+36);
  const dllRange=mappedFileRangeForRva(image,nameRva);if(dllRange)image.metadata.exportName=boundedCString(r,dllRange.start,Math.min(limits.stringBytes,dllRange.end-dllRange.start));
  if(numberOfFunctions>limits.functions||numberOfNames>limits.names){markExportPartial(image,'PE export counts exceed global safety budget','count-budget');return;}
  const fr=mappedFileRangeForRva(image,addrFunctions),nr=mappedFileRangeForRva(image,addrNames),orr=mappedFileRangeForRva(image,addrOrdinals);
  if(!fr||!nr||!orr){markExportPartial(image,'PE export table RVAs are not file-backed','table-out-of-range');return;}
  const needF=numberOfFunctions*4,needN=numberOfNames*4,needO=numberOfNames*2;
  if(fr.start+needF>fr.end||nr.start+needN>nr.end||orr.start+needO>orr.end||fr.start+needF>r.length||nr.start+needN>r.length||orr.start+needO>r.length){markExportPartial(image,'PE export arrays exceed mapped file ranges','table-truncated');return;}
  const names=new Map();
  for(let i=0;i<numberOfNames;i++){
    const nrva=r.u32(nr.start+i*4),ordIndex=r.u16(orr.start+i*2);if(ordIndex>=numberOfFunctions){markExportPartial(image,'PE export ordinal index is outside function table','ordinal-out-of-range');continue;}
    const range=mappedFileRangeForRva(image,nrva);if(!range){markExportPartial(image,'PE export name RVA is not file-backed','name-out-of-range');continue;}
    const name=boundedCString(r,range.start,Math.min(limits.stringBytes,range.end-range.start));if(!name){markExportPartial(image,'PE export name is malformed/unterminated','invalid-name');continue;}
    names.set(ordIndex,name);meta.names++;
  }
  const dirStart=dir.rva,dirEnd=dir.rva+dir.size;
  if(!Number.isSafeInteger(dirEnd)||dirEnd<dirStart){markExportPartial(image,'PE export directory RVA arithmetic overflow','directory-overflow');return;}
  for(let i=0;i<numberOfFunctions;i++){
    const frva=r.u32(fr.start+i*4);if(!frva)continue;const name=names.get(i)||`#${baseOrdinal+i}`;
    if(frva>=dirStart&&frva<dirEnd){
      const range=mappedFileRangeForRva(image,frva),max=range?Math.min(limits.stringBytes,range.end-range.start,dirEnd-frva):0;
      const forwarder=range&&max>0?boundedCString(r,range.start,max):'';
      if(!forwarder){markExportPartial(image,'PE export forwarder is not valid inside export directory','invalid-forwarder');continue;}
      image.exports.push({name,address:0n,ordinal:baseOrdinal+i,kind:'forwarder',forwarder,source:'PE-export'});meta.functions++;continue;
    }
    const address=image.imageBase+BigInt(frva),sec=image.sectionAt(address);if(!sec){markExportPartial(image,'PE export target RVA is unmapped','target-unmapped');continue;}
    image.exports.push({name,address,ordinal:baseOrdinal+i,kind:'export',source:'PE-export'});meta.functions++;
    if(sec.perms.execute)image.functions.push(functionSeed(address,{name,source:'export',confidence:0.95}));
  }
}
'''
s=s[:a]+new+s[b:]
p.write_text(s)
