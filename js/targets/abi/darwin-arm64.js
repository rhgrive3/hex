import { ABIPlugin } from './registry.js';
import {
  AAPCS64_ABI,
  classifyAAPCS64CallReturn,
  classifyAAPCS64FunctionReturn,
} from './aapcs64.js';

const DARWIN_PLATFORMS = new Set(['darwin','apple','ios','ipados','macos','tvos','watchos','visionos']);

function callPrototypeOf(insn, opts) {
  let proto = insn?.callPrototype || null;
  if (!proto) {
    try { proto = opts?.callPrototypeFor?.(insn?.callTarget ?? null, insn) || null; } catch { proto = null; }
  }
  return proto;
}

function parameterList(proto) {
  const list = proto && (proto.args || proto.parameters || proto.params || proto.arguments);
  return Array.isArray(list) ? list : null;
}

function parameterClass(param) {
  const type = String(param?.type || param?.name || '').toLowerCase();
  const cls = String(param?.abiClass || param?.class || param?.kind || '').toLowerCase();
  const pointer = param?.pointer === true || param?.isPointer === true || /\*|pointer|ptr|object|class|block|closure/.test(`${type} ${cls}`);
  const hfa = param?.hfa === true || param?.hva === true || cls.includes('hfa') || cls.includes('hva') || cls.includes('homogeneous');
  const vector = param?.vector === true || cls.includes('vector') || /vector|simd/.test(type);
  const fp = hfa || vector || cls.includes('float') || cls.includes('fp') || /^(float|double|__fp16)/.test(type);
  const members = Math.max(1, Math.min(4, Number(param?.members || param?.elements || param?.count || 1) || 1));
  const bits = Math.max(8, Math.min(512, Number(param?.bits || param?.sizeBits || 64) || 64));
  const bytes = Math.max(1, Math.ceil((hfa ? members * bits : bits) / 8));
  const explicitAlignment = Number(param?.alignmentBytes || param?.alignBytes || param?.alignment || 0);
  let alignmentBytes = Number.isSafeInteger(explicitAlignment) && explicitAlignment > 0 ? explicitAlignment : 1;
  if (!(Number.isSafeInteger(explicitAlignment) && explicitAlignment > 0)) {
    if (bytes >= 16) alignmentBytes = 16;
    else if (bytes >= 8) alignmentBytes = 8;
    else if (bytes >= 4) alignmentBytes = 4;
    else if (bytes >= 2) alignmentBytes = 2;
  }
  const signed = param?.signed === true || /(^|\s)(?:signed|int\d*)/.test(type);
  return { pointer, hfa, vector, fp, members, bits, bytes, alignmentBytes, signed };
}

function alignUp(value, alignment) {
  const a = Math.max(1, Number(alignment) || 1);
  return Math.ceil(value / a) * a;
}

function registerSource(reg, bits) {
  return { t:'reg', reg, bits, possible:false, mustUse:true };
}

export function classifyDarwinArm64Arguments(insn, opts = {}) {
  const proto = callPrototypeOf(insn, opts);
  const params = parameterList(proto);
  const srcs = [];
  const arguments_ = [];
  const stackArguments = [];
  let gp = 0;
  let fp = 0;
  let stackOffset = 0;
  let stackArgsMayContainPointers = false;

  if (!params) {
    for (let i = 0; i < 8; i++) {
      srcs.push({ t:'reg', reg:`x${i}`, bits:64, possible:true, mustUse:false, abiClass:'unknown-gp' });
      arguments_.push({ index:i, location:'register', reg:`x${i}`, bits:64, abiClass:'unknown-gp', possible:true, mustUse:false, mayContainPointers:true });
    }
    for (let i = 0; i < 8; i++) {
      srcs.push({ t:'reg', reg:`v${i}`, bits:128, possible:true, mustUse:false, abiClass:'unknown-fp-vector' });
      arguments_.push({ index:8 + i, location:'register', reg:`v${i}`, bits:128, abiClass:'unknown-fp-vector', possible:true, mustUse:false });
    }
    return {
      srcs,
      arguments:arguments_,
      stackArguments,
      stackArgsUnknown:true,
      stackArgsMayContainPointers:true,
      possibleRegisterInputs:srcs.slice(),
      partial:true,
      evidence:'conservative-darwin-arm64',
    };
  }

  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    const c = parameterClass(param);
    if (c.fp) {
      const regsNeeded = c.hfa ? c.members : 1;
      if (fp + regsNeeded <= 8) {
        const regs = [];
        for (let n = 0; n < regsNeeded; n++) {
          const reg = `v${fp++}`;
          regs.push(reg);
          srcs.push(registerSource(reg, c.vector ? Math.min(128, c.bits) : c.bits));
        }
        arguments_.push({
          index,
          location:'register',
          regs,
          reg:regs[0],
          abiClass:c.hfa ? 'hfa-hva' : c.vector ? 'vector' : 'fp',
          pointer:c.pointer,
          bits:c.bits,
          possible:false,
          mustUse:true,
        });
        continue;
      }
    } else {
      const regsNeeded = Math.max(1, Math.ceil(c.bits / 64));
      if (gp + regsNeeded <= 8) {
        const regs = [];
        for (let n = 0; n < regsNeeded; n++) {
          const reg = `x${gp++}`;
          regs.push(reg);
          srcs.push(registerSource(reg, 64));
        }
        arguments_.push({
          index,
          location:'register',
          regs,
          reg:regs[0],
          abiClass:c.pointer ? 'pointer' : regsNeeded > 1 ? 'wide-integer' : 'integer',
          pointer:c.pointer,
          bits:c.bits,
          possible:false,
          mustUse:true,
          ...(c.bits < 32 && !c.pointer ? {
            callerExtended:true,
            extension:c.signed ? 'sign-extend-to-32' : 'zero-extend-to-32',
          } : {}),
        });
        continue;
      }
    }

    stackOffset = alignUp(stackOffset, c.alignmentBytes);
    const entry = {
      index,
      location:'stack',
      offset:stackOffset,
      bytes:c.bytes,
      alignmentBytes:c.alignmentBytes,
      abiClass:c.hfa ? 'hfa-hva' : c.vector ? 'vector' : c.fp ? 'fp' : c.pointer ? 'pointer' : 'integer',
      pointer:c.pointer,
      bits:c.bits,
      possible:false,
      mustUse:true,
      compactDarwinSlot:true,
    };
    stackArguments.push(entry);
    arguments_.push(entry);
    stackOffset += c.bytes;
    if (c.pointer || param?.mayContainPointers === true || param?.containsPointers === true) stackArgsMayContainPointers = true;
  }

  const variadic = proto?.variadic === true || proto?.varargs === true;
  return {
    srcs,
    arguments:arguments_,
    stackArguments,
    stackArgsUnknown:variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers || variadic,
    possibleRegisterInputs:[],
    variadicTail:variadic ? {
      location:'stack',
      possible:true,
      mustUse:false,
      slotAlignmentBytes:8,
      mayContainPointers:true,
      reason:'darwin-arm64-variadic-stage-c-stack-only',
    } : null,
    partial:variadic,
    evidence:variadic ? 'prototype-darwin-arm64-variadic' : 'prototype-darwin-arm64',
  };
}

const DARWIN_CALLER_SAVED = Object.freeze(AAPCS64_ABI.callerSaved().filter((reg) => reg !== 'x18'));
const DARWIN_CALLEE_SAVED = Object.freeze(AAPCS64_ABI.calleeSaved().filter((reg) => reg !== 'x18'));

export const DARWIN_ARM64_ABI = new ABIPlugin({
  id:'darwin-arm64',
  semanticVersion:'1',
  semanticIdentity:'darwin-arm64@1',
  architectureId:'arm64',
  platformPredicate:({ platform }) => DARWIN_PLATFORMS.has(String(platform || '').toLowerCase()),
  callingConventions:()=>Object.freeze(['darwin-arm64','apple-arm64','aapcs64']),
  classifyArguments:classifyDarwinArm64Arguments,
  classifyCallReturn:classifyAAPCS64CallReturn,
  classifyFunctionReturn:classifyAAPCS64FunctionReturn,
  classifyEntryRegister:(reg) => /^x[0-7]$/.test(String(reg || ''))
    ? { kind:'argument', reg:String(reg), index:Number(String(reg).slice(1)) }
    : { kind:'incoming-register-state', reg:String(reg || '') },
  callerSaved:()=>DARWIN_CALLER_SAVED,
  calleeSaved:()=>DARWIN_CALLEE_SAVED,
  stackRules:()=>Object.freeze({
    alignment:16,
    stackGrows:'down',
    compactArgumentSlots:true,
    argumentSlotBytes:null,
    variadicAnonymousArguments:'stack-only',
    variadicStackSlotAlignment:8,
    reservedRegisters:Object.freeze(['x18']),
    narrowIntegerArguments:'caller-extends-to-32',
    vaListKind:'char-pointer',
    redZoneBytes:128,
  }),
  redZone:()=>128,
  unwindRules:()=>Object.freeze({ framePointer:'x29', linkRegister:'x30', redZoneBytes:128 }),
  defaultUnknownCallEffects:()=>Object.freeze({
    registerClobbers:DARWIN_CALLER_SAVED,
    memoryEffects:'unknown',
    mayThrow:true,
    stackArguments:'unknown',
    stackArgsMayContainPointers:true,
    reservedRegisters:Object.freeze(['x18']),
  }),
});
