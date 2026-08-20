import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapter } from '../../../js/debug/adapter.js';
import {
  RuntimeProviderRegistry,
  wrapDebugAdapterAsRuntimeProvider,
} from '../../../js/runtime/provider.js';

const binaryId = 'bin_sha256_' + '12'.repeat(32);

class FixtureAdapter extends DebugAdapter {
  constructor(kind = 'lldb') {
    super({
      id: `fixture-${kind}`,
      kind,
      capabilities: {
        modules: true,
        threads: true,
        readMemory: true,
        writeMemory: true,
        readRegisters: true,
        writeRegister: true,
        traceFunction: true,
        replay: kind === 'replay',
        objcRuntime: kind === 'frida',
      },
    });
    this.memory = new Uint8Array([1, 2, 3, 4]);
  }
  async getModules() { return [{ id: 'main', base: 0x7000n, size: 0x1000n, staticBase: 0x1000n }]; }
  async getThreads() { return [{ id: 't1' }]; }
  async readMemory(_address, size) { return this.memory.slice(0, size); }
  async writeMemory(_address, bytes) { this.memory = Uint8Array.from(bytes); return { written: this.memory.length }; }
  async readRegisters() { return { pc: 0x7000n }; }
  async writeRegister(name, value) { return { name, value }; }
  async trace() { return { events: [], complete: true }; }
  async replay() { return { events: [], complete: true }; }
  async getObjCRuntimeInfo() { return { classes: [] }; }
}

test('P10.2 registry owns providers and rejects duplicate identity', () => {
  const registry = new RuntimeProviderRegistry();
  const provider = wrapDebugAdapterAsRuntimeProvider(new FixtureAdapter(), { id: 'fixture-provider' });
  registry.register(provider);
  assert.equal(registry.get('fixture-provider'), provider);
  assert.deepEqual(registry.list().map((item) => item.id), ['fixture-provider']);
  assert.throws(() => registry.register(provider), /already registered/);
});

test('P10.2 compatibility provider creates one canonical runtime session and module bindings', async () => {
  const registry = new RuntimeProviderRegistry();
  const provider = registry.register(wrapDebugAdapterAsRuntimeProvider(new FixtureAdapter('lldb'), { id: 'lldb-provider' }));
  const session = await registry.openSession('lldb-provider', {
    binaryId,
    sliceId: 'slice:arm64',
    targetIdentity: { process: 'fixture' },
    sessionNonce: 'nonce-1',
    architecture: 'arm64',
    platform: 'darwin',
  });

  assert.match(session.runtimeSessionId, /^runtime_[0-9a-f]{32}$/);
  assert.equal(session.state, 'ready');
  assert.ok(session.facets.debugger);
  assert.ok(session.facets.trace);
  assert.equal(session.modules.active().length, 1);
  assert.equal(session.modules.resolve(0x7010n, { binaryId }).state, 'exact');

  await assert.rejects(() => provider.openSession({ binaryId, targetIdentity: 'other', sessionNonce: 'nonce-2' }), /one live session|in-use/i);
  await session.close();
  assert.equal(session.state, 'closed');
});

test('P10.2 debugger writes return intervention lineage instead of silent mutation', async () => {
  const provider = wrapDebugAdapterAsRuntimeProvider(new FixtureAdapter('lldb'), { id: 'debugger-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'nonce-3' });
  const memoryWrite = await session.facets.debugger.writeMemory(0x7000n, new Uint8Array([9, 8]));
  assert.equal(memoryWrite.intervention.kind, 'memory-write');
  assert.equal(memoryWrite.intervention.runtimeSessionId, session.runtimeSessionId);
  const registerWrite = await session.facets.debugger.writeRegister('pc', 0x7004n);
  assert.equal(registerWrite.intervention.kind, 'register-write');
  await session.close();
});

test('P10.2 Frida compatibility is an instrumentation facet, not a second session system', async () => {
  const provider = wrapDebugAdapterAsRuntimeProvider(new FixtureAdapter('frida'), { id: 'frida-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'nonce-4' });
  assert.ok(session.facets.debugger);
  assert.ok(session.facets.instrumentation);
  assert.equal(session.facets.instrumentation.interventionContext().runtimeSessionId, session.runtimeSessionId);
  await session.close();
});
