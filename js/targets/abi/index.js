import { ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin } from './registry.js';
import { AAPCS64_ABI } from './aapcs64.js';

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

registerABIPlugin(AAPCS64_ABI);
registerABIPlugin(UNKNOWN_ABI);

export { ABIPlugin, registerABIPlugin, abiPlugin, abiPlugins, findABIPlugin, AAPCS64_ABI, UNKNOWN_ABI };

export function resolveABIPlugin(target = {}, { legacyDefault = false } = {}) {
  if (target?.abiPlugin && typeof target.abiPlugin === 'object') return target.abiPlugin;
  if (target?.abi && typeof target.abi === 'object') return target.abi;
  const explicit = target?.abiId || (typeof target?.abi === 'string' ? target.abi : null);
  if (explicit) return abiPlugin(explicit);
  const found = findABIPlugin({ architecture:target?.architecture || target?.arch, platform:target?.platform });
  if (found?.supported) return found;
  // Compatibility only: pre-Phase-1 semantic callers often do not carry target
  // metadata because the old IR core was ARM64-only. Keep that exact behavior
  // until callers migrate, without placing AAPCS64 constants in generic IR code.
  if (legacyDefault && !target?.architecture && !target?.arch) return AAPCS64_ABI;
  return UNKNOWN_ABI;
}
