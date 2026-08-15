export const MACHO_LINKAGE_LIMITS = Object.freeze({
  imports: 120_000,
  exports: 120_000,
  sites: 200_000,
  mergedSymbols: 500_000,
});

function copyReasons(...groups) {
  const out=[];
  for(const group of groups||[])for(const reason of group||[]){const text=String(reason||'');if(text&&!out.includes(text))out.push(text);}
  return out;
}

function sourceCompleteness(image) {
  const meta=image?.metadata||{};
  const reasons=copyReasons(meta.machoMetadata?.reasons);
  if(meta.machoMetadata?.complete===false&&!reasons.length)reasons.push('canonical-macho-metadata-incomplete');
  if(meta.chainedFixups?.complete===false)reasons.push('chained-fixups-incomplete');
  if(meta.chainedFixups?.importsComplete===false)reasons.push('chained-imports-incomplete');
  if(meta.chainedFixups?.bindingSitesComplete===false)reasons.push('chained-binding-sites-incomplete');
  if(meta.dyldBindings?.complete===false)reasons.push('classic-dyld-bindings-incomplete');
  if(meta.exportTrie?.complete===false)reasons.push('export-trie-incomplete');
  return [...new Set(reasons)];
}

/** Compact, structured-clone-safe canonical import/export truth. */
export function normalizeMachOLinkage(image, limits = {}) {
  const cap={...MACHO_LINKAGE_LIMITS,...limits};
  const reasons=sourceCompleteness(image);
  const imports=[]; const exports=[];
  let sites=0;
  const rawImports=image?.imports||[];
  const rawExports=image?.exports||[];
  for(let i=0;i<rawImports.length;i++){
    if(imports.length>=cap.imports){reasons.push('linkage-import-transport-limit');break;}
    const imp=rawImports[i]; if(!imp?.name)continue;
    const kept=[];
    for(const site of imp.sites||[]){
      if(sites>=cap.sites){reasons.push('linkage-site-transport-limit');break;}
      if(site?.address==null)continue;
      kept.push({address:BigInt(site.address),offset:site.offset==null?null:BigInt(site.offset),kind:site.kind||imp.source||'bind',pointerFormat:site.pointerFormat??null,addend:site.addend??imp.addend??0n});
      sites++;
    }
    imports.push({name:String(imp.name),library:imp.library||null,ordinal:imp.ordinal??null,weak:!!imp.weak,source:imp.source||'macho-import',addend:imp.addend??0n,sites:kept});
    if(sites>=cap.sites&&i+1<rawImports.length)break;
  }
  for(const exp of rawExports){
    if(exports.length>=cap.exports){reasons.push('linkage-export-transport-limit');break;}
    if(!exp?.name)continue;
    exports.push({name:String(exp.name),address:exp.address==null?null:BigInt(exp.address),kind:exp.kind||'export',source:exp.source||'macho-export',flags:exp.flags??0,ordinal:exp.ordinal??null,imported:exp.imported||null,resolver:exp.resolver==null?null:BigInt(exp.resolver)});
  }
  const unique=[...new Set(reasons)];
  const canonicalComplete=unique.length===0;
  const importTransportComplete=rawImports.length<=cap.imports&&sites<cap.sites||rawImports.every((imp)=>!(imp?.sites?.length));
  const exportTransportComplete=rawExports.length<=cap.exports;
  return {
    format:'macho',architecture:image?.arch||null,libraries:(image?.libraries||[]).slice(0,4096),imports,exports,
    completeness:{
      complete:canonicalComplete&&importTransportComplete&&exportTransportComplete,
      importsComplete:canonicalComplete&&importTransportComplete,
      exportsComplete:canonicalComplete&&exportTransportComplete,
      symbolSitesComplete:canonicalComplete&&importTransportComplete,
      reasons:unique,
    },
    metadata:{machoMetadata:image?.metadata?.machoMetadata||null,chainedFixups:image?.metadata?.chainedFixups||null,dyldBindings:image?.metadata?.dyldBindings||null,exportTrie:image?.metadata?.exportTrie||null},
  };
}

export function unavailableMachOLinkage(reason='canonical-macho-linkage-unavailable') {
  return {format:'macho',architecture:null,libraries:[],imports:[],exports:[],completeness:{complete:false,importsComplete:false,exportsComplete:false,symbolSitesComplete:false,reasons:[reason]},metadata:null};
}

function namesOf(result){
  if(Array.isArray(result?.names))return result.names;
  if(typeof result?.names==='string'&&result.names.length)return result.names.split('\n');
  return [];
}
function validTransport(result){
  const n=result?.addrs?.length||0; const names=namesOf(result);
  return names.length===n&&(result?.kinds?.length||0)===n&&(result?.flags?.length||0)===n;
}
function chooseAtSame(legacy,canonical,i,j,legacyNames,canonicalNames){
  const ln=legacyNames[i]||'', cn=canonicalNames[j]||'';
  const useLegacy=!!ln||!cn;
  const lk=legacy.kinds?.[i]||0, ck=canonical.kinds?.[j]||0;
  return {
    name:useLegacy?ln:cn,
    kind:lk!==0?lk:ck,
    flag:(legacy.flags?.[i]||0)|(canonical.flags?.[j]||0),
    provenance:useLegacy?(legacy.nameProvenance?.[i]||{source:'legacy-macho-symbol',confidence:0.9,confirmed:true}):(canonical.nameProvenance?.[j]||{source:'canonical-macho-linkage',confidence:1,confirmed:true}),
  };
}

/** Merge two already-sorted symbol transports without allocating per-symbol objects. */
export function mergeMachoAnalysisTruth(legacy, canonical, options = {}) {
  const max=Math.max(1,Math.min(1_000_000,Number(options.maxSymbols)||MACHO_LINKAGE_LIMITS.mergedSymbols));
  if(!legacy)return canonical||null;
  if(!canonical||!validTransport(canonical))return {...legacy,linkage:canonical?.linkage||unavailableMachOLinkage('canonical-symbol-transport-invalid')};
  if(!validTransport(legacy))return {...canonical,funcs:legacy.funcs||canonical.funcs,funcEnds:legacy.funcEnds||canonical.funcEnds,linkage:canonical.linkage||unavailableMachOLinkage()};
  const la=legacy.addrs,ca=canonical.addrs,ln=namesOf(legacy),cn=namesOf(canonical);
  let i=0,j=0,count=0;
  while((i<la.length||j<ca.length)&&count<max){
    if(j>=ca.length||(i<la.length&&la[i]<ca[j]))i++;
    else if(i>=la.length||ca[j]<la[i])j++;
    else {i++;j++;}
    count++;
  }
  const truncated=i<la.length||j<ca.length;
  const addrs=new BigUint64Array(count),kinds=new Uint8Array(count),flags=new Uint8Array(count),names=new Array(count),nameProvenance=new Array(count);
  i=0;j=0;let n=0;
  while(n<count){
    if(j>=ca.length||(i<la.length&&la[i]<ca[j])){
      addrs[n]=la[i];kinds[n]=legacy.kinds[i];flags[n]=legacy.flags[i];names[n]=ln[i]||'';nameProvenance[n]=legacy.nameProvenance?.[i]||{source:'legacy-macho-symbol',confidence:0.9,confirmed:true};i++;
    }else if(i>=la.length||ca[j]<la[i]){
      addrs[n]=ca[j];kinds[n]=canonical.kinds[j];flags[n]=canonical.flags[j];names[n]=cn[j]||'';nameProvenance[n]=canonical.nameProvenance?.[j]||{source:'canonical-macho-linkage',confidence:1,confirmed:true};j++;
    }else{
      const chosen=chooseAtSame(legacy,canonical,i,j,ln,cn);addrs[n]=la[i];kinds[n]=chosen.kind;flags[n]=chosen.flag;names[n]=chosen.name;nameProvenance[n]=chosen.provenance;i++;j++;
    }
    n++;
  }
  let linkage=canonical.linkage||unavailableMachOLinkage();
  if(truncated){
    const reasons=copyReasons(linkage.completeness?.reasons,['symbol-merge-limit']);
    linkage={...linkage,completeness:{...(linkage.completeness||{}),complete:false,symbolSitesComplete:false,reasons}};
  }
  return {
    ...legacy,addrs,kinds,flags,names,nameProvenance,linkage,
    symbolCount:addrs.length,capped:!!legacy.capped||truncated,
    canonicalMetadata:canonical.canonicalMetadata||linkage.metadata||null,
  };
}
