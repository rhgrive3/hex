import fs from 'node:fs';

function read(p){return fs.readFileSync(p,'utf8');}
function write(p,s){fs.writeFileSync(p,s);}
function once(s,a,b,label){const i=s.indexOf(a);if(i<0)throw new Error(`missing ${label}`);if(s.indexOf(a,i+a.length)>=0)throw new Error(`ambiguous ${label}`);return s.slice(0,i)+b+s.slice(i+a.length);}
function rx(s,re,b,label){const m=s.match(re);if(!m)throw new Error(`missing ${label}`);return s.replace(re,b);}
function edit(p,fn){const a=read(p),b=fn(a);if(a===b)throw new Error(`no change ${p}`);write(p,b);}

// #393: ambiguity is sticky across later type evidence.
edit('js/decompiler/type-recovery.js',s=>once(s,
`export function mergeRecoveredTypes(a, b) {
  if (!a || a.name === 'unknown') return b || a;
  if (!b || b.name === 'unknown') return a;
  if (a.name === b.name) return { ...a, confidence: Math.max(a.confidence || 0, b.confidence || 0) };
  const ac = a.confidence || 0, bc = b.confidence || 0;
  if (Math.abs(ac - bc) < 0.12) {
    return { name:'unknown', kind:'ambiguous', confidence:Math.max(ac, bc) * 0.7, candidates:[a, b], warning:\`conflicting type evidence: \${a.name} vs \${b.name}\` };
  }
  return ac > bc ? a : b;
}`,
`export function mergeRecoveredTypes(a, b) {
  const flatten = (t) => {
    if (!t) return [];
    const list = Array.isArray(t.candidates) && t.candidates.length ? t.candidates : [t];
    return list.flatMap((x) => x && Array.isArray(x.candidates) && x.candidates.length ? x.candidates : [x]).filter(Boolean);
  };
  const byName = new Map();
  for (const candidate of [...flatten(a), ...flatten(b)]) {
    if (!candidate || (candidate.name === 'unknown' && candidate.kind !== 'ambiguous')) continue;
    const key = candidate.name || candidate.kind || 'unknown';
    const prev = byName.get(key);
    if (!prev || (candidate.confidence || 0) > (prev.confidence || 0)) byName.set(key,candidate);
  }
  if (!byName.size) return b || a;
  const all = [...byName.values()].sort((x,y)=>(y.confidence||0)-(x.confidence||0));
  if (all.length === 1) return { ...all[0], candidates:all };
  const top=all[0], second=all[1], ac=top.confidence||0, bc=second.confidence||0;
  if (Math.abs(ac-bc) < 0.12) return { name:'unknown',kind:'ambiguous',confidence:Math.max(ac,bc)*0.7,candidates:all,warning:'conflicting type evidence: '+all.map((x)=>x.name).join(' vs ') };
  return { ...top, candidates:all };
}`,'#393 mergeRecoveredTypes'));

// #394: only exact/high-confidence provenance may hard-suppress application code.
edit('js/recognition/classifier.js',s=>{
  s=once(s,
`  if (context.signature?.classification && FUNCTION_CLASSES.includes(context.signature.classification)) {
    return { classification: context.signature.classification, confidence: context.signature.confidence ?? 0.95, evidence: ['signature:' + (context.signature.library || context.signature.name || 'known')] };
  }
  const name = fp.name || '';`,
`  const signature = context.signature?.classification && FUNCTION_CLASSES.includes(context.signature.classification) ? context.signature : null;
  const signatureConfidence = Number(signature?.confidence ?? 0);
  const signatureExact = signature?.exact === true || ['exact','normalized-identical'].includes(signature?.identity);
  if (signature && signatureExact && signatureConfidence >= 0.9) {
    return { classification:signature.classification, confidence:signatureConfidence, evidence:['signature:'+(signature.library||signature.name||'known')], hardSuppress:true };
  }
  const name = fp.name || '';
  if (signature) evidence.push('signature-hint:' + (signature.library || signature.name || signature.classification));`,'#394 signature gate');
  s=once(s,
`  if (context.owningLibrary && isAppleSystemLibrary(context.owningLibrary)) return { classification:'SYSTEM', confidence:0.92, evidence:['system-library:' + context.owningLibrary] };
  if (GENERATED.some((rx) => rx.test(name))) return { classification: 'GENERATED', confidence: 0.9, evidence: ['compiler-generated-name'] };
  if (RUNTIME_NAMES.some((rx) => rx.test(name))) return { classification:'RUNTIME', confidence:0.88, evidence:['runtime-symbol-name'] };`,
`  if (context.owningLibrary && isAppleSystemLibrary(context.owningLibrary)) return { classification:'SYSTEM', confidence:0.92, evidence:['system-library:' + context.owningLibrary], hardSuppress:true };
  if (GENERATED.some((rx) => rx.test(name))) return { classification:'GENERATED', confidence:0.9, evidence:['compiler-generated-name'], hardSuppress:true };
  if (RUNTIME_NAMES.some((rx) => rx.test(name))) return { classification:'RUNTIME', confidence:0.88, evidence:['runtime-symbol-name'], hardSuppress:true };`,'#394 strong provenance');
  s=once(s,`    return { classification, confidence: context.vendor.confidence, evidence: context.vendor.evidence || [] };`,`    return { classification, confidence: context.vendor.confidence, evidence: context.vendor.evidence || [], hardSuppress:true };`,'#394 vendor provenance');
  s=once(s,
`  if (appScore >= 0.38) return { classification: 'APPLICATION', confidence: Math.min(0.95, 0.5 + appScore / 2), evidence };
  return { classification: 'UNKNOWN', confidence: 0.35, evidence };`,
`  if (appScore >= 0.38) return { classification:'APPLICATION', confidence:Math.min(0.95,0.5+appScore/2), evidence, hardSuppress:false };
  if (signature) return { classification:signature.classification, confidence:Math.min(0.79,Math.max(0.35,signatureConfidence)), evidence, hardSuppress:false };
  return { classification:'UNKNOWN', confidence:0.35, evidence, hardSuppress:false };`,'#394 soft signature');
  s=once(s,
`  const penalties = { SYSTEM:0.7, RUNTIME:0.7, SDK:0.65, LIBRARY:0.65, GENERATED:0.75 };
  score -= penalties[cls.classification] || 0;
  if (context.vendor?.confidence >= 0.8 && cls.classification !== 'APPLICATION') score -= 0.15;`,
`  const penalties = { SYSTEM:0.7, RUNTIME:0.7, SDK:0.65, LIBRARY:0.65, GENERATED:0.75 };
  const hard = cls.hardSuppress === true && cls.confidence >= 0.8;
  score -= hard ? (penalties[cls.classification] || 0) : (['SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED'].includes(cls.classification) ? 0.08 * Math.max(0,Math.min(1,cls.confidence || 0)) : 0);
  if (context.vendor?.confidence >= 0.8 && cls.classification !== 'APPLICATION') score -= 0.15;`,'#394 application scoring');
  s=once(s,`    const suppressed = ['SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED'].includes(cls.classification);`,`    const suppressed = ['SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED'].includes(cls.classification) && cls.hardSuppress === true && cls.confidence >= 0.8;`,'#394 clustering');
  return s;
});

// #389: launch/attach/resume and fallback trace share one operation, signal and deadline.
edit('js/runtime/index.js',s=>rx(s,/  async traceFunction\(functionAddress, options = \{\}\) \{[\s\S]*?\n  \}\n  async readRuntimeField/,
`  async traceFunction(functionAddress, options = {}) {
    const session = this.currentSession();
    const adapter = session.adapter;
    const requestedAddress = asAddress(functionAddress);
    const launchSpec = launchOptionsForTrace(requestedAddress,options);
    const operation = operationController(session,options.signal);
    let observation = { stop:null, returnValue:null, branches:[] }, trace;
    const started = Date.now();
    try {
      if (adapter.capabilities.launch) {
        await adapter.launch(launchSpec,{signal:operation.signal});
      } else if (adapter.capabilities.attach && options.attach) {
        await adapter.attach(options.attach,{signal:operation.signal});
      } else if (!adapter.capabilities.attach && !adapter.capabilities.traceFunction) {
        throw new DebugAdapterError('unsupported','adapter cannot launch, attach, or trace an existing target');
      }
      if (adapter.capabilities.resume) {
        observation = await adapter.resume({ maxSteps:options.maxSteps ?? 20000, timeoutMs:options.timeoutMs, signal:operation.signal }) || observation;
      }
      if (observation.trace) trace = observation.trace;
      else {
        if (!adapter.capabilities.traceFunction) throw new DebugAdapterError('unsupported','adapter does not provide function tracing');
        const timeoutMs = options.timeoutMs == null ? undefined : Math.max(1, Number(options.timeoutMs) - (Date.now() - started));
        trace = await adapter.trace({ limit:boundedInteger(options.limit,4096,1,50000,'limit'), timeoutMs, signal:operation.signal });
      }
    } finally { operation.release(); }
    for (const event of trace.events || []) session.acceptEvent(event);
    const facts = traceToSemanticFacts(trace,{sessionId:session.id,binaryHash:session.binaryHash,traceId:\`fn:\${requestedAddress.toString(16)}\`});
    const replayable=isReplayable(adapter,observation,trace);
    const evidence = createRuntimeEvidenceRecord({ backend:session.backend,binaryHash:session.binaryHash,sessionId:session.id,
      experimentId:\`trace:\${requestedAddress.toString(16)}\`,caseId:'trace',function:requestedAddress,
      input:launchSpec,observedState:{stop:observation.stop,returnValue:observation.returnValue},branchPath:observation.branches || [],
      verdict:'inconclusive',confidence:0.5,kind:'trace',reproducibility:{replayable,runs:1,consistent:null} });
    this._recordEvidence(evidence);
    return { functionAddress:requestedAddress, observation, trace, facts, evidence:[evidence] };
  }
  async readRuntimeField`,'#389 traceFunction'));

// #364-#378/#382: preserve latest main memory/heap hardening while fixing ARM64/FP/libc semantics.
edit('js/emu.js',s=>{
  s=once(s,`    this.v = new Array(32).fill(0n);`,`    this.v = new Array(32).fill(0);\n    this.exclusive = null;`,'#368 fp reset/#364 monitor');
  s=once(s,
`  async store(addr, size, value) {
    const n = normalizeMemorySize(size);
    const start = BigInt(addr);
    await this.ensure(start);`,
`  async store(addr, size, value) {
    const n = normalizeMemorySize(size);
    const start = BigInt(addr);
    if (this.exclusive) {
      const endExclusive = start + BigInt(n), monitorEnd = this.exclusive.addr + BigInt(this.exclusive.size);
      if (!(endExclusive <= this.exclusive.addr || monitorEnd <= start)) this.exclusive = null;
    }
    await this.ensure(start);`,'#364 interfering store');
  s=once(s,`      else if (mn === 'ubfiz' || mn === 'sbfiz') r = (src & mask) << lsb;`,`      else if (mn === 'ubfiz') r = (src & mask) << lsb;\n      else if (mn === 'sbfiz') r = BigInt.asUintN(wide ? 64 : 32, BigInt.asIntN(Number(lsb + width), (src & mask) << lsb));`,'#371 sbfiz');
  s=once(s,`      else { const n = bits / 8; for (let i = 0; i < n; i++) r |= ((v >> BigInt(i * 8)) & 0xffn) << BigInt((n - 1 - i) * 8); }`,
`      else {
        const n = bits / 8;
        const elementBytes = mn === 'rev16' ? 2 : mn === 'rev32' ? 4 : n;
        for (let base = 0; base < n; base += elementBytes) for (let i = 0; i < elementBytes; i++) r |= ((v >> BigInt((base + i) * 8)) & 0xffn) << BigInt((base + elementBytes - 1 - i) * 8);
      }`,'#370 rev width');
  s=once(s,
`    this.effectiveAddress(mem, true);
    return null;
  }

  async storeInsn(mn, ops) {`,
`    if (/^(ldxr|ldaxr)/.test(mn) && !pair) this.exclusive = { addr:BigInt(addr), size };
    this.effectiveAddress(mem, true);
    return null;
  }

  async storeInsn(mn, ops) {`,'#364 load exclusive');
  s=rx(s,/  async storeInsn\(mn, ops\) \{[\s\S]*?\n  \}\n\n  fget\(op\) \{/,
`  async storeInsn(mn, ops) {
    const mem = ops.find((o) => o.k === 'mem');
    if (!mem) throw new Error('書き込み先が分かりませんでした: ' + mn);
    const exclusive = /^(stxr|stlxr)/.test(mn);
    const first = exclusive ? 1 : 0;
    const addr = this.effectiveAddress(mem, false);
    const pair = /^(stp|stnp)/.test(mn);
    const size = storeSize(mn, ops[first]);
    if (exclusive) {
      const monitor = this.exclusive;
      const success = !!monitor && monitor.addr === BigInt(addr) && monitor.size === size;
      this.exclusive = null;
      if (success) {
        if (isFloatReg(ops[first])) await this.store(addr,size,floatToBits(this.fget(ops[first]),size));
        else await this.store(addr,size,this.get(ops[first].text));
      }
      this.set(ops[0].text, success ? 0n : 1n);
      this.effectiveAddress(mem,true);
      return null;
    }
    if (pair) {
      const each = isWide(ops[0]) ? 8 : 4;
      await this.store(addr,each,this.get(ops[0].text));
      await this.store(addr + BigInt(each),each,this.get(ops[1].text));
    } else if (isFloatReg(ops[first])) await this.store(addr,size,floatToBits(this.fget(ops[first]),size));
    else await this.store(addr,size,this.get(ops[first].text));
    this.effectiveAddress(mem,true);
    return null;
  }

  fget(op) {`,'#364 store exclusive');
  s=rx(s,/  fget\(op\) \{[\s\S]*?\n  \}\n\n  conditionalSelect\(mn, ops\) \{/,
`  fget(op) {
    if (!op || op.k !== 'reg') return 0;
    if (op.cls === 'gp' || op.cls === 'sp') {
      const bits = op.bits === 32 ? 32 : 64;
      return Number(BigInt.asIntN(bits,this.get(op.text)));
    }
    const value=this.v[op.num];
    return value === undefined ? 0 : value;
  }

  fset(op,value) {
    if (!op || op.k !== 'reg') return;
    if (op.cls === 'gp') { this.set(op.text,BigInt(Math.trunc(value))); return; }
    this.v[op.num] = op.bits === 32 || /^s\\d+$/i.test(op.text || '') ? Math.fround(value) : value;
  }

  floatInsn(mn,ops) {
    if (mn === 'fcmp' || mn === 'fcmpe') {
      const lhs=this.fget(ops[0]);
      const rhs=ops[1]?.k === 'imm' ? (ops[1].float != null ? Number(ops[1].float) : Number(ops[1].value ?? 0n)) : this.fget(ops[1]);
      if (Number.isNaN(lhs) || Number.isNaN(rhs)) this.nzcv={n:false,z:false,c:true,v:true};
      else if (lhs < rhs) this.nzcv={n:true,z:false,c:false,v:false};
      else if (lhs === rhs) this.nzcv={n:false,z:true,c:true,v:false};
      else this.nzcv={n:false,z:false,c:true,v:false};
      return null;
    }
    const a=this.fget(ops[1]), b=ops[2] ? this.fget(ops[2]) : 0;
    if (mn === 'fmov') { if (ops[1]?.k === 'imm') this.fset(ops[0],ops[1].float != null ? ops[1].float : Number(ops[1].value || 0n)); else this.fset(ops[0],a); return null; }
    if (mn === 'fadd') { this.fset(ops[0],a+b); return null; }
    if (mn === 'fsub') { this.fset(ops[0],a-b); return null; }
    if (mn === 'fmul') { this.fset(ops[0],a*b); return null; }
    if (mn === 'fdiv') { this.fset(ops[0],a/b); return null; }
    if (mn === 'fneg') { this.fset(ops[0],-a); return null; }
    if (mn === 'fabs') { this.fset(ops[0],Math.abs(a)); return null; }
    if (mn === 'fsqrt') { this.fset(ops[0],Math.sqrt(a)); return null; }
    if (mn === 'fmadd') { this.fset(ops[0],this.fget(ops[3])+a*b); return null; }
    if (mn === 'fmsub') { this.fset(ops[0],this.fget(ops[3])-a*b); return null; }
    if (mn === 'fcvt' || mn === 'fcvtd' || mn === 'fcvts') { this.fset(ops[0],a); return null; }
    if (/^(scvtf|ucvtf)$/.test(mn)) {
      const bits=ops[1]?.bits === 32 ? 32 : 64, raw=this.get(ops[1].text);
      this.fset(ops[0],Number(mn === 'scvtf' ? BigInt.asIntN(bits,raw) : BigInt.asUintN(bits,raw))); return null;
    }
    if (/^fcvtz[su]$/.test(mn)) {
      const bits=ops[0]?.bits === 32 || /^w/.test(ops[0]?.text || '') ? 32 : 64, unsigned=mn === 'fcvtzu'; let result=0n;
      if (!Number.isNaN(a)) {
        const t=Math.trunc(a);
        if (unsigned) { const max=(1n<<BigInt(bits))-1n; if (t<=0) result=0n; else if (!Number.isFinite(t)) result=max; else { const n=BigInt(t); result=n>max?max:n; } }
        else { const min=-(1n<<BigInt(bits-1)), max=(1n<<BigInt(bits-1))-1n; if (!Number.isFinite(t)) result=t<0?min:max; else { const n=BigInt(t); result=n<min?min:n>max?max:n; } }
      }
      this.set(ops[0].text,result); return null;
    }
    if (/^(fmin|fmax|fminnm|fmaxnm)$/.test(mn)) {
      let value;
      if (/nm$/.test(mn)) { if (Number.isNaN(a) && !Number.isNaN(b)) value=b; else if (!Number.isNaN(a) && Number.isNaN(b)) value=a; else value=/min/.test(mn)?Math.min(a,b):Math.max(a,b); }
      else value=/min/.test(mn)?Math.min(a,b):Math.max(a,b);
      this.fset(ops[0],value); return null;
    }
    throw new Error('この小数命令はまだ実行できません: ' + mn);
  }

  conditionalSelect(mn, ops) {`,'#365-#369/#376/#377 float semantics');
  s=rx(s,/  async hookedCall\(target\) \{[\s\S]*?\n    return false;\n  \}\n\n  registerList\(\) \{/,
`  async hookedCall(target) {
    const name=this.io.symbolFor ? this.io.symbolFor(target) : null;
    if (!name) return false;
    const plain=name.replace(/^_+/, '');
    const MAX_HOOK_BYTES=65536n;
    const allocate=async(size,zero=false)=>{
      this._syncHeapBase();
      if (size < 0n || size > HEAP_SIZE) throw new EmulatorFault('heap-exhausted','synthetic allocation exceeds 1 MiB',{size});
      const addr=this.heap, next=addr+((size+15n)&~15n);
      if (next > this.heapBase + HEAP_SIZE) throw new EmulatorFault('heap-exhausted','synthetic heap exceeded 1 MiB',{heapBase:this.heapBase,heap:next});
      this.heap=next; this.heapAllocations++;
      if (zero) for (let i=0n;i<size;i++) { await this.ensure(addr+i); this.writeByte(addr+i,0); }
      return addr;
    };
    if (/^(malloc|operator new|Znwm|Znam)$/.test(plain)) {
      const size=this.x[0] || 16n, addr=await allocate(size,false); this.x[0]=addr;
      this.log.push({call:plain,note:'メモリを '+size+' バイト確保したことにしました → 0x'+addr.toString(16)}); return true;
    }
    if (plain === 'calloc') {
      const count=this.x[0], each=this.x[1]; if (count !== 0n && each > MASK64/count) throw new EmulatorFault('allocation-overflow','calloc size overflow');
      const size=count*each, addr=await allocate(size,true); this.x[0]=addr; this.log.push({call:'calloc',note:size+' バイトをゼロ初期化して確保しました'}); return true;
    }
    if (/^(free|operator delete|ZdlPv|ZdaPv)$/.test(plain)) { this.log.push({call:plain,note:'解放は何もしません'}); return true; }
    if (plain === 'strlen') {
      const p=this.x[0]; let n=0n; while (n<4096n) { await this.ensure(p+n); if (this.byteAt(p+n)===0) { this.x[0]=n; this.log.push({call:'strlen',note:'長さ '+n+' を返しました'}); return true; } n++; }
      throw new EmulatorFault('unterminated-string','strlen: 4096 バイト以内に終端NULがありません',{address:p});
    }
    if (/^(memcpy|memmove)$/.test(plain)) {
      const d=this.x[0],src=this.x[1],n=this.x[2]; if (n>MAX_HOOK_BYTES) throw new EmulatorFault('hook-copy-too-large',plain+': コピー長が安全上限65536バイトを超えました',{size:n});
      const snapshot=plain==='memmove'?new Uint8Array(Number(n)):null;
      if (snapshot) for(let i=0;i<snapshot.length;i++){await this.ensure(src+BigInt(i));snapshot[i]=this.byteAt(src+BigInt(i));}
      for(let i=0n;i<n;i++){await this.ensure(src+i);await this.ensure(d+i);this.writeByte(d+i,snapshot?snapshot[Number(i)]:this.byteAt(src+i));}
      this.x[0]=d; this.log.push({call:plain,note:n+' バイトをコピーしました'}); return true;
    }
    if (/^(memset|bzero)$/.test(plain)) {
      const d=this.x[0],c=plain==='bzero'?0n:this.x[1],n=plain==='bzero'?this.x[1]:this.x[2]; if(n>MAX_HOOK_BYTES) throw new EmulatorFault('hook-write-too-large',plain+': 書込長が安全上限65536バイトを超えました',{size:n});
      for(let i=0n;i<n;i++){await this.ensure(d+i);this.writeByte(d+i,Number(c&0xffn));} this.x[0]=d; this.log.push({call:plain,note:n+' バイトを埋めました'}); return true;
    }
    if (/^(arc4random|rand|random)$/.test(plain)) { this.x[0]=4n; this.log.push({call:plain,note:'乱数は毎回 4 を返します（結果を比べられるように）'}); return true; }
    if (plain === 'objc_storeStrong') { await this.store(this.x[0],8,this.x[1]); this.log.push({call:plain,note:'strong参照先へ新しいobject pointerを書き込みました'}); return true; }
    if (/^objc_(retain|release|autorelease|retainAutoreleasedReturnValue)$/.test(plain)) { this.log.push({call:plain,note:'参照カウントの操作は素通りします'}); return true; }
    return false;
  }

  registerList() {`,'#372-#375/#378/#382 hooks');
  return s;
});
