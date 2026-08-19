import assert from 'node:assert/strict';
import {
  architectureAdapter,
  architectureCapability,
  architecturePluginV2,
} from '../js/architecture/index.js';
import {
  AAPCS64_ABI,
  DARWIN_ARM64_ABI,
  MICROSOFT_X64_ABI,
  SYSV_AMD64_ABI,
  resolveABIPlugin,
} from '../js/targets/abi/index.js';
import { platformProfile } from '../js/targets/platform/index.js';
import { classifyCallArguments } from '../js/ir-core.js';

const BASE = 0x100000000n;
const region = { vmAddr:BASE, size:0x100n };

// Architecture v2 owns ISA properties and no ABI classification surface.
{
  const arm64 = architecturePluginV2('arm64');
  assert.equal(arm64.id, 'arm64');
  assert.equal(arm64.instructionAlignment, 4);
  assert.equal(arm64.fixedInstructionSize, 4);
  assert.equal(arm64.classifyControlFlow({ mnemonic:'bl' }), 'call');
  assert.equal('classifyArguments' in arm64, false);
  assert.equal('callerSaved' in arm64, false);
  assert.equal(arm64.capabilities.semanticAnalysis, 'legacy-v1');
}

// The v1 ArchitectureAdapter remains behavior-compatible.
{
  const arm64 = architectureAdapter('arm64');
  assert.equal(typeof arm64.assemble, 'function');
  assert.equal(arm64.rowForAddress(region, BASE + 8n), 2);
  assert.equal(arm64.addressForRow(region, 2), BASE + 8n);
  assert.equal(arm64.callKind({ mnemonic:'blr' }), 'call');
  assert.equal(arm64.returnKind({ mnemonic:'ret' }), 'return');
}

// AAPCS64 owns call arguments, returns, saved registers, and stack rules.
{
  const unknownCall = AAPCS64_ABI.classifyArguments({});
  assert.deepEqual(unknownCall.srcs.slice(0, 8).map((x) => x.reg), ['x0','x1','x2','x3','x4','x5','x6','x7']);
  assert.deepEqual(unknownCall.srcs.slice(8).map((x) => x.reg), ['v0','v1','v2','v3','v4','v5','v6','v7']);
  assert.equal(unknownCall.stackArgsUnknown, true);
  assert.equal(unknownCall.evidence, 'conservative-aapcs64');
  assert.deepEqual(classifyCallArguments({}), unknownCall, 'public legacy export must preserve AAPCS64 classification');

  const insn = { callPrototype:{ args:[{ type:'int' }, { type:'double', abiClass:'fp' }], returnType:'double' } };
  const classified = AAPCS64_ABI.classifyArguments(insn);
  assert.equal(classified.arguments[0].reg, 'x0');
  assert.equal(classified.arguments[1].reg, 'v0');
  assert.deepEqual(AAPCS64_ABI.classifyCallReturn(insn), { reg:'v0', bits:64 });
  assert.ok(AAPCS64_ABI.callerSaved().includes('x30'));
  assert.ok(AAPCS64_ABI.calleeSaved().includes('x19'));
  assert.equal(AAPCS64_ABI.stackRules().alignment, 16);
}

// Platform profiles keep their compatibility default ABI string, while the
// semantic resolver may select a more precise platform variant. Regression:
// #998 integration must not collapse Darwin back into generic AAPCS64.
{
  assert.equal(platformProfile('darwin').defaultABI({ architecture:'arm64' }), 'aapcs64');
  assert.equal(resolveABIPlugin({ architecture:'arm64', platform:'darwin' }), DARWIN_ARM64_ABI);
  assert.equal(resolveABIPlugin({ architecture:'arm64', platform:'linux' }), AAPCS64_ABI);
  assert.notEqual(DARWIN_ARM64_ABI.semanticIdentity, AAPCS64_ABI.semanticIdentity);
  assert.equal(resolveABIPlugin({ architecture:'x86_64', platform:'windows' }), MICROSOFT_X64_ABI);
  assert.equal(resolveABIPlugin({ architecture:'x86_64', platform:'linux' }), SYSV_AMD64_ABI);
}

// Decode support is not semantic-analysis support for x86-64.
{
  const x86 = architecturePluginV2('x86_64');
  assert.equal(x86.capabilities.decode, 'external-structured-v1');
  assert.equal(x86.capabilities.semanticAnalysis, 'phase5-shadow-partial');
  const capability = architectureCapability({ format:'pe', arch:'x86_64', endian:'little', bits:64 }, { x86_64:true, verified:true });
  assert.equal(capability.canDisassemble, true);
  assert.equal(capability.canAnalyzeDataflow, false);
  assert.equal(capability.analysisLevel, 'unsupported');
}

console.log('architecture/ABI Phase 1 regressions passed');
