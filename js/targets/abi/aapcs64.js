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

function canonicalPlatform(context = {}) {
  const raw = context?.platform ?? context?.target?.platform ?? context?.image?.platform ?? context?.binaryImage?.platform ?? null;
  return String(raw ?? '').trim().toLowerCase();
}

export function aapcs64X18Policy(context = {}) {
  const platform = canonicalPlatform(context);
  if (platform === 'darwin' || platform === 'macos' || platform === 'ios' || platform === 'tvos'
      || platform === 'watchos' || platform === 'visionos' || platform === 'android') {
    return Object.freeze({ platform: platform || 'unknown', role:'platform-reserved', callerSaved:false, evidence:'platform-abi-x18-reserved' });
  }
  return Object.freeze({ platform: platform || 'unknown', role:'caller-saved', callerSaved:true,
    evidence: platform ? 'platform-abi-x18-temporary' : 'unknown-platform-conservative-x18-clobber' });
}

function scalableAbiClass(param) {
  const type = String(param?.type || param?.name || '').trim().toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').trim().toLowerCase();
  const predicate = param?.scalablePredicate === true || param?.predicate === true
    || cls.includes('scalable-predicate') || cls.includes('sve-predicate') || /(^|\W)svbool_t($|\W)/.test(type);
  const scalable = predicate || param?.scalable === true || param?.scalableVector === true
    || param?.vectorLengthAgnostic === true || cls.includes('scalable') || cls.includes('vector-length-agnostic')
    || cls.includes('sve') || /(^|\W)sv[a-z0-9_]*_t($|\W)/.test(type);
  if (predicate) return 'scalable-predicate';
  if (scalable) return 'scalable-vector';
  return null;
}

function parameterAbiClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const scalable = scalableAbiClass(param);
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(type + ' ' + cls);
  const hfa = param?.hfa === true || cls.includes('hfa') || cls.includes('homogeneous');
  const vector = cls.includes('vector') || /vector|simd/.test(type);
  const fp = hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type);
  const members = Math.max(1, Math.min(4, Number(param?.members || param?.elements || param?.count || 1) || 1));
  const bits = Math.max(8, Math.min(128, Number(param?.bits || param?.sizeBits || 64) || 64));
  return { pointer, hfa, vector, fp, members, bits, scalable };
}

function unsupportedScalableInterface(params, classes) {
  return {
    srcs: [],
    arguments: params.map((param, index) => ({
      index,
      location:'unknown',
      abiClass: classes[index]?.scalable || 'unknown-due-to-scalable-interface',
      pointer: classes[index]?.pointer === true,
      unsupported:true,
    })),
    stackArguments: [],
    stackArgsUnknown: true,
    stackArgsMayContainPointers: true,
    evidence:'unsupported-aapcs64-scalable-interface',
    interfaceKind:'scalable',
    unsupported:true,
    partial:true,
    unsupportedReason:'aapcs64-sve-pcs-not-modeled',
  };
}

function returnAbiClass(proto, opts = {}) {
  const param = {
    type: opts?.returnType ?? proto?.returnType ?? proto?.ret ?? proto?.result ?? '',
    abiClass: opts?.returnClass ?? proto?.returnClass ?? proto?.abiClass ?? proto?.resultClass ?? '',
    scalable: opts?.scalable === true || proto?.scalable === true,
    scalableVector: opts?.scalableVector === true || proto?.scalableVector === true,
    scalablePredicate: opts?.scalablePredicate === true || proto?.scalablePredicate === true,
    vectorLengthAgnostic: opts?.vectorLengthAgnostic === true || proto?.vectorLengthAgnostic === true,
  };
  return scalableAbiClass(param);
}

function unsupportedScalableReturn(abiClass) {
  return Object.freeze({
    reg:null, bits:null, abiClass, interfaceKind:'scalable', unsupported:true, partial:true,
    evidence:'unsupported-aapcs64-scalable-interface', reason:'aapcs64-sve-pcs-not-modeled',
  });
}

export function classifyAAPCS64Arguments(insn, opts = {}) {
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
    return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:false, evidence:'conservative-aapcs64' };
  }
  const classes = params.map(parameterAbiClass);
  if (classes.some((item) => item.scalable)) return unsupportedScalableInterface(params, classes);
  params.forEach((param,index) => {
    const c=classes[index];
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
  return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:proto?.variadic===true||proto?.varargs===true, stackArgsMayContainPointers, evidence:'prototype-aapcs64', interfaceKind:'base' };
}

export function classifyAAPCS64CallReturn(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  if (proto.indirectResult === true || cls === 'indirect') return null;
  const scalable = returnAbiClass(proto);
  if (scalable) return unsupportedScalableReturn(scalable);
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
  const scalable = returnAbiClass(proto, opts);
  if (scalable) return unsupportedScalableReturn(scalable);
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
const SVE_STATE = Object.freeze([
  ...Array.from({length:32},(_x,i)=>`z${i}`), ...Array.from({length:16},(_x,i)=>`p${i}`), 'ffr',
]);

function scalableInterfaceFromContext(context = {}) {
  const insn = context?.insn || context?.callSite || context;
  const proto = callPrototypeOf(insn, context) || context?.functionPrototype || context?.prototype || null;
  const params = callParameterList(proto) || [];
  if (params.some((param) => scalableAbiClass(param))) return true;
  return !!returnAbiClass(proto, context);
}

function aapcs64CallerSaved(context = {}) {
  const base = aapcs64X18Policy(context).callerSaved ? CALLER_SAVED_WITH_X18 : CALLER_SAVED_BASE;
  if (!scalableInterfaceFromContext(context)) return base;
  return Object.freeze([...new Set([...base, ...SVE_STATE])]);
}

function aapcs64UnknownCallEffects(context = {}) {
  const scalable = scalableInterfaceFromContext(context);
  return Object.freeze({
    registerClobbers:aapcs64CallerSaved(context), memoryEffects:'unknown', mayThrow:true,
    ...(scalable ? {
      interfaceKind:'scalable', unsupported:true, partial:true,
      reason:'aapcs64-sve-pcs-not-modeled', evidence:'unsupported-aapcs64-scalable-interface',
    } : { interfaceKind:'base' }),
  });
}

export const AAPCS64_ABI = new ABIPlugin({
  id:'aapcs64', semanticVersion:'2', architectureId:'arm64',
  platformPredicate:({ platform }) => !platform || platform === 'darwin' || platform === 'linux' || platform === 'android' || platform === 'unknown',
  callingConventions:()=>Object.freeze(['aapcs64']),
  classifyArguments:classifyAAPCS64Arguments,
  classifyCallReturn:classifyAAPCS64CallReturn,
  classifyFunctionReturn:classifyAAPCS64FunctionReturn,
  classifyEntryRegister:(reg) => /^x[0-7]$/.test(String(reg || '')) ? { kind:'argument', reg:String(reg), index:Number(String(reg).slice(1)) } : { kind:'incoming-register-state', reg:String(reg || '') },
  callerSaved:aapcs64CallerSaved,
  calleeSaved:()=>CALLEE_SAVED,
  stackRules:()=>Object.freeze({ alignment:16, stackGrows:'down', argumentSlotBytes:8 }),
  redZone:()=>0,
  unwindRules:()=>Object.freeze({ framePointer:'x29', linkRegister:'x30' }),
  defaultUnknownCallEffects:aapcs64UnknownCallEffects,
});