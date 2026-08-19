import { ABIPlugin } from './registry.js';

function callPrototypeOf(insn, opts) {
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

function scalableAAPCS64Class(type, cls) {
  const text = `${type} ${cls}`;
  const predicate = /\bsvbool_t\b|\bpredicate\b|\bsve[-_ ]?predicate\b/.test(text);
  const scalable = predicate || /\bscalable[-_ ]?(?:vector|type)\b|\bsve\b|\bsv(?:u?int|float|bfloat)[0-9_]*_t\b/.test(text);
  if (!scalable) return null;
  return predicate ? 'sve-predicate' : 'sve-scalable-vector';
}

function parameterAbiClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const scalableClass = scalableAAPCS64Class(type, cls);
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(type + ' ' + cls);
  const hfa = param?.hfa === true || cls.includes('hfa') || cls.includes('homogeneous');
  const vector = !scalableClass && (cls.includes('vector') || /vector|simd/.test(type));
  const fp = !scalableClass && (hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type));
  const members = Math.max(1, Math.min(4, Number(param?.members || param?.elements || param?.count || 1) || 1));
  const bits = Math.max(8, Math.min(128, Number(param?.bits || param?.sizeBits || 64) || 64));
  return { pointer, hfa, vector, fp, members, bits, scalableClass };
}

export function classifyAAPCS64Arguments(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const params = callParameterList(proto);
  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  const unsupported = [];
  let gp = 0, fp = 0, stackOffset = 0;
  let stackArgsMayContainPointers = false;
  if (!params) {
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`x${i}`,bits:64}); arguments_.push({index:i,location:'register',reg:`x${i}`,abiClass:'unknown-gp'}); }
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`v${i}`,bits:128}); arguments_.push({index:8+i,location:'register',reg:`v${i}`,abiClass:'unknown-fp-vector'}); }
    return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:false, evidence:'conservative-aapcs64' };
  }
  params.forEach((param,index) => {
    const c=parameterAbiClass(param);
    if (c.scalableClass) {
      const entry={index,location:'unsupported',abiClass:c.scalableClass,pointer:false,scalable:true,evidence:'unsupported-aapcs64-sve'};
      arguments_.push(entry);unsupported.push(entry);return;
    }
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
  return {
    srcs, arguments:arguments_, stackArguments,
    stackArgsUnknown:proto?.variadic===true||proto?.varargs===true,
    stackArgsMayContainPointers,
    evidence:unsupported.length?'partial-aapcs64-unsupported-sve':'prototype-aapcs64',
    unsupported:unsupported.length>0,
    unsupportedArguments:unsupported,
  };
}

function scalableReturnClass(proto, type, cls) {
  return scalableAAPCS64Class(type, cls) || scalableAAPCS64Class(type, String(proto?.returnKind || proto?.resultKind || '').toLowerCase());
}

export function classifyAAPCS64CallReturn(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  if (proto.indirectResult === true || cls === 'indirect') return null;
  if (scalableReturnClass(proto,type,cls)) return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  }
  if (type || cls || proto.returnsValue === true) return { reg:'x0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  return null;
}

export function classifyAAPCS64FunctionReturn(opts = {}) {
  const proto = opts?.functionPrototype || opts?.prototype || null;
  const type = String(opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (opts?.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  if (proto?.indirectResult === true || cls === 'indirect') return null;
  if (scalableReturnClass(proto,type,cls)) return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto?.returnBits || proto?.bits || opts?.returnBits || 64) || 64 };
  }
  if (type || cls || opts?.returnsValue === true || proto?.returnsValue === true) {
    return { reg:'x0', bits:Number(proto?.returnBits || proto?.bits || opts?.returnBits || 64) || 64 };
  }
  return null;
}

const CALLER_SAVED_BASE = Object.freeze(['x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x30','nzcv',
  ...Array.from({length:8},(_x,i)=>`v${i}`), ...Array.from({length:16},(_x,i)=>`v${i+16}`)]);
const CALLER_SAVED_WITH_X18 = Object.freeze(['x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x18','x30','nzcv',
  ...Array.from({length:8},(_x,i)=>`v${i}`), ...Array.from({length:16},(_x,i)=>`v${i+16}`)]);
const CALLEE_SAVED = Object.freeze(['x19','x20','x21','x22','x23','x24','x25','x26','x27','x28','x29', ...Array.from({length:8},(_x,i)=>`v${i+8}`)]);
const APPLE_X18_RESERVED = new Set(['apple','darwin','macos','macosx','ios','ipados','tvos','watchos','visionos','maccatalyst','ios-simulator','tvos-simulator','watchos-simulator','visionos-simulator']);

function platformFromContext(context = {}) {
  return String(context?.platform || context?.image?.platform || context?.target?.platform || context?.binary?.platform || 'unknown').trim().toLowerCase();
}

function callerSavedFor(context = {}) {
  return APPLE_X18_RESERVED.has(platformFromContext(context)) ? CALLER_SAVED_BASE : CALLER_SAVED_WITH_X18;
}

export const AAPCS64_ABI = new ABIPlugin({
  id:'aapcs64', semanticVersion:'2', architectureId:'arm64',
  platformPredicate:({ platform }) => !platform || platform === 'darwin' || platform === 'apple' || platform === 'macos' || platform === 'ios' || platform === 'ipados' || platform === 'linux' || platform === 'android' || platform === 'unknown',
  callingConventions:()=>Object.freeze(['aapcs64']),
  classifyArguments:classifyAAPCS64Arguments,
  classifyCallReturn:classifyAAPCS64CallReturn,
  classifyFunctionReturn:classifyAAPCS64FunctionReturn,
  classifyEntryRegister:(reg) => /^x[0-7]$/.test(String(reg || '')) ? { kind:'argument', reg:String(reg), index:Number(String(reg).slice(1)) } : { kind:'incoming-register-state', reg:String(reg || '') },
  callerSaved:(context)=>callerSavedFor(context),
  calleeSaved:()=>CALLEE_SAVED,
  stackRules:()=>Object.freeze({ alignment:16, stackGrows:'down', argumentSlotBytes:8 }),
  redZone:()=>0,
  unwindRules:()=>Object.freeze({ framePointer:'x29', linkRegister:'x30' }),
  defaultUnknownCallEffects:(context)=>Object.freeze({ registerClobbers:callerSavedFor(context), memoryEffects:'unknown', mayThrow:true }),
});
