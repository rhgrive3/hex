import { ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin } from './registry.js';
import { AAPCS64_ABI } from './aapcs64.js';
import { DARWIN_ARM64_ABI } from './darwin-arm64.js';
import { SYSV_AMD64_ABI } from './sysv-amd64.js';
import { MICROSOFT_X64_ABI } from './microsoft-x64.js';
import { MICROSOFT_VECTORCALL_ABI } from './microsoft-vectorcall.js';
import { RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI } from './riscv-lp64.js';

const UNKNOWN_ABI = new ABIPlugin({
  id:'unknown', semanticVersion:'1', architectureId:'unknown', supported:false,
  platformPredicate:()=>true,
  classifyArguments:()=>({ srcs:[], arguments:[], stackArguments:[], stackArgsUnknown:true, stackArgsMayContainPointers:true, evidence:'unsupported-abi', unsupported:true }),
  classifyCallReturn:()=>null,
  classifyFunctionReturn:()=>null,
  classifyEntryRegister:(reg)=>({ kind:'incoming-register-state', reg:String(reg || '') }),
  callerSaved:()=>Object.freeze([]),
  calleeSaved:()=>Object.freeze([]),
  stackRules:()=>Object.freeze({ unknown:true }),
  redZone:()=>null,
  unwindRules:()=>Object.freeze({ unknown:true }),
  defaultUnknownCallEffects:()=>Object.freeze({ registerEffects:'unknown', memoryEffects:'unknown', mayThrow:true }),
});

// Platform-specific variants are registered before generic fallbacks. Convention
// filtering in findABIPlugin prevents a foreign convention from silently using a
// platform default even when both plugins share the same architecture/platform.
registerABIPlugin(DARWIN_ARM64_ABI);
registerABIPlugin(AAPCS64_ABI);
registerABIPlugin(SYSV_AMD64_ABI);
registerABIPlugin(MICROSOFT_X64_ABI);
registerABIPlugin(MICROSOFT_VECTORCALL_ABI);
registerABIPlugin(RISCV_LP64_ABI);
registerABIPlugin(RISCV_LP64F_ABI);
registerABIPlugin(RISCV_LP64D_ABI);
registerABIPlugin(UNKNOWN_ABI);

export {
  ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin,
  AAPCS64_ABI, DARWIN_ARM64_ABI,
  SYSV_AMD64_ABI, MICROSOFT_X64_ABI, MICROSOFT_VECTORCALL_ABI, UNKNOWN_ABI,
  RISCV_LP64_ABI, RISCV_LP64F_ABI, RISCV_LP64D_ABI,
};

function requestedCallingConvention(target = {}) {
  const prototype = target?.callPrototype || target?.functionPrototype || target?.prototype || null;
  return target?.callingConvention || target?.convention || target?.cc
    || prototype?.callingConvention || prototype?.convention || prototype?.cc || null;
}

export function resolveABIPlugin(target = {}, { legacyDefault = false } = {}) {
  if (target?.abiPlugin && typeof target.abiPlugin === 'object') return target.abiPlugin;
  if (target?.abi && typeof target.abi === 'object') return target.abi;
  const callingConvention = requestedCallingConvention(target);
  const explicit = target?.abiId || (typeof target?.abi === 'string' ? target.abi : null);
  if (explicit) {
    return findABIPlugin({ id:explicit, callingConvention }) || UNKNOWN_ABI;
  }
  const found = findABIPlugin({
    architecture:target?.architectureId || target?.architecture || target?.arch,
    platform:target?.platformId || target?.platform || target?.os,
    callingConvention,
  });
  if (found?.supported) return found;
  // Compatibility only: pre-Phase-1 semantic callers often do not carry target
  // metadata because the old IR core was ARM64-only. Keep that exact behavior
  // until callers migrate, without placing AAPCS64 constants in generic IR code.
  if (legacyDefault && !target?.architectureId && !target?.architecture && !target?.arch && !callingConvention) return AAPCS64_ABI;
  return UNKNOWN_ABI;
}
