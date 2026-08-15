/* Unity IL2CPP global-metadata.dat parser. */
const SANITY = 0xFAB11BAF;
const PAIR = { stringLiteral:0,stringLiteralData:1,string:2,events:3,properties:4,methods:5,parameterDefaultValues:6,fieldDefaultValues:7,fieldAndParameterDefaultValueData:8,fieldMarshaledSizes:9,parameters:10,fields:11,genericParameters:12,genericParameterConstraints:13,genericContainers:14,nestedTypes:15,interfaces:16,vtableMethods:17,interfaceOffsets:18,typeDefinitions:19,images:20,assemblies:21 };
const REQUIRED_HEADER_BYTES = 8 + (Math.max(...Object.values(PAIR)) + 1) * 8;

function utf8(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } }
function layoutCandidates(version) {
  if (version >= 29) return [{type:92,method:40,label:'29+'}];
  if (version >= 27) return [{type:92,method:40,label:'27+'},{type:96,method:40,label:'27-alt'}];
  if (version >= 25) return [{type:96,method:52,label:'25+'},{type:100,method:52,label:'25-alt'}];
  if (version === 24) return [
    {type:100,method:56,label:'24.0/24.1'},
    {type:100,method:52,label:'24.2/24.3'},
    {type:96,method:52,label:'24.4'},
    {type:92,method:40,label:'24.5'},
  ];
  return [{type:100,method:56,label:'legacy'}];
}

function headerContext(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.length < 8) throw new Error('ファイルが小さすぎます。global-metadata.dat ではないようです。');
  const dv = new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  if (dv.getUint32(0,true)!==SANITY) throw new Error('global-metadata.dat ではないようです（先頭の印が合いません）。');
  const version=dv.getInt32(4,true);
  if (u8.length < REQUIRED_HEADER_BYTES) throw new Error('global-metadata.dat のヘッダが途中で切れています。');
  const pairs=new Map();
  for(const [name,index] of Object.entries(PAIR)){
    const at=8+index*8;
    if(at+8>u8.length) throw new Error(`metadata header pair ${name} is missing`);
    const offset=dv.getInt32(at,true),size=dv.getInt32(at+4,true);
    if(offset<0||size<0) throw new Error(`metadata table ${name} has a negative range`);
    if(size>0 && (offset<REQUIRED_HEADER_BYTES || offset+size>u8.length)) throw new Error(`metadata table ${name} is outside the file`);
    pairs.set(name,{offset,size,end:offset+size});
  }
  const nonEmpty=[...pairs.entries()].filter(([,p])=>p.size>0).sort((a,b)=>a[1].offset-b[1].offset);
  for(let i=1;i<nonEmpty.length;i++) if(nonEmpty[i][1].offset<nonEmpty[i-1][1].end) throw new Error(`metadata tables ${nonEmpty[i-1][0]} and ${nonEmpty[i][0]} overlap`);
  return{u8,dv,version,pair:(name)=>pairs.get(name),pairs};
}

function makeStringAt(ctx){
  const table=ctx.pair('string');
  return(index)=>{
    if(!Number.isInteger(index)||index<0||index>=table.size)return null;
    const base=table.offset+index,maxEnd=Math.min(table.end,base+512);
    let end=base;while(end<maxEnd&&ctx.u8[end]!==0)end++;
    if(end>=maxEnd||ctx.u8[end]!==0)return null;
    if(end===base)return '';
    return utf8(ctx.u8.subarray(base,end));
  };
}

function parseLayout(ctx,layout){
  const {u8,dv,version}=ctx,stringAt=makeStringAt(ctx),warnings=[];
  const typeDefs=ctx.pair('typeDefinitions'),methodDefs=ctx.pair('methods');
  if(layout.type<8||layout.method<8||typeDefs.size%layout.type!==0||methodDefs.size%layout.method!==0)return null;
  const typeCount=Math.floor(typeDefs.size/layout.type),methodCount=Math.floor(methodDefs.size/layout.method);
  if(typeCount>200000||methodCount>500000)return null;
  const classes=[];let validTypeNames=0;
  for(let i=0;i<typeCount;i++){
    const o=typeDefs.offset+i*layout.type;if(o<typeDefs.offset||o+8>typeDefs.end)return null;
    const name=stringAt(dv.getInt32(o,true)),ns=stringAt(dv.getInt32(o+4,true));
    if(!name)continue;validTypeNames++;
    classes.push({index:i,name,namespace:ns||'',full:ns?ns+'.'+name:name});
  }
  const methods=[];let validOwners=0,validTokens=0,validMethodNames=0;
  const tokenAt=version>=27?24:40;
  for(let i=0;i<methodCount;i++){
    const o=methodDefs.offset+i*layout.method;if(o<methodDefs.offset||o+8>methodDefs.end)return null;
    const name=stringAt(dv.getInt32(o,true)),owner=dv.getInt32(o+4,true);
    if(owner<0||owner>=typeCount)continue;
    validOwners++;
    if(!name)continue;validMethodNames++;
    const token=o+tokenAt+4<=o+layout.method?dv.getUint32(o+tokenAt,true):0;
    if((token>>>24)===0x06||token===0)validTokens++;
    methods.push({index:i,name,classIndex:owner,token});
  }
  const byIndex=new Map(classes.map((c)=>[c.index,c]));
  for(const m of methods){const c=byIndex.get(m.classIndex);m.className=c?c.full:null;m.full=(c?c.full+'::':'')+m.name;}
  const images=parseImages(ctx,ctx.pair('images'),stringAt,typeCount);
  const literals=parseLiterals(ctx);
  const score=(validTypeNames/Math.max(1,typeCount))*4+(validMethodNames/Math.max(1,methodCount))*3+(validOwners/Math.max(1,methodCount))*5+(validTokens/Math.max(1,validMethodNames))*2+(images.length?1:0);
  return{version,classes,methods,literals,images,warnings,typeSize:layout.type,methodSize:layout.method,layout:layout.label,_layoutScore:score,_counts:{typeCount,methodCount}};
}

function parseLiterals(ctx){
  const index=ctx.pair('stringLiteral'),data=ctx.pair('stringLiteralData'),out=[];
  if(!index.size||!data.size||index.size%8!==0)return out;
  const count=Math.floor(index.size/8);
  for(let i=0;i<count&&i<200000;i++){
    const o=index.offset+i*8;if(o+8>index.end)break;
    const len=ctx.dv.getInt32(o,true),off=ctx.dv.getInt32(o+4,true);
    if(len<0||len>1<<16||off<0||off+len>data.size)continue;
    const text=utf8(ctx.u8.subarray(data.offset+off,data.offset+off+len));if(text!=null)out.push({index:i,text});
  }return out;
}

function parseImages(ctx,table,stringAt,typeCount){
  if(!table||table.size<=0)return[];let best={score:-1,out:[]};
  for(const size of [40,32,24]){
    if(table.size%size!==0)continue;const out=[];let validRanges=0,validNames=0;const count=Math.floor(table.size/size);
    for(let i=0;i<count&&i<10000;i++){
      const o=table.offset+i*size;if(o<0||o+16>table.end)break;
      const name=stringAt(ctx.dv.getInt32(o,true)),typeStart=ctx.dv.getInt32(o+8,true),typeCountForImage=ctx.dv.getUint32(o+12,true);
      if(typeStart<0||typeCountForImage>2_000_000||typeStart>typeCount||typeStart+typeCountForImage>typeCount)continue;
      validRanges++;if(name)validNames++;if(name)out.push({index:i,name,typeStart,typeCount:typeCountForImage});
    }
    const score=validRanges*3+validNames*2-(count-validRanges)*4;if(score>best.score)best={score,out};
  }return best.out;
}

function chooseLayout(ctx,candidates){let best=null;for(const layout of candidates){let res;try{res=parseLayout(ctx,layout);}catch{continue;}if(!res)continue;if(!best||res._layoutScore>best._layoutScore)best=res;}return best;}

export function parseMetadata(buffer){
  const ctx=headerContext(buffer),warnings=[];
  if(ctx.version<16||ctx.version>31)warnings.push('知らない版です（version '+ctx.version+'）。読める範囲だけ出します。');
  const candidates=layoutCandidates(ctx.version),res=chooseLayout(ctx,candidates);
  if(!res)throw new Error('metadata record layoutを安全に判定できませんでした。');
  res.warnings.unshift(...warnings);delete res._layoutScore;delete res._counts;
  if(candidates.length>1)res.warnings.push(`metadata v${ctx.version} のsub-layoutを整合性検証して ${res.layout} と判定しました。`);
  if(!res.classes.length)res.warnings.push('クラスの一覧を取り出せませんでした（版が違う可能性があります）。');
  if(!res.methods.length)res.warnings.push('メソッドの一覧を取り出せませんでした。');
  return res;
}

export function parseMetadataAuto(buffer){
  const ctx=headerContext(buffer);const candidates=[...layoutCandidates(ctx.version),{type:92,method:40,label:'probe-92/40'},{type:96,method:52,label:'probe-96/52'},{type:100,method:56,label:'probe-100/56'},{type:88,method:40,label:'probe-88/40'}];
  const unique=[...new Map(candidates.map((x)=>[`${x.type}/${x.method}`,x])).values()],res=chooseLayout(ctx,unique);if(!res)throw new Error('読み取れませんでした。');
  const expected=layoutCandidates(ctx.version)[0];if(res.typeSize!==expected.type||res.methodSize!==expected.method)res.warnings.push(`版の既定形ではなく、owner/token/range整合性が最も高い形（${res.typeSize} / ${res.methodSize} バイト）を採用しました。`);
  delete res._layoutScore;delete res._counts;return res;
}

function parseMetadataWith(buffer,typeSize,methodSize){const ctx=headerContext(buffer);const res=parseLayout(ctx,{type:Number(typeSize),method:Number(methodSize),label:'explicit'});if(!res)throw new Error('指定されたmetadata layoutは整合しません。');delete res._layoutScore;delete res._counts;return res;}

export function looksLikeUnity(strings,slice){const hints=['il2cpp','UnityEngine','global-metadata','Il2CppCodeRegistration','mono_'];let hit=0;for(const s of(strings||[]).slice(0,200000)){for(const h of hints)if(s.text&&s.text.includes(h)){hit++;break;}if(hit>=3)return true;}const dylibs=slice&&slice.info?slice.info.dylibs||[]:[];return dylibs.some((d)=>/UnityFramework|libil2cpp/i.test(d));}

export async function bindMethodAddresses(meta, opts) {
  const o = opts || {};
  const regions = o.regions || [];
  const read = o.read;
  if (!meta || !meta.methods || !meta.methods.length || typeof read !== 'function') return { bound: 0, candidate: null };
  meta.warnings ||= [];
  const exec = regions.filter((r) => r.exec && r.size > 0n);
  const data = regions.filter((r) => !r.exec && !r.zerofill && r.size >= 16n && /__(const|data|data_const|rodata)/.test(r.section || ''));
  const inExec = (raw) => { let p = BigInt.asUintN(64, raw); p &= 0x00ffffffffffffffn; return exec.some((r) => p >= r.vmAddr && p < r.vmAddr + r.size) ? p : null; };
  const containing = (addr, bytes) => regions.find((r) => addr >= r.vmAddr && addr + BigInt(bytes) <= r.vmAddr + r.size);
  const scanLimit = o.scanLimit || 64 * 1024 * 1024;
  const context = { regions, data, exec, read, containing, inExec, scanLimit };

  // Codegen modules carry image-name and metadata-token/RID evidence, so they
  // are strictly stronger than a shape-only global method-pointer table. Try
  // this path first for every metadata version that exposes image records.
  const modern = await bindCodeGenModules(meta, context);
  if (modern.bound) {
    meta.methodBinding = { ...(meta.methodBinding || {}), verified: true, evidence: ['image-name','token-rid','executable-pointer'] };
    return { ...modern, preferred: 'codegen-modules' };
  }

  // A legacy table maps metadata method indexes directly, so the candidate
  // must cover the complete method-definition slot range. meta.methods may
  // omit malformed records; max(index)+1 is therefore safer than length.
  const expectedSlots = meta.methods.reduce((m, method) => Math.max(m, Number(method.index) + 1), 0);
  const maxLegacyCount = expectedSlots + Math.max(32, Math.ceil(expectedSlots * 0.01));
  const candidates = [];
  let scanned = 0;

  const registrationNeighbors = (dv, at, byteLength) => {
    let observed = 0, proven = 0;
    for (let pair = 1; pair <= 3; pair++) {
      const pos = at + pair * 16;
      if (pos + 16 > byteLength) break;
      observed++;
      const count64 = dv.getBigUint64(pos, true);
      const pointer = dv.getBigUint64(pos + 8, true) & 0x00ffffffffffffffn;
      if (count64 < 1n || count64 > 5_000_000n) continue;
      const count = Number(count64);
      if (containing(pointer, Math.min(count, 16) * 8)) proven++;
    }
    return { observed, proven };
  };

  for (const r of data) {
    if (scanned >= scanLimit) break;
    const want = Math.min(Number(r.size), scanLimit - scanned);
    const bytes = await Promise.resolve(read(r.vmAddr, want)).catch(() => null); scanned += want;
    if (!bytes || bytes.length < 48) continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 48 <= bytes.length; at += 8) {
      const count64 = dv.getBigUint64(at, true);
      if (count64 < 1n || count64 > 5_000_000n) continue;
      const count = Number(count64);
      // Direct method.index -> table[index] binding is not trustworthy if the
      // table cannot cover every metadata method slot or has a large tail.
      if (count < expectedSlots || count > maxLegacyCount) continue;
      const table = dv.getBigUint64(at + 8, true) & 0x00ffffffffffffffn;
      const sampleCount = Math.min(count, 128);
      if (!containing(table, sampleCount * 8)) continue;
      const structure = registrationNeighbors(dv, at, bytes.length);
      if (structure.observed < 2 || structure.proven < 2) continue;
      const sample = await Promise.resolve(read(table, sampleCount * 8)).catch(() => null);
      if (!sample || sample.length < sampleCount * 8) continue;
      const sdv = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
      let executable = 0, nonzero = 0;
      for (let i = 0; i < sampleCount; i++) {
        const raw = sdv.getBigUint64(i * 8, true);
        if (raw) nonzero++;
        if (inExec(raw) != null) executable++;
      }
      const ratio = executable / Math.max(1, nonzero);
      if (nonzero < Math.min(16, sampleCount) || ratio < 0.95) continue;
      const coveragePenalty = Math.abs(count - expectedSlots) / Math.max(1, expectedSlots);
      candidates.push({
        addr: r.vmAddr + BigInt(at), table, count, ratio,
        structurePairs: structure.proven,
        score: ratio + structure.proven * 0.04 - coveragePenalty * 0.5,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || Number(a.addr - b.addr));
  const best = candidates[0], second = candidates[1];
  if (!best) {
    meta.warnings.push('Codegen moduleを検証した後も、構造証明できるlegacy Method→address表は見つかりませんでした。');
    return { bound: 0, candidate: null, modernTried: true, reason: 'no-proven-legacy-table' };
  }
  const margin = o.legacyAmbiguityMargin ?? 0.08;
  if (second && best.score - second.score < margin) {
    meta.warnings.push(`Legacy method pointer候補が曖昧です（上位差 ${Math.max(0,best.score-second.score).toFixed(3)}）。自動bindingしません。`);
    return { bound: 0, candidate: null, modernTried: true, reason: 'ambiguous-legacy-table', ambiguousCandidates: Math.min(candidates.length, 2) };
  }

  const tableBytes = await Promise.resolve(read(best.table, best.count * 8)).catch(() => null);
  if (!tableBytes || tableBytes.length < best.count * 8) return { bound: 0, candidate: null, modernTried: true, reason: 'legacy-table-unreadable' };
  const tdv = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
  const resolved = [];
  for (const method of meta.methods) {
    if (method.index < 0 || method.index >= best.count) continue;
    const address = inExec(tdv.getBigUint64(method.index * 8, true));
    if (address != null) resolved.push({ method, address });
  }
  const minResolved = Math.min(8, meta.methods.length);
  const coverage = resolved.length / Math.max(1, meta.methods.length);
  if (resolved.length < minResolved || coverage < 0.5) {
    meta.warnings.push(`Legacy method pointer表の全体整合性が不足しています（${resolved.length}/${meta.methods.length}）。自動bindingしません。`);
    return { bound: 0, candidate: null, modernTried: true, reason: 'legacy-coverage-insufficient' };
  }

  for (const { method, address } of resolved) { method.address = address; method.binding = 'code-registration'; }
  const bound = resolved.length;
  meta.methodBinding = {
    kind: 'code-registration', bound, count: best.count, table: best.table,
    verified: true,
    evidence: ['slot-coverage','registration-neighbors','executable-pointer-ratio','unique-candidate'],
    executableRatio: best.ratio,
    structurePairs: best.structurePairs,
  };
  return { bound, candidate: best, modernTried: true, preferred: 'verified-legacy' };
}

async function bindCodeGenModules(meta, ctx) {
  const { data, read, containing, inExec, scanLimit } = ctx; const images = meta.images || []; if (!images.length) return { bound: 0, candidate: null };
  const raw = []; let scanned = 0;
  for (const r of data) { if (scanned >= scanLimit) break; const want = Math.min(Number(r.size), scanLimit - scanned); const bytes = await Promise.resolve(read(r.vmAddr, want)).catch(() => null); scanned += want; if (!bytes || bytes.length < 24) continue; const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 24 <= bytes.length; at += 8) { const namePtr = dv.getBigUint64(at, true) & 0x00ffffffffffffffn, count = dv.getUint32(at + 8, true), table = dv.getBigUint64(at + 16, true) & 0x00ffffffffffffffn; if (!count || count > meta.methods.length + 4096 || !containing(namePtr, 1) || !containing(table, Math.min(count, 32) * 8)) continue; raw.push({ addr: r.vmAddr + BigInt(at), namePtr, count, table }); if (raw.length >= 5000) break; }
  }
  const wantedNames = new Set(images.map((x) => x.name.toLowerCase())), modules = new Map();
  for (const c of raw) { const nameBytes = await Promise.resolve(read(c.namePtr, 160)).catch(() => null); if (!nameBytes) continue; const zero = nameBytes.indexOf(0); if (zero < 0) continue; const name = utf8(nameBytes.subarray(0, zero)); if (!name || !wantedNames.has(name.toLowerCase())) continue; const sampleCount = Math.min(c.count, 64), sample = await Promise.resolve(read(c.table, sampleCount * 8)).catch(() => null); if (!sample || sample.length < sampleCount * 8) continue; const dv = new DataView(sample.buffer, sample.byteOffset, sample.byteLength); let nonzero = 0, executable = 0; for (let i = 0; i < sampleCount; i++) { const p = dv.getBigUint64(i * 8, true); if (p) nonzero++; if (inExec(p) != null) executable++; } if (nonzero && executable / nonzero >= 0.85) modules.set(name.toLowerCase(), c); }
  let bound = 0; const tables = new Map();
  for (const image of images) { const mod = modules.get(image.name.toLowerCase()); if (!mod) continue; const bytes = await Promise.resolve(read(mod.table, mod.count * 8)).catch(() => null); if (bytes && bytes.length >= mod.count * 8) tables.set(image.index, { mod, bytes }); }
  for (const method of meta.methods) { const image = images.find((x) => method.classIndex >= x.typeStart && method.classIndex < x.typeStart + x.typeCount); if (!image || !method.token) continue; const entry = tables.get(image.index), rid = (method.token & 0x00ffffff) - 1; if (!entry || rid < 0 || rid >= entry.mod.count) continue; const dv = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength), address = inExec(dv.getBigUint64(rid * 8, true)); if (address == null) continue; method.address = address; method.binding = 'codegen-module'; bound++; }
  if (bound) meta.methodBinding = { kind: 'codegen-modules', bound, modules: tables.size }; return { bound, candidate: null, modules: tables.size };
}
