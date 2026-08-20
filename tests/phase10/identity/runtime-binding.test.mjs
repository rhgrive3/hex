import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeModuleBindingTable,
  createRuntimeProviderSessionId,
  createRuntimeTargetBinding,
} from '../../../js/runtime/provider-identity.js';

const binaryA = 'bin_sha256_' + 'aa'.repeat(32);
const binaryB = 'bin_sha256_' + 'bb'.repeat(32);
const sliceA = 'slice:arm64';

function sessionId(binaryId = binaryA) {
  return createRuntimeProviderSessionId({
    binaryId,
    providerId: 'fixture-provider',
    targetIdentity: { processKey: 'process:1' },
    sessionNonce: 'session:1',
  });
}

test('P10.1 runtime target binding keeps provider/session identity separate from process key', () => {
  const runtimeSessionId = sessionId();
  const target = createRuntimeTargetBinding({
    runtimeSessionId,
    providerId: 'fixture-provider',
    providerVersion: '1.0.0',
    processKey: 'pid:7',
    architecture: 'arm64',
    platform: 'darwin',
    primaryBinaryId: binaryA,
    primarySliceId: sliceA,
  });
  assert.equal(target.runtimeSessionId, runtimeSessionId);
  assert.equal(target.processKey, 'pid:7');
  assert.equal(target.primaryBinaryId, binaryA);
});

test('P10.1 resolves ASLR through verified module identity, not same VA', () => {
  const runtimeSessionId = sessionId();
  const modules = new RuntimeModuleBindingTable(runtimeSessionId);
  const loaded = modules.load({
    bindingKey: 'main',
    runtimeBase: 0x7000000000n,
    runtimeSize: 0x10000n,
    staticBase: 0x100000000n,
    binaryId: binaryA,
    sliceId: sliceA,
    identityState: 'exact',
    identityEvidenceIds: ['evidence:module-hash'],
  });
  assert.equal(loaded.generation, 1);
  const resolved = modules.resolve(0x7000001234n, { binaryId: binaryA, sliceId: sliceA });
  assert.equal(resolved.state, 'exact');
  assert.equal(resolved.staticAddress, 0x100001234n);
  assert.equal(resolved.moduleGeneration, 1);
});

test('P10.1 wrong binary and wrong slice fail closed', () => {
  const runtimeSessionId = sessionId();
  const modules = new RuntimeModuleBindingTable(runtimeSessionId);
  modules.load({ bindingKey: 'main', runtimeBase: 0x1000n, runtimeSize: 0x1000n, staticBase: 0x4000n, binaryId: binaryA, sliceId: sliceA });
  assert.equal(modules.resolve(0x1100n, { binaryId: binaryB, sliceId: sliceA }).state, 'mismatch');
  assert.equal(modules.resolve(0x1100n, { binaryId: binaryA, sliceId: 'slice:x86' }).state, 'mismatch');
});

test('P10.1 unload/reload increments module generation even at the same VA/path', () => {
  const runtimeSessionId = sessionId();
  const modules = new RuntimeModuleBindingTable(runtimeSessionId);
  modules.load({ bindingKey: 'shared', runtimeBase: 0x5000n, runtimeSize: 0x1000n, staticBase: 0x1000n, binaryId: binaryA, loadedSequence: 1 });
  modules.unload('shared', 4);
  assert.equal(modules.resolve(0x5100n, { binaryId: binaryA }).state, 'unresolved');
  const second = modules.load({ bindingKey: 'shared', runtimeBase: 0x5000n, runtimeSize: 0x1000n, staticBase: 0x2000n, binaryId: binaryB, loadedSequence: 5, pathHint: '/same/name' });
  assert.equal(second.generation, 2);
  const mismatch = modules.resolve(0x5100n, { binaryId: binaryA });
  assert.equal(mismatch.state, 'mismatch');
  assert.equal(mismatch.moduleGeneration, 2);
});

test('P10.1 JIT/anonymous mappings remain runtime-only and unresolved', () => {
  const runtimeSessionId = sessionId();
  const modules = new RuntimeModuleBindingTable(runtimeSessionId);
  modules.load({ bindingKey: 'jit:1', runtimeBase: 0x9000n, runtimeSize: 0x1000n, identityState: 'unresolved' });
  const resolution = modules.resolve(0x9010n, { binaryId: binaryA });
  assert.equal(resolution.state, 'unresolved');
  assert.equal(resolution.staticAddress, null);
});

test('P10.1 cross-version attachment requires an explicit strong match artifact', () => {
  const runtimeSessionId = sessionId(binaryA);
  const modules = new RuntimeModuleBindingTable(runtimeSessionId);
  modules.load({ bindingKey: 'main', runtimeBase: 0x1000n, runtimeSize: 0x1000n, staticBase: 0x4000n, binaryId: binaryA });
  const weak = modules.resolve(0x1100n, {
    binaryId: binaryB,
    crossVersionMatch: { accepted: true, identityConfidence: 0.99, ambiguityMargin: 0.01, staticAddress: 0x8100n },
  });
  assert.equal(weak.state, 'mismatch');

  const strong = modules.resolve(0x1100n, {
    binaryId: binaryB,
    crossVersionMatch: {
      id: 'match:1',
      accepted: true,
      identityConfidence: 0.95,
      ambiguityMargin: 0.2,
      targetBinaryId: binaryB,
      staticAddress: 0x8100n,
      targetEntityIds: ['function:target'],
      evidenceIds: ['evidence:match'],
    },
  });
  assert.equal(strong.state, 'resolved');
  assert.equal(strong.staticAddress, 0x8100n);
  assert.equal(strong.functionMatchId, 'match:1');
});
