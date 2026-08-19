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

function parameterAbiClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(type + ' ' + cls);
  const hfa = param?.hfa === true || cls.includes('hfa') || cls.includes('homogeneous');
  const vector = cls.includes('vector') || /vector|simd/.test(type);
  const aggregate = !pointer && !hfa && (param?.aggregate === true || param?.isAggregate === true || /aggregate|struct|union|record|array|composite/.test(type + ' ' + cls));
  const fp = !aggregate && (hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type));
  const members = Math.max(1, Math.min(4, Number(param?.members || param?.elements || param?.count || 1) || 1));
  const explicitBits = Number(param?.bits ?? param?.sizeBits);
  const int128 = !pointer && !aggregate && !fp && /(?:unsigned\s+)?__int128|int128_t|uint128_t/.test(type + ' ' + cls);
  const rawBits = Number.isFinite(explicitBits) && explicitBits > 0 ? explicitBits : int128 ? 128 : 64;
  const bits = Math.max(8, Math.min(1 << 20, Math.floor(rawBits)));
  const wideIntegral = !pointer && !aggregate && !fp && bits === 128;
  const declaredAlignment = Number(param?.alignment ?? param?.align ?? param?.alignmentBytes);
  const alignment = Number.isFinite(declaredAlignment) && declaredAlignment > 0
    ? Math.min(16, Math.max(1, Math.floor(declaredAlignment)))
    : wideIntegral ? 16 : 8;
  const mayContainPointers = param?.mayContainPointers === true || param?.containsPointers === true;
  return { pointer, hfa, vector, aggregate, fp, members, bits, wideIntegral, alignment, mayContainPointers };
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
  params.forEach((param,index) => {
    const c=parameterAbiClass(param);
    const regsNeeded=c.hfa ? c.members : 1;
    if (c.fp && fp + regsNeeded <= 8) {
      const regs=[];
      for(let n=0;n<regsNeeded;n++){const reg=`v${fp++}`;regs.push(reg);srcs.push({t:'reg',reg,bits:c.vector?128:c.bits});}
      arguments_.push({index,location:'register',regs,reg:regs[0],abiClass:c.hfa?'hfa':c.vector?'vector':'fp',pointer:c.pointer,bits:c.bits});
      return;
    }

    if (c.aggregate && c.bits > 128) {
      const reg = gp < 8 ? `x${gp++}` : null;
      const entry = reg
        ? {index,location:'register',reg,abiClass:'aggregate-indirect-copy',pointer:true,bits:64,pointeeBits:c.bits,aggregate:true,callerCopy:true,mayContainPointers:c.mayContainPointers}
        : {index,location:'stack',offset:stackOffset,bytes:8,abiClass:'aggregate-indirect-copy',pointer:true,bits:64,pointeeBits:c.bits,aggregate:true,callerCopy:true,mayContainPointers:c.mayContainPointers};
      if (reg) srcs.push({t:'reg',reg,bits:64,purpose:'aggregate-indirect-copy'});
      else { stackArguments.push(entry); stackOffset += 8; }
      arguments_.push(entry);
      stackArgsMayContainPointers = true;
      return;
    }

    if (c.wideIntegral) {
      if ((gp & 1) !== 0) gp += 1;
      if (gp <= 6) {
        const regs=[`x${gp}`,`x${gp+1}`]; gp += 2;
        for (const reg of regs) srcs.push({t:'reg',reg,bits:64,purpose:'wide-integral-piece'});
        arguments_.push({index,location:'registers',regs,reg:regs[0],abiClass:'wide-integer',pointer:false,bits:128,alignment:16,pieces:regs.map((reg,piece)=>({piece,reg,bits:64}))});
        return;
      }
      gp = 8;
      stackOffset = Math.ceil(stackOffset / 16) * 16;
      const entry={index,location:'stack',offset:stackOffset,bytes:16,abiClass:'wide-integer',pointer:false,bits:128,alignment:16};
      stackArguments.push(entry);arguments_.push(entry);stackOffset+=16;
      return;
    }

    if (c.aggregate) {
      const bytes=Math.max(8,Math.ceil(c.bits/64)*8);
      if (c.alignment >= 16 && (gp & 1) !== 0) gp += 1;
      const needed=Math.ceil(bytes/8);
      if (gp + needed <= 8) {
        const regs=[];
        for(let n=0;n<needed;n++){const reg=`x${gp++}`;regs.push(reg);srcs.push({t:'reg',reg,bits:64,purpose:'aggregate-piece'});}
        arguments_.push({index,location:'registers',regs,reg:regs[0],abiClass:'aggregate',pointer:false,bits:c.bits,bytes,alignment:c.alignment,mayContainPointers:c.mayContainPointers,pieces:regs.map((reg,piece)=>({piece,reg,bits:Math.min(64,Math.max(0,c.bits-piece*64))||64}))});
        return;
      }
      const registerPieces = stackOffset === 0 ? Math.max(0, 8 - gp) : 0;
      if (registerPieces > 0) {
        const regs=[];
        const pieces=[];
        for(let n=0;n<registerPieces;n++){
          const reg=`x${gp++}`;
          regs.push(reg);srcs.push({t:'reg',reg,bits:64,purpose:'aggregate-piece'});
          pieces.push({piece:n,reg,bits:64});
        }
        gp=8;
        const stackBytes=bytes-registerPieces*8;
        stackOffset = c.alignment >= 16 ? Math.ceil(stackOffset / 16) * 16 : stackOffset;
        const stackEntry={index,location:'stack-fragment',offset:stackOffset,bytes:stackBytes,abiClass:'aggregate',pointer:false,bits:stackBytes*8,alignment:8,mayContainPointers:c.mayContainPointers,pieceOffsetBytes:registerPieces*8};
        stackArguments.push(stackEntry);
        arguments_.push({index,location:'register-stack',regs,reg:regs[0],offset:stackOffset,stackBytes,bytes,abiClass:'aggregate',pointer:false,bits:c.bits,alignment:c.alignment,mayContainPointers:c.mayContainPointers,pieces:[...pieces,{piece:registerPieces,stackOffset,bytes:stackBytes}]});
        stackOffset+=stackBytes;
        if(c.mayContainPointers) stackArgsMayContainPointers=true;
        return;
      }
      gp = 8;
      stackOffset = c.alignment >= 16 ? Math.ceil(stackOffset / 16) * 16 : stackOffset;
      const entry={index,location:'stack',offset:stackOffset,bytes,abiClass:'aggregate',pointer:false,bits:c.bits,alignment:c.alignment,mayContainPointers:c.mayContainPointers};
      stackArguments.push(entry);arguments_.push(entry);stackOffset+=bytes;
      if(c.mayContainPointers) stackArgsMayContainPointers=true;
      return;
    }

    if (!c.fp && gp < 8) {
      const reg=`x${gp++}`; srcs.push({t:'reg',reg,bits:64});
      arguments_.push({index,location:'register',reg,abiClass:c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits});
      return;
    }
    const slots=Math.max(1,Math.ceil((c.hfa?c.members*c.bits:c.bits)/64));
    if (c.hfa && fp + regsNeeded > 8) fp = 8;
    const entry={index,location:'stack',offset:stackOffset,bytes:slots*8,abiClass:c.hfa?'hfa':c.vector?'vector':c.fp?'fp':c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits};
    stackArguments.push(entry);arguments_.push(entry);stackOffset+=slots*8;
    if(c.pointer || c.mayContainPointers) stackArgsMayContainPointers=true;
  });
  return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:proto?.variadic===true||proto?.varargs===true, stackArgsMayContainPointers, evidence:'prototype-aapcs64' };
}

export function classifyAAPCS64CallReturn(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  if (!proto) return null;
  const type = String(proto.returnType || proto.ret || proto.result || '').toLowerCase();
  const cls = String(proto.returnClass || proto.abiClass || proto.resultClass || '').toLowerCase();
  if (proto.void === true || type === 'void' || cls === 'void') return null;
  if (proto.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto.returnBits || proto.bits || 64) || 64 };
  }
  const returnBits=Number(proto.returnBits || proto.bits || 64) || 64;
  const aggregate=proto.aggregate===true||proto.isAggregate===true||/aggregate|struct|union|record|array|composite/.test(type+' '+cls);
  const wideInteger=!aggregate&&(/(?:unsigned\s+)?__int128|int128_t|uint128_t/.test(type+' '+cls)||returnBits===128);
  if (aggregate && returnBits>128) return {reg:null,regs:[],bits:returnBits,aggregate:true,indirect:true,hiddenResultPointer:'x8'};
  if ((aggregate && returnBits>64) || wideInteger) return {reg:'x0',regs:['x0','x1'],bits:returnBits,aggregate,wideInteger,pieces:[{reg:'x0',bits:64},{reg:'x1',bits:64}]};
  if (type || cls || proto.returnsValue === true) return { reg:'x0', bits:returnBits };
  return null;
}

export function classifyAAPCS64FunctionReturn(opts = {}) {
  const proto = opts?.functionPrototype || opts?.prototype || null;
  const type = String(opts?.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(opts?.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (opts?.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  if (proto?.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto?.returnBits || proto?.bits || opts?.returnBits || 64) || 64 };
  }
  if (type || cls || opts?.returnsValue === true || proto?.returnsValue === true) {
    const returnBits=Number(proto?.returnBits || proto?.bits || opts?.returnBits || 64) || 64;
    const aggregate=proto?.aggregate===true||proto?.isAggregate===true||/aggregate|struct|union|record|array|composite/.test(type+' '+cls);
    const wideInteger=!aggregate&&(/(?:unsigned\s+)?__int128|int128_t|uint128_t/.test(type+' '+cls)||returnBits===128);
    if (aggregate && returnBits>128) return {reg:null,regs:[],bits:returnBits,aggregate:true,indirect:true,hiddenResultPointer:'x8'};
    if ((aggregate && returnBits>64) || wideInteger) return {reg:'x0',regs:['x0','x1'],bits:returnBits,aggregate,wideInteger,pieces:[{reg:'x0',bits:64},{reg:'x1',bits:64}]};
    return { reg:'x0', bits:returnBits };
  }
  return null;
}

const CALLER_SAVED = Object.freeze(['x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x30','nzcv',
  ...Array.from({length:8},(_x,i)=>`v${i}`), ...Array.from({length:16},(_x,i)=>`v${i+16}`)]);
const CALLEE_SAVED = Object.freeze(['x19','x20','x21','x22','x23','x24','x25','x26','x27','x28','x29', ...Array.from({length:8},(_x,i)=>`v${i+8}`)]);

export const AAPCS64_ABI = new ABIPlugin({
  id:'aapcs64', semanticVersion:'1', architectureId:'arm64',
  platformPredicate:({ platform }) => !platform || platform === 'darwin' || platform === 'linux' || platform === 'android' || platform === 'unknown',
  callingConventions:()=>Object.freeze(['aapcs64']),
  classifyArguments:classifyAAPCS64Arguments,
  classifyCallReturn:classifyAAPCS64CallReturn,
  classifyFunctionReturn:classifyAAPCS64FunctionReturn,
  classifyEntryRegister:(reg) => /^x[0-7]$/.test(String(reg || '')) ? { kind:'argument', reg:String(reg), index:Number(String(reg).slice(1)) } : { kind:'incoming-register-state', reg:String(reg || '') },
  callerSaved:()=>CALLER_SAVED,
  calleeSaved:()=>CALLEE_SAVED,
  stackRules:()=>Object.freeze({ alignment:16, stackGrows:'down', argumentSlotBytes:8 }),
  redZone:()=>0,
  unwindRules:()=>Object.freeze({ framePointer:'x29', linkRegister:'x30' }),
  defaultUnknownCallEffects:()=>Object.freeze({ registerClobbers:CALLER_SAVED, memoryEffects:'unknown', mayThrow:true }),
});
