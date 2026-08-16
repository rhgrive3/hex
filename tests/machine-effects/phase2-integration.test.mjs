import assert from 'node:assert/strict';
import { MACHINE_EFFECTS_SCHEMA_VERSION } from '../../js/semantics/effects/index.js';
import {
  ARM64_ARCHITECTURE,
  ARM64E_ARCHITECTURE,
  X86_64_ARCHITECTURE,
  architecturePluginV2,
} from '../../js/targets/architecture/index.js';
import {
  ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  arm64MachineEffectFamilies,
} from '../../js/targets/architecture/arm64/effects/index.js';

const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });

assert.equal(MACHINE_EFFECTS_SCHEMA_VERSION, 1);
assert.equal(ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, '2');
assert.equal(ARM64_ARCHITECTURE.semanticVersion, '2');
assert.equal(ARM64E_ARCHITECTURE.semanticVersion, '2');
assert.equal(ARM64_ARCHITECTURE.capabilities.exactEffects, 'partial');
assert.equal(ARM64E_ARCHITECTURE.capabilities.exactEffects, 'partial');
assert.equal(ARM64_ARCHITECTURE.capabilities.semanticAnalysis, 'legacy-v1');
assert.equal(ARM64E_ARCHITECTURE.capabilities.semanticAnalysis, 'legacy-v1-partial');
assert.equal(X86_64_ARCHITECTURE.semanticVersion, '1');
assert.equal(X86_64_ARCHITECTURE.capabilities.exactEffects, 'unsupported');
assert.equal(X86_64_ARCHITECTURE.capabilities.semanticAnalysis, 'unsupported');
assert.equal(X86_64_ARCHITECTURE.liftExact, null);
assert.deepEqual(arm64MachineEffectFamilies(), ['flags','control','memory','integer','fp','simd','system']);
assert.equal(architecturePluginV2('arm64'), ARM64_ARCHITECTURE);
assert.equal(architecturePluginV2('arm64e'), ARM64E_ARCHITECTURE);

const add = ARM64_ARCHITECTURE.liftExact({
  instructionId:'phase2:add', mnemonic:'add', mode:'a64',
  ops:[gp(0), gp(1), gp(2)],
});
assert.equal(add.architectureId, 'arm64');
assert.equal(add.completeness, 'exact');
assert.ok(add.operations.some((operation) => operation.kind === 'register-write' && operation.register.registerId === 'x0'));
assert.ok(add.origin.instructionIds.includes('phase2:add'));

// DMB exists in both parallel family implementations. The composed dispatcher
// must choose exactly the atomic/memory implementation, which validates options.
const dmb = ARM64_ARCHITECTURE.liftExact({
  instructionId:'phase2:dmb', mnemonic:'dmb', mode:'a64', ops:[{ k:'barrier', text:'ish' }],
});
assert.equal(dmb.metadata.family, 'arm64-atomic');
assert.equal(dmb.completeness, 'exact');
assert.equal(dmb.operations.filter((operation) => operation.kind === 'barrier').length, 1);

const invalidDmb = ARM64_ARCHITECTURE.liftExact({
  instructionId:'phase2:dmb-invalid', mnemonic:'dmb', mode:'a64', ops:[{ k:'barrier', text:'future-option' }],
});
assert.equal(invalidDmb.completeness, 'partial');
assert.deepEqual(invalidDmb.unknownEffects.categories, ['memory','other']);

const paciasp = ARM64E_ARCHITECTURE.liftExact({
  instructionId:'phase2:paciasp', mnemonic:'paciasp', mode:'arm64e', operands:[],
});
assert.equal(paciasp.architectureId, 'arm64e');
assert.equal(paciasp.completeness, 'exact-with-intrinsic');
assert.ok(paciasp.operations.some((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pointer.sign'));

// Ordinary arm64e instructions delegate to the single ARM64 base semantic engine.
const arm64eBase = ARM64E_ARCHITECTURE.liftExact({
  instructionId:'phase2:arm64e-base', mnemonic:'add', mode:'a64', ops:[gp(3), gp(4), gp(5)],
});
assert.equal(arm64eBase.architectureId, 'arm64');
assert.equal(arm64eBase.metadata.family, 'integer');

// No family claims an unrelated unknown instruction as state preserving.
assert.equal(ARM64_ARCHITECTURE.liftExact({ instructionId:'phase2:unknown', mnemonic:'zzfuture', ops:[] }), null);

console.log('Phase 2 MachineEffects central integration: PASS');
