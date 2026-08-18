import assert from 'node:assert/strict';
import test from 'node:test';

import { ARM64_ARCHITECTURE, X86_64_ARCHITECTURE } from '../../../js/targets/architecture/index.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';
import { x86RegisterDescriptor } from '../../../js/targets/architecture/x86_64/registers.js';
import { effects, reg, vex2, physicalWrites } from '../effects/fp-simd/helpers.mjs';

test('x86 viewer compatibility and semantic selection coexist without changing ARM64', () => {
  assert.equal(X86_64_ARCHITECTURE.viewerCompatible, true);
  assert.equal(typeof X86_64_ARCHITECTURE.liftExact, 'function');
  assert.equal(X86_64_ARCHITECTURE.capabilities.semanticAnalysis, 'phase5-shadow-partial');
  assert.equal(ARM64_ARCHITECTURE.viewerCompatible, true);
  assert.equal(ARM64_ARCHITECTURE.fixedInstructionSize, 4);
  assert.equal(ARM64_ARCHITECTURE.capabilities.semanticAnalysis, 'legacy-v1');
});

test('canonical x86 physical state uses YMM-backed XMM views plus one MXCSR environment register', () => {
  const xmm0 = x86RegisterDescriptor('xmm0');
  const ymm0 = x86RegisterDescriptor('ymm0');
  const mxcsr = x86RegisterDescriptor('mxcsr');
  assert.equal(xmm0.physicalId, 'ymm0');
  assert.equal(xmm0.viewBits, 128);
  assert.equal(ymm0.physicalId, 'ymm0');
  assert.equal(ymm0.viewBits, 256);
  assert.equal(mxcsr.physicalId, 'mxcsr');
  assert.equal(mxcsr.viewBits, 32);
  assert.equal(mxcsr.kind, 'fp-environment');
});

test('legacy SSE preserves upper YMM while VEX.128 zeroes the upper half', () => {
  const legacy = effects('movaps', [reg('xmm0','write'),reg('xmm1','read')], { instructionId:'p5-i:legacy-sse' });
  assert.equal(legacy.metadata.upperLaneBehavior, 'preserve-upper-128');
  assert.equal(physicalWrites(legacy,'ymm0').length, 1);

  const vex = effects('vxorps', [reg('xmm0','write'),reg('xmm1','read'),reg('xmm2','read')], { prefixes:vex2(0xf8), instructionId:'p5-i:vex128' });
  assert.equal(vex.metadata.upperLaneBehavior, 'zero-upper-128');
  assert.equal(physicalWrites(vex,'ymm0').length, 1);
});

test('SysV AMD64 and Microsoft x64 ABI plugins remain independently selectable', () => {
  assert.equal(resolveABIPlugin({ architecture:'x86_64', abiId:'sysv-amd64' }).id, 'sysv-amd64');
  assert.equal(resolveABIPlugin({ architecture:'x86_64', abiId:'microsoft-x64' }).id, 'microsoft-x64');
});
