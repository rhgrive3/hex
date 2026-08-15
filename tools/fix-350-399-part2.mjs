import fs from 'node:fs';

const read=(p)=>fs.readFileSync(p,'utf8');
const write=(p,s)=>fs.writeFileSync(p,s);
function once(s,a,b,label){ const i=s.indexOf(a); if(i<0) throw new Error('missing '+label); if(s.indexOf(a,i+a.length)>=0) throw new Error('ambiguous '+label); return s.slice(0,i)+b+s.slice(i+a.length); }
function edit(p,fn){ const a=read(p), b=fn(a); if(a===b) throw new Error('no changes '+p); write(p,b); }

// #394: signature evidence is fused; only strong exact provenance may hard-suppress app code.
edit('js/recognition/classifier.js', s => {
  s=once(s,
`  const name = fp.name || '';
  if (context.owningLibrary && SYSTEM_LIBS.some((rx) => rx.test(String(context.owningLibrary)))) return { classification:'SYSTEM', confidence:0.92, evidence:['system-library:' + context.owningLibrary] };
  if (GENERATED.some((rx) => rx.test(name))) return { classification: 'GENERATED', confidence: 0.9, evidence: ['compiler-generated-name'] };
  if (RUNTIME_NAMES.some((rx) => rx.test(name))) return { classification:'RUNTIME', confidence:0.88, evidence:['runtime-symbol-name'] };`,
`  const name = fp.name || '';
  if (signature) evidence.push('signature-hint:' + (signature.library || signature.name || signature.classification));
  if (context.owningLibrary && SYSTEM_LIBS.some((rx) => rx.test(String(context.owningLibrary)))) return { classification:'SYSTEM', confidence:0.92, evidence:['system-library:' + context.owningLibrary], hardSuppress:true };
  if (GENERATED.some((rx) => rx.test(name))) return { classification: 'GENERATED', confidence: 0.9, evidence: ['compiler-generated-name'], hardSuppress:true };
  if (RUNTIME_NAMES.some((rx) => rx.test(name))) return { classification:'RUNTIME', confidence:0.88, evidence:['runtime-symbol-name'], hardSuppress:true };`, '#394 strong provenance');
  s=once(s,
`    return { classification, confidence: context.vendor.confidence, evidence: context.vendor.evidence || [] };`,
`    return { classification, confidence: context.vendor.confidence, evidence: context.vendor.evidence || [], hardSuppress:true };`, '#394 vendor hard provenance');
  s=once(s,
`  if (appScore >= 0.38) return { classification: 'APPLICATION', confidence: Math.min(0.95, 0.5 + appScore / 2), evidence };
  return { classification: 'UNKNOWN', confidence: 0.35, evidence };`,
`  if (appScore >= 0.38) return { classification: 'APPLICATION', confidence: Math.min(0.95, 0.5 + appScore / 2), evidence, hardSuppress:false };
  if (signature) return { classification:signature.classification, confidence:Math.min(0.79, Math.max(0.35, signatureConfidence)), evidence, hardSuppress:false };
  return { classification: 'UNKNOWN', confidence: 0.35, evidence, hardSuppress:false };`, '#394 soft signature');
  s=once(s,
`  if (cls.classification === 'SDK' || cls.classification === 'RUNTIME' || cls.classification === 'SYSTEM') score -= 0.55;`,
`  if (cls.classification === 'SDK' || cls.classification === 'RUNTIME' || cls.classification === 'SYSTEM') {
    score -= cls.hardSuppress === true && cls.confidence >= 0.8 ? 0.55 : 0.08 * Math.max(0,Math.min(1,cls.confidence || 0));
  }`, '#394 application score');
  s=once(s,
`    const suppressed = ['SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED'].includes(cls.classification);`,
`    const suppressed = ['SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED'].includes(cls.classification) && cls.hardSuppress === true && cls.confidence >= 0.8;`, '#394 cluster suppression');
  return s;
});

// #395: candidate caps are surfaced and conservatively block auto-reidentification.
edit('js/knowledge/index.js', s => {
  s=once(s,
`function requestPromise(request) { return new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }`,
`function requestPromise(request) { return new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); }); }
function candidateBatch(values, truncated = false) {
  const out = Array.isArray(values) ? values : [];
  Object.defineProperty(out, 'truncated', { value:!!truncated, enumerable:false, configurable:true });
  return out;
}`, '#395 candidate batch metadata');
  s=once(s,
`    return matches.slice(0,limit);
  }

  async reidentify(input, options = {}) {
    const matches = await this.findMatches(input, { threshold:options.threshold ?? 0.58, limit:Math.max(5, options.limit || 5) });
    if (!matches.length) return { matched:false, ambiguous:false, confidence:0, candidates:[] };
    const best = matches[0], second = matches[1];
    const ambiguous = !!second && best.confidence - second.confidence < (options.ambiguityWindow ?? 0.045);
    const accepted = !ambiguous && best.confidence >= (options.acceptThreshold ?? 0.82) && ['exact','normalized-identical','semantic-equivalent','probable-same'].includes(best.identity);
    return {
      matched:accepted, ambiguous, confidence:best.confidence, knowledge:accepted ? best.record : null, reasons:best.reasons,
      candidates:matches.map((x) => ({ id:x.record.id, names:x.record.names, roles:x.record.roles, confirmation:x.record.confirmation, confidence:x.confidence, identity:x.identity, reasons:x.reasons })),
    };
  }`,
`    const selected = matches.slice(0,limit);
    return candidateBatch(selected, records.truncated === true || matches.length > limit);
  }

  async reidentify(input, options = {}) {
    const matches = await this.findMatches(input, { threshold:options.threshold ?? 0.58, limit:Math.max(5, options.limit || 5) });
    if (!matches.length) return { matched:false, ambiguous:matches.truncated === true, truncated:matches.truncated === true, confidence:0, candidates:[] };
    const best = matches[0], second = matches[1];
    const truncated = matches.truncated === true;
    const ambiguous = truncated || (!!second && best.confidence - second.confidence < (options.ambiguityWindow ?? 0.045));
    const accepted = !ambiguous && best.confidence >= (options.acceptThreshold ?? 0.82) && ['exact','normalized-identical','semantic-equivalent','probable-same'].includes(best.identity);
    return {
      matched:accepted, ambiguous, truncated, confidence:best.confidence, knowledge:accepted ? best.record : null, reasons:best.reasons,
      candidates:matches.map((x) => ({ id:x.record.id, names:x.record.names, roles:x.record.roles, confirmation:x.record.confirmation, confidence:x.confidence, identity:x.identity, reasons:x.reasons })),
    };
  }`, '#395 reidentify truncation');
  s=once(s,
`    return (strong.length ? strong : records.filter((r) => r.fingerprint?.size && fp.size && Math.min(r.fingerprint.size,fp.size)/Math.max(r.fingerprint.size,fp.size) >= 0.7)).slice(0,this.maxCandidates);`,
`    const pool = strong.length ? strong : records.filter((r) => r.fingerprint?.size && fp.size && Math.min(r.fingerprint.size,fp.size)/Math.max(r.fingerprint.size,fp.size) >= 0.7);
    return candidateBatch(pool.slice(0,this.maxCandidates), pool.length > this.maxCandidates);`, '#395 memory cap');
  const old=`  async #candidateRecords(fp,limit) {
    const db=await this.#dbOpen(); const store=db.transaction('functions','readonly').objectStore('functions'); const out=new Map();
    for (const [index,value] of [['normalizedBytesHash',fp.normalizedBytesHash],['semanticHash',fp.semanticHash],['instructionSequenceHash',fp.instructionSequenceHash]]) {
      if (!value || !store.indexNames.contains(index)) continue;
      const found=await requestPromise(store.index(index).getAll(value, Math.min(limit,250))); for (const r of found) out.set(r.id,r);
      if (out.size>=limit) break;
    }
    if (out.size) return [...out.values()].slice(0,limit);
    // Bounded cursor fallback; never load the complete DB into memory.
    return new Promise((resolve,reject) => {
      const rows=[]; const req=store.openCursor();
      req.onsuccess=()=>{ const c=req.result; if (!c || rows.length>=limit) return resolve(rows); const r=c.value, sz=r.fingerprint?.size; if (sz && fp.size && Math.min(sz,fp.size)/Math.max(sz,fp.size)>=0.7) rows.push(r); c.continue(); };
      req.onerror=()=>reject(req.error);
    });
  }`;
  const neu=`  async #candidateRecords(fp,limit) {
    const db=await this.#dbOpen(); const store=db.transaction('functions','readonly').objectStore('functions'); const out=new Map();
    let truncated=false;
    for (const [index,value] of [['normalizedBytesHash',fp.normalizedBytesHash],['semanticHash',fp.semanticHash],['instructionSequenceHash',fp.instructionSequenceHash]]) {
      if (!value || !store.indexNames.contains(index)) continue;
      const cap=Math.min(limit,250);
      const found=await requestPromise(store.index(index).getAll(value, cap + 1));
      if (found.length > cap) truncated=true;
      for (const r of found.slice(0,cap)) out.set(r.id,r);
      if (out.size>=limit) { truncated=true; break; }
    }
    if (out.size) return candidateBatch([...out.values()].slice(0,limit), truncated || out.size > limit);
    // Bounded cursor fallback; scan one extra matching row so a cap can never be
    // mistaken for exhaustive evidence. A hard scan cap itself is truncation.
    return new Promise((resolve,reject) => {
      const rows=[]; let scanned=0; const scanCap=Math.max(2000,limit*20); const req=store.openCursor();
      req.onsuccess=()=>{ const c=req.result; if (!c || rows.length>limit || scanned>=scanCap) return resolve(candidateBatch(rows.slice(0,limit), rows.length>limit || (!!c && scanned>=scanCap))); scanned++; const r=c.value, sz=r.fingerprint?.size; if (sz && fp.size && Math.min(sz,fp.size)/Math.max(sz,fp.size)>=0.7) rows.push(r); c.continue(); };
      req.onerror=()=>reject(req.error);
    });
  }`;
  s=once(s,old,neu,'#395 indexed cap');
  return s;
});

// #398: infer extents only within the same canonical executable region.
edit('js/binary/model.js', s => {
  s=once(s, `    this.functions = mergeFunctionSeeds(this.functions);`, `    this.functions = mergeFunctionSeeds(this.functions, { sections:this.sections, segments:this.segments });`, '#398 finalize regions');
  s=once(s, `export function mergeFunctionSeeds(input) {`, `export function mergeFunctionSeeds(input, context = {}) {`, '#398 signature');
  s=once(s,
`  const out = [...m.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  for (let i = 0; i < out.length; i++) {`,
`  const out = [...m.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const regions = [...(context.sections || []), ...(context.segments || [])]
    .filter((r) => r && r.address != null && r.size != null && BigInt(r.size) > 0n && r.perms?.execute)
    .sort((a,b) => BigInt(a.size) < BigInt(b.size) ? -1 : BigInt(a.size) > BigInt(b.size) ? 1 : 0);
  const regionFor = (addr) => regions.find((r) => BigInt(addr) >= BigInt(r.address) && BigInt(addr) < BigInt(r.address) + BigInt(r.size)) || null;
  for (let i = 0; i < out.length; i++) {`, '#398 region map');
  s=once(s,
`      if (provenFunctionStarts && delta <= 0x1000000n) {
        f.size = delta; f.end = next.address;
        f.extentInferred = true;
        f.extentConfidence = Math.min(0.35, Number(f.confidence ?? 0.35));
        f.extentSource = 'next-function-start';
      }`,
`      const currentRegion = regionFor(f.address), nextRegion = regionFor(next.address);
      const sameCanonicalRegion = !regions.length || (currentRegion != null && currentRegion === nextRegion);
      const withinRegionEnd = !currentRegion || next.address <= BigInt(currentRegion.address) + BigInt(currentRegion.size);
      if (provenFunctionStarts && sameCanonicalRegion && withinRegionEnd && delta <= 0x1000000n) {
        f.size = delta; f.end = next.address;
        f.extentInferred = true;
        f.extentConfidence = Math.min(0.35, Number(f.confidence ?? 0.35));
        f.extentSource = 'next-function-start';
      }`, '#398 extent constraint');
  return s;
});

// #399: strict UTF-8 + UTF-16LE scanning, Unicode printability and surrogate support.
edit('js/binary/strings.js', _s => `function printableCodePoint(cp) {
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
    for(let p=start;p+1<end;){
      const first=utf16At(bytes,p,end); if(!first||!printableCodePoint(first.cp)){p++;continue;}
      const s=p; let q=p, chars=0;
      while(q+1<end&&chars<max){ const x=utf16At(bytes,q,end); if(!x||!printableCodePoint(x.cp)) break; q+=x.bytes; chars++; }
      if(chars>=min) emit(image,out,seen,s,q-s,'utf16le',range.section);
      p=Math.max(q+(q<end?2:0),p+1);
    }
  }
  return out;
}
function emit(image,out,seen,fileOffset,byteLength,encoding,section){
  const key=\`${'${fileOffset}'}:${'${encoding}'}\`; if(seen.has(key)) return; seen.add(key);
  const raw=image.bytes.subarray(fileOffset,fileOffset+byteLength);
  let text; try { text=new TextDecoder(encoding==='utf16le'?'utf-16le':'utf-8',{fatal:true}).decode(raw); } catch { return; }
  out.push({text,encoding,fileOffset:BigInt(fileOffset),address:image.offsetToAddress(BigInt(fileOffset)),byteLength,section});
}
`);

// Tighten #377 saturation at 64-bit boundaries without Number(max) rounding.
edit('js/emu.js', s => {
  s=once(s,
`          if (t <= 0) result = 0n;
          else if (!Number.isFinite(t) || t >= Number(max)) result = max;
          else result = BigInt(t);
        } else {
          const min = -(1n << BigInt(bits - 1)), max = (1n << BigInt(bits - 1)) - 1n;
          if (t === -Infinity || t <= Number(min)) result = min;
          else if (t === Infinity || t >= Number(max)) result = max;
          else result = BigInt(t);`,
`          if (t <= 0) result = 0n;
          else if (!Number.isFinite(t)) result = max;
          else { const integer=BigInt(t); result=integer>max?max:integer; }
        } else {
          const min = -(1n << BigInt(bits - 1)), max = (1n << BigInt(bits - 1)) - 1n;
          if (!Number.isFinite(t)) result = t < 0 ? min : max;
          else { const integer=BigInt(t); result=integer<min?min:integer>max?max:integer; }`, '#377 exact saturation bounds');
  return s;
});

// #379 security fixtures: normal output remains usable, giant/flood output is terminated.
edit('tests/sandbox.mjs', s => {
  s=once(s,
`    const runawayMs = performance.now() - begin;
    return { value, lines, leak: window.__sandboxLeak, discovered, plugin, pluginLines,
      emulator, emuLines, runaway, runawayMs };`,
`    const runawayMs = performance.now() - begin;
    const normalLines=[];
    const normalOutput=await runInSandbox({source:"for(let i=0;i<8;i++) print('ok',i)",api:{},out:(...args)=>normalLines.push(args),timeout:5000});
    const giantOutput=await runInSandbox({source:'print(new Uint8Array(300000))',api:{},out:()=>{},timeout:5000});
    const floodOutput=await runInSandbox({source:"for(let i=0;i<500;i++) print('x')",api:{},out:()=>{},timeout:5000});
    const directOutput=await runInSandbox({source:'postMessage(new Uint8Array(300000)); await new Promise(r=>setTimeout(r,1000))',api:{},out:()=>{},timeout:5000});
    return { value, lines, leak: window.__sandboxLeak, discovered, plugin, pluginLines,
      emulator, emuLines, runaway, runawayMs, normalOutput, normalLines, giantOutput, floodOutput, directOutput };`, '#379 sandbox fixtures');
  s=once(s,
`      !result.runaway.error || !/時間制限/.test(result.runaway.error) || result.runawayMs > 2000 ||
      unexpected.length) {`,
`      !result.runaway.error || !/時間制限/.test(result.runaway.error) || result.runawayMs > 2000 ||
      !result.normalOutput.ok || result.normalLines.length !== 8 ||
      !/安全上限/.test(result.giantOutput.error || '') || !/安全上限/.test(result.floodOutput.error || '') || !/安全上限/.test(result.directOutput.error || '') ||
      unexpected.length) {`, '#379 assertions');
  return s;
});

// #383: make the untrusted-code boundary an explicit Playwright CI gate.
fs.writeFileSync('.github/workflows/sandbox-security.yml', `name: Sandbox security\n\non:\n  pull_request:\n    paths:\n      - 'js/sandbox.js'\n      - 'js/plugin*.js'\n      - 'js/plugins/**'\n      - 'js/**/script*.js'\n      - 'tests/sandbox.mjs'\n      - 'package.json'\n      - '.github/workflows/sandbox-security.yml'\n  workflow_dispatch:\n\njobs:\n  sandbox-security:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - name: Install Playwright Chromium\n        run: |\n          npm install --no-save playwright\n          npx playwright install-deps chromium\n          npx playwright install chromium\n      - name: Run sandbox security regression\n        env:\n          CI: '1'\n        run: npm run sandbox\n`);

// Focused regression suite for the non-browser issues in this range.
fs.writeFileSync('tests/issues-350-399.mjs', `import { buildSemanticModel } from '../js/blocks.js';\nimport { buildIR, OP } from '../js/ir.js';\nimport { reachingRegisterValue } from '../js/decompiler/semantic.js';\nimport { Emulator } from '../js/emu.js';\nimport { scanStrings } from '../js/binary/strings.js';\nimport { mergeFunctionSeeds } from '../js/binary/model.js';\nimport { decodeTypeEncoding, decodeMethodListHeader } from '../js/objc-legacy.js';\nimport { mergeRecoveredTypes } from '../js/decompiler/type-recovery.js';\nimport { classifyFunction, applicationCodeScore } from '../js/recognition/classifier.js';\nimport { fuseStaticDynamic } from '../js/runtime-evidence/index.js';\nimport { compareExpected } from '../js/dynamic/experiments.js';\nimport { fingerprintFunction as binaryFingerprintFunction, fingerprintImage } from '../js/binary/fingerprint.js';\nimport { KnowledgeDB } from '../js/knowledge/index.js';\n\nlet passed=0; const fail=[]; function ok(x,m='expected truthy'){if(!x)throw new Error(m)} function eq(a,b,m='not equal'){if(a!==b)throw new Error(m+': '+String(a)+' != '+String(b))} async function test(n,fn){try{await fn();passed++;console.log('  ok  '+n)}catch(e){fail.push([n,e]);console.error('FAIL  '+n+'\\n      '+e.message)}}\nconst BASE=0x100000000n;\nfunction asm(lines){return lines.map((line,i)=>{const s=line.trim(), p=s.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?s:s.slice(0,p),ops:p<0?'':s.slice(p+1)}})}\nfunction build(lines){const rowOfAddress=a=>{const d=a-BASE;return d<0n||d>=BigInt(lines.length*4)?null:Number(d/4n)};const model=buildSemanticModel(asm(lines),{startRow:0,endRow:lines.length-1,rowOfAddress});return buildIR(model,{rowOfAddress})}\nawait test('#351 CCMP fallback NZCV is retained',()=>{const ir=build(['cmp w0, #0','ccmp w1, w2, #6, eq','b.ne #0x10000000c','ret']);const c=ir.instructions.find(x=>x.op===OP.CMP&&x.extra?.conditional);eq(c.extra.fallbackNzcv,6)});\nawait test('#352 32-bit variable shift masks by 31',()=>{const ir=build(['mov w0, #1','mov w1, #32','lsl w2, w0, w1','ret']);eq(ir.values.filter(v=>v.reg==='x2').pop().const,1n)});\nawait test('#354 SMADDL constant fold sign-extends 32-bit inputs',()=>{const ir=build(['mov w1, #0xffffffff','mov w2, #2','mov x3, #0','smaddl x0, w1, w2, x3','ret']);eq(ir.values.filter(v=>v.reg==='x0').pop().const,0xfffffffffffffffen)});\nawait test('#355 caller-saved clobber stops reaching query',()=>{const ir=build(['mov x2, #7','bl #0x200000000','add x0, x2, #1','ret']);const add=ir.instructions.find(x=>x.op===OP.BIN);eq(reachingRegisterValue(ir,add,'x2'),null)});\nawait test('#359 overlapping partial store kills wider reaching store',()=>{const ir=build(['str x1, [x0]','strb w2, [x0]','ldr x3, [x0]','ret']);const load=ir.instructions.find(x=>x.op===OP.LOAD);eq(load.reachingStore,undefined)});\nawait test('#360 plain LDR is not positive unsigned evidence',()=>{const ir=build(['ldr w1, [x0]','ret']);const load=ir.instructions.find(x=>x.op===OP.LOAD);eq(load.dst.signed,null)});\nawait test('#364 exclusive store may fail without monitor',async()=>{const e=new Emulator({});e.set('x0',0x600000000000n);e.set('x1',5n);await e.execute('stxr','w2, x1, [x0]',0n);eq(e.get('w2'),1n)});\nawait test('#365 FDIV follows IEEE infinity',()=>{const e=new Emulator({});e.v[1]=1;e.v[2]=0;e.floatInsn('fdiv',[{k:'reg',cls:'fp',num:0,text:'d0',bits:64},{k:'reg',cls:'fp',num:1,text:'d1',bits:64},{k:'reg',cls:'fp',num:2,text:'d2',bits:64}]);eq(e.v[0],Infinity)});\nawait test('#367 FCMP unordered is NZCV=0011',()=>{const e=new Emulator({});e.v[0]=NaN;e.v[1]=1;e.floatInsn('fcmp',[{k:'reg',cls:'fp',num:0,text:'d0',bits:64},{k:'reg',cls:'fp',num:1,text:'d1',bits:64}]);ok(!e.nzcv.n&&!e.nzcv.z&&e.nzcv.c&&e.nzcv.v)});\nawait test('#368 FP register preserves NaN',()=>{const e=new Emulator({});e.v[3]=NaN;ok(Number.isNaN(e.fget({k:'reg',cls:'fp',num:3,text:'d3',bits:64})))});\nawait test('#369 S register rounds to binary32',()=>{const e=new Emulator({});e.fset({k:'reg',cls:'fp',num:0,text:'s0',bits:32},1/3);eq(e.v[0],Math.fround(1/3))});\nawait test('#371 SBFIZ sign extends inserted sign bit',async()=>{const e=new Emulator({});e.set('w1',0xffn);await e.execute('sbfiz','w0, w1, #0, #8',0n);eq(e.get('w0'),0xffffffffn)});\nawait test('#377 FCVTZU negative saturates to zero',()=>{const e=new Emulator({});e.v[1]=-1.5;e.floatInsn('fcvtzu',[{k:'reg',cls:'gp',num:0,text:'w0',bits:32},{k:'reg',cls:'fp',num:1,text:'s1',bits:32}]);eq(e.get('w0'),0n)});\nawait test('#381 c is signed char and B is bool',()=>{const c=decodeTypeEncoding('c'), b=decodeTypeEncoding('B');eq(c.signed,true);eq(c.bool,undefined);eq(b.kind,'bool')});\nawait test('#380 direct selector flag decoded',()=>{const h=decodeMethodListHeader(0xc000000c);ok(h.relative&&h.directSelector);eq(h.stride,12)});\nawait test('#388 fusion fails closed without complete identity',()=>{const r=fuseStaticDynamic({confidence:.8},[{source:'runtime',binaryHash:'A',function:1n,verdict:'supported'}]);eq(r.status,'inconclusive');eq(r.reason,'identity-missing');eq(r.runtimeGroups,0)});\nawait test('#390 last memory delta is final fallback',()=>{const c={expected:{field:{offset:8n,value:50n}}};const r=compareExpected(c,{memoryDelta:[{offset:8n,after:80n},{offset:8n,after:50n}]});eq(r.status,'supported')});\nawait test('#393 ambiguity remains sticky',()=>{const a={name:'int32_t',kind:'int',confidence:.8},b={name:'float',kind:'float',confidence:.8},c={name:'int32_t',kind:'int',confidence:.81};const r=mergeRecoveredTypes(mergeRecoveredTypes(a,b),c);eq(r.kind,'ambiguous');ok(r.candidates.length>=2)});\nawait test('#394 weak SDK signature does not hard-suppress strong app evidence',()=>{const fn={name:'appFn',semantic:{writes:['field'],reads:[],rmw:[],calls:[],fieldShape:[],thresholds:[],operations:[]},strings:['my-app-state'],imports:[],calls:[],fieldAccessShape:[],objc:{class:null},swift:{typeDescriptor:null}};const ctx={signature:{classification:'SDK',confidence:.2},appStrings:new Set(['my-app-state']),notKnownVendor:true,calledFromApplication:true};const c=classifyFunction(fn,ctx);eq(c.classification,'APPLICATION');ok(applicationCodeScore(fn,ctx)>.3)});\nawait test('#394 exact high confidence signature can hard-suppress',()=>{const c=classifyFunction({name:'f'},{signature:{classification:'SDK',confidence:.99,exact:true}});eq(c.classification,'SDK');eq(c.hardSuppress,true)});\nawait test('#398 function extent does not cross executable section',()=>{const seeds=[{address:0x1000n,source:'function_starts',confidence:.9},{address:0x2000n,source:'function_starts',confidence:.9}];const sections=[{address:0x1000n,size:0x100n,perms:{execute:true}},{address:0x2000n,size:0x100n,perms:{execute:true}}];const out=mergeFunctionSeeds(seeds,{sections});eq(out[0].size,null)});\nawait test('#398 contiguous starts in same section still infer',()=>{const seeds=[{address:0x1000n,source:'function_starts',confidence:.9},{address:0x1080n,source:'function_starts',confidence:.9}];const sections=[{address:0x1000n,size:0x200n,perms:{execute:true}}];const out=mergeFunctionSeeds(seeds,{sections});eq(out[0].size,0x80n)});\nawait test('#399 UTF-8/UTF-16 multilingual strings',()=>{const enc=new TextEncoder();const u8=enc.encode('攻撃報酬😀\\0');const u16text='所持金😀';const u16=[];for(const ch of u16text){const cp=ch.codePointAt(0);if(cp>0xffff){const x=cp-0x10000, hi=0xd800+(x>>10),lo=0xdc00+(x&1023);u16.push(hi&255,hi>>8,lo&255,lo>>8)}else u16.push(cp&255,cp>>8)}u16.push(0,0);const bytes=new Uint8Array(u8.length+3+u16.length);bytes.set(u8);bytes.set(u16,u8.length+3);const image={bytes,sections:[],offsetToAddress:o=>0x1000n+o};const rows=scanStrings(image,{minLength:3});ok(rows.some(x=>x.text==='攻撃報酬😀'));ok(rows.some(x=>x.text===u16text&&x.encoding==='utf16le'))});\nawait test('#399 invalid UTF-8 is not merged into valid text',()=>{const bytes=new Uint8Array([65,66,67,0xc0,0xaf,68,69,70,0]);const image={bytes,sections:[],offsetToAddress:o=>o};const rows=scanStrings(image,{minLength:3,utf16:false});ok(rows.some(x=>x.text==='ABC'));ok(rows.some(x=>x.text==='DEF'));ok(!rows.some(x=>x.text.includes('�')))});\nawait test('#387 source-backed and resident fingerprint digests agree',async()=>{const bytes=new Uint8Array([1,2,3,4,5,6,7,8]);const base={sections:[{fileOffset:0n,fileSize:8n,address:0x1000n,perms:{execute:true}}],segments:[],readVirtual:(a,n)=>bytes.subarray(Number(a-0x1000n),Number(a-0x1000n)+n),readVirtualAsync:async(a,n)=>bytes.subarray(Number(a-0x1000n),Number(a-0x1000n)+n),bytes};const source={...base,bytes:null,source:{readExactly:async(off,n)=>bytes.subarray(Number(off),Number(off)+Number(n))}};const a=await binaryFingerprintFunction(base,{address:0x1000n,size:8n}),b=await binaryFingerprintFunction(source,{address:0x1000n,size:8n});eq(a.hash,b.hash);const ia=await fingerprintImage(base),ib=await fingerprintImage(source);eq(ia.hash,ib.hash)});\nawait test('#395 truncated memory candidate set cannot auto-accept',async()=>{const db=new KnowledgeDB({memory:new Map(),negativeMemory:new Map(),maxCandidates:50});const fp={name:'tiny',architecture:'arm64',size:4,instructions:['ret'],semantic:{}};for(let i=0;i<60;i++)await db.remember({id:'r'+i,fingerprint:fp,name:i===59?'other':'same',confidence:1,userConfirmed:true});const r=await db.reidentify(fp,{limit:5});eq(r.matched,false);eq(r.truncated,true);eq(r.ambiguous,true)});\nif(fail.length){console.error('\\n'+fail.length+' failure(s)');process.exit(1)}console.log('\\nissues 350-399 regression: '+passed+' passed');\n`);

// Ensure the focused non-browser suite is always exercised by npm test/check.
edit('package.json', s => once(s,
`"test": "node tests/issues-97-100-146-147.mjs`,
`"test": "node tests/issues-350-399.mjs && node tests/issues-97-100-146-147.mjs`, '#350-399 test gate'));
