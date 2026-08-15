from pathlib import Path

# #526 AAPCS64 call argument coverage + conservative stack escape metadata.
p=Path('js/ir-core.js'); s=p.read_text()
anchor='function callResultLocation(insn, opts) {'
helper=r'''function callPrototypeOf(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn?.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  return proto;
}

function callParameterList(proto) {
  const list = proto && (proto.args || proto.parameters || proto.params || proto.arguments);
  return Array.isArray(list) ? list : null;
}

function parameterAbiClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(type + ' ' + cls);
  const hfa = param?.hfa === true || cls.includes('hfa') || cls.includes('homogeneous');
  const vector = cls.includes('vector') || /vector|simd/.test(type);
  const fp = hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type);
  const members = Math.max(1, Math.min(4, Number(param?.members || param?.elements || param?.count || 1) || 1));
  const bits = Math.max(8, Math.min(128, Number(param?.bits || param?.sizeBits || (fp ? 64 : 64)) || 64));
  return { pointer, hfa, vector, fp, members, bits };
}

/** AAPCS64-visible call inputs. Unknown prototypes deliberately include both
 * GP and SIMD argument banks and mark stack arguments as unknown instead of
 * pretending x0-x7 is a complete ABI description. */
export function classifyCallArguments(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const params = callParameterList(proto);
  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  let gp = 0, fp = 0, stackOffset = 0;
  let stackArgsMayContainPointers = false;
  if (!params) {
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`x${i}`,bits:64}); arguments_.push({index:i,location:'register',reg:`x${i}`,abiClass:'unknown-gp'}); }
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`v${i}`,bits:128}); arguments_.push({index:8+i,location:'register',reg:`v${i}`,abiClass:'unknown-fp-vector'}); }
    return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:true, evidence:'conservative-aapcs64' };
  }
  params.forEach((param,index) => {
    const c=parameterAbiClass(param);
    const regsNeeded=c.hfa ? c.members : 1;
    if (c.fp && fp + regsNeeded <= 8) {
      const regs=[];
      for(let n=0;n<regsNeeded;n++){const reg=`v${fp++}`;regs.push(reg);srcs.push({t:'reg',reg,bits:c.vector?128:c.bits});}
      arguments_.push({index,location:'register',regs,reg:regs[0],abiClass:c.hfa?'hfa':c.vector?'vector':'fp',pointer:c.pointer,bits:c.bits});
      return;
    }
    if (!c.fp && gp < 8) {
      const reg=`x${gp++}`; srcs.push({t:'reg',reg,bits:64});
      arguments_.push({index,location:'register',reg,abiClass:c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits});
      return;
    }
    const slots=Math.max(1,Math.ceil((c.hfa?c.members*c.bits:c.bits)/64));
    const entry={index,location:'stack',offset:stackOffset,bytes:slots*8,abiClass:c.hfa?'hfa':c.vector?'vector':c.fp?'fp':c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits};
    stackArguments.push(entry);arguments_.push(entry);stackOffset+=slots*8;
    if(c.pointer || param?.mayContainPointers === true || param?.containsPointers === true) stackArgsMayContainPointers=true;
  });
  if (proto?.variadic === true || proto?.varargs === true) stackArgsMayContainPointers=true;
  return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:proto?.variadic===true||proto?.varargs===true, stackArgsMayContainPointers, evidence:'prototype-aapcs64' };
}

'''
if helper not in s:
    if anchor not in s: raise SystemExit('callResultLocation anchor missing')
    s=s.replace(anchor,helper+anchor,1)
# Deduplicate call prototype lookup inside result helper.
old="""  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn.callTarget ?? null, insn) || null; } catch { proto = null; }
  }"""
s=s.replace(old,"  const proto = callPrototypeOf(insn, opts);",1)
old="""    const result = callResultLocation(insn, opts);
    const callSrcs = Array.from({ length: 8 }, (_, i) => ({ t: 'reg', reg: `x${i}`, bits: 64 }));
    if (insn.callTarget == null && ops[0] && ops[0].k === 'reg') {
      const targetReg = regKeyOf(ops[0]);
      if (targetReg && !callSrcs.some((src) => src.reg === targetReg)) callSrcs.push({ t: 'reg', reg: targetReg, bits: 64 });
    }
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: callSrcs,
      dstReg: result?.reg || null, dstBits: result?.bits || 64,
      returnEvidence: result ? 'prototype' : null,
      clobbers: CALL_CLOBBERS,
    });"""
new="""    const result = callResultLocation(insn, opts);
    const callArgs = classifyCallArguments(insn, opts);
    const callSrcs = callArgs.srcs.slice();
    if (insn.callTarget == null && ops[0] && ops[0].k === 'reg') {
      const targetReg = regKeyOf(ops[0]);
      if (targetReg && !callSrcs.some((src) => src.reg === targetReg)) callSrcs.push({ t: 'reg', reg: targetReg, bits: 64 });
    }
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: callSrcs,
      callArguments: callArgs.arguments,
      stackArguments: callArgs.stackArguments,
      stackArgsUnknown: callArgs.stackArgsUnknown,
      stackArgsMayContainPointers: callArgs.stackArgsMayContainPointers,
      argumentEvidence: callArgs.evidence,
      dstReg: result?.reg || null, dstBits: result?.bits || 64,
      returnEvidence: result ? 'prototype' : null,
      clobbers: CALL_CLOBBERS,
    });"""
if old not in s: raise SystemExit('CALL lift anchor missing')
s=s.replace(old,new,1)
# Preserve call escape metadata on emitted instruction instead of hiding only in extra.
old="""      args: [], dst: null, extra: p,
    };"""
new="""      args: [], dst: null, extra: p,
      stackArguments: p.stackArguments || null,
      stackArgsUnknown: !!p.stackArgsUnknown,
      stackArgsMayContainPointers: !!p.stackArgsMayContainPointers,
      argumentEvidence: p.argumentEvidence || null,
    };"""
if old not in s: raise SystemExit('emit metadata anchor missing')
s=s.replace(old,new,1)
old="""    if ((inst.args || []).some((a) => stackPointerProvenanceOf(a?.value, stackPointerMemo))) {
      stackEscaped = true;
      break;
    }"""
new="""    if (inst.stackArgsUnknown || inst.stackArgsMayContainPointers ||
        (inst.args || []).some((a) => stackPointerProvenanceOf(a?.value, stackPointerMemo))) {
      stackEscaped = true;
      break;
    }"""
if old not in s: raise SystemExit('stack escape anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# #537 recursive bounded backward Memory-SSA traversal.
p=Path('js/slice.js'); s=p.read_text()
anchor='export function backwardSlice(ir, seed, opts) {'
helper=r'''export function memoryOrigins(node, opts = {}) {
  const maxNodes=Math.max(1,Math.min(10000,Number(opts.maxNodes)||1024));
  const maxEdges=Math.max(1,Math.min(20000,Number(opts.maxEdges)||2048));
  const seen=new Set(), stack=node?[node]:[], stores=[], clobbers=[];
  let edges=0,truncated=false,phiCount=0;
  while(stack.length){
    if(seen.size>=maxNodes||edges>=maxEdges){truncated=true;break;}
    const cur=stack.pop(); if(!cur||seen.has(cur))continue; seen.add(cur);
    if(cur.kind==='store'){if(cur.inst)stores.push(cur.inst);continue;}
    if(cur.kind==='clobber'||cur.kind==='unknown'){if(cur.inst)clobbers.push(cur.inst);continue;}
    if(cur.kind==='phi'){
      phiCount++;
      for(const inc of cur.incoming||[]){edges++;if(edges>maxEdges){truncated=true;break;}if(inc?.node&&!seen.has(inc.node))stack.push(inc.node);}
    }
  }
  const alternatives=stores.length+clobbers.length;
  return {stores,clobbers,truncated,nodes:seen.size,edges,branchDependent:phiCount>0&&alternatives>1,ambiguous:alternatives>1,alternatives};
}

'''
if helper not in s: s=s.replace(anchor,helper+anchor,1)
s=s.replace("  let truncated = false;\n", "  let truncated = false;\n  const memoryAlternatives = [];\n  let memoryTraversalTruncated = false;\n",1)
old="""    if (throughMemory && inst.op === OP.LOAD && inst.reachingStore) pushInst(inst.reachingStore);
    if (throughMemory && inst.op === OP.LOAD && inst.memUse && inst.memUse.kind === 'phi') {
      for (const inc of inst.memUse.incoming || []) if (inc.node && inc.node.kind === 'store') pushInst(inc.node.inst);
    }"""
new="""    if (throughMemory && inst.op === OP.LOAD && inst.memUse) {
      const origins=memoryOrigins(inst.memUse,{maxNodes:o.memoryNodeLimit,maxEdges:o.memoryEdgeLimit});
      for(const origin of origins.stores) pushInst(origin);
      for(const clobber of origins.clobbers) pushInst(clobber);
      if(origins.ambiguous||origins.truncated) memoryAlternatives.push({loadId:inst.id,row:inst.row,...origins});
      if(origins.truncated) memoryTraversalTruncated=true;
    } else if (throughMemory && inst.op === OP.LOAD && inst.reachingStore) pushInst(inst.reachingStore);"""
if old not in s: raise SystemExit('backward memory anchor missing')
s=s.replace(old,new,1)
old="  return { instructions, values, truncated, seed };"
new="  return { instructions, values, truncated:truncated||memoryTraversalTruncated, seed, memoryAlternatives, memoryAmbiguous:memoryAlternatives.some((x)=>x.ambiguous), memoryTraversalTruncated };"
if old not in s: raise SystemExit('backward return anchor missing')
s=s.replace(old,new,1)
# propagate ambiguity metadata to value/causal chains
old="  return { steps, truncated: slice.truncated, source: steps.length ? steps[0] : null, sink: steps.length ? steps[steps.length - 1] : null };"
new="  return { steps, truncated: slice.truncated, memoryAmbiguous:!!slice.memoryAmbiguous, memoryAlternatives:slice.memoryAlternatives||[], source: steps.length ? steps[0] : null, sink: steps.length ? steps[steps.length - 1] : null };"
s=s.replace(old,new,1)
s=s.replace("if (steps.length <= limit) return { steps, elided: 0, truncated: chain.truncated };","if (steps.length <= limit) return { steps, elided: 0, truncated: chain.truncated, memoryAmbiguous:chain.memoryAmbiguous, memoryAlternatives:chain.memoryAlternatives };",1)
s=s.replace("return { steps: [first, ...middle, last], elided: steps.length - (middle.length + 2), truncated: chain.truncated };","return { steps: [first, ...middle, last], elided: steps.length - (middle.length + 2), truncated: chain.truncated, memoryAmbiguous:chain.memoryAmbiguous, memoryAlternatives:chain.memoryAlternatives };",1)
p.write_text(s)

# #538/#539 cache scope and function-local return evidence.
p=Path('js/interproc.js'); s=p.read_text()
insert=r'''
function cacheScopeOf(context) {
  const generation=context?.analysisGeneration ?? context?.generation ?? context?.epoch ?? '';
  const session=context?.sessionId ?? context?.binaryHash ?? context?.binaryIdentity ?? '';
  return String(session)+'@'+String(generation);
}
function hasContextSensitiveSummaryInputs(context, opts) {
  return opts?.returnEvidence != null || opts?.returnsValue != null || opts?.ir != null ||
    opts?.functionPrototype != null || opts?.prototype != null || typeof context?.returnEvidenceFor === 'function';
}
function calleeOptions(opts, depth) {
  const next={...(opts||{}),depth};
  // All function-local evidence must be re-resolved for the callee identity.
  delete next.returnEvidence; delete next.returnsValue; delete next.ir;
  delete next.functionPrototype; delete next.prototype; delete next.returnType; delete next.returnClass;
  return next;
}
'''
anchor='export class FunctionSummaryCache {'
if insert not in s: s=s.replace(anchor,insert+'\n'+anchor,1)
old="""    const key = address.toString();
    if (this.cache.has(key)) {
      const hit = this.cache.get(key);
      this._touch(key, hit);
      return hit;
    }
    if (this.active.has(key)) return { address, cycle: true, engine: 'semantic-ir', reads: [], writes: [], returns: [], calls: [], effects: {}, argumentRoles: [], classification: {} };"""
new="""    const addressKey = address.toString();
    const cacheable = !hasContextSensitiveSummaryInputs(this.context, opts);
    const key = cacheScopeOf(this.context) + ':' + addressKey;
    if (cacheable && this.cache.has(key)) {
      const hit = this.cache.get(key);
      this._touch(key, hit);
      return hit;
    }
    if (this.active.has(addressKey)) return { address, cycle: true, engine: 'semantic-ir', reads: [], writes: [], returns: [], calls: [], effects: {}, argumentRoles: [], classification: {} };"""
if old not in s: raise SystemExit('interproc cache lookup anchor missing')
s=s.replace(old,new,1)
s=s.replace('    this.active.add(key);','    this.active.add(addressKey);',1)
old="const callee = await this.summaryFor(target, { ...(opts || {}), depth: depth + 1 });"
new="const callee = await this.summaryFor(target, calleeOptions(opts, depth + 1));"
if old not in s: raise SystemExit('callee recurse anchor missing')
s=s.replace(old,new,1)
s=s.replace('      this._touch(key, summary);','      if (cacheable) this._touch(key, summary);',1)
s=s.replace('      this.active.delete(key);','      this.active.delete(addressKey);',1)
p.write_text(s)
