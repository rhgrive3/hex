import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapter } from '../../../js/debug/adapter.js';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';

const binaryId = 'bin_sha256_' + '9a'.repeat(32);

class EventAdapter extends DebugAdapter {
  constructor(kind = 'lldb') {
    super({ id: `fixture-${kind}`, kind, capabilities: { modules: true, threads: true, readMemory: true, writeMemory: true, readRegisters: true, writeRegister: true } });
    this.listeners = new Set();
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  async getModules() { return []; }
  async getThreads() { return [{ id: 't1' }]; }
  async readMemory(_address, size) { return new Uint8Array(size); }
  async writeMemory(_address, bytes) { return { written: bytes.length }; }
  async readRegisters() { return { pc: 0x7000n }; }
  async writeRegister(name, value) { return { name, value }; }
}

for (const kind of ['lldb', 'remote']) {
  test(`P10.7 ${kind} adapters satisfy the same provider lifecycle contract`, async () => {
    const adapter = new EventAdapter(kind);
    const provider = new DebuggerProvider(adapter, { id: `${kind}-provider` });
    const session = await provider.openSession({ binaryId, targetIdentity: { process: `${kind}:1` }, sessionNonce: `${kind}:nonce` });
    assert.equal(session.state, 'ready');
    assert.ok(session.facets.debugger);

    adapter.emit({ type: 'module-load', epoch: 1, streamId: 'debugger', sequence: 1, payload: { bindingKey: 'main', runtimeBase: 0x7000n, runtimeSize: 0x1000n, staticBase: 0x1000n, binaryId, identityState: 'exact', identityEvidenceIds: ['fixture:debugger-module-match'] } });
    adapter.emit({ type: 'paused', epoch: 1, streamId: 'debugger', sequence: 2 });
    assert.equal(session.state, 'paused');
    assert.equal(session.modules.active()[0].generation, 1);
    assert.equal(session.facets.debugger.resolveAddress(0x7010n, { binaryId }).state, 'exact');

    adapter.emit({ type: 'module-unload', epoch: 1, streamId: 'debugger', sequence: 3, payload: { bindingKey: 'main' } });
    adapter.emit({ type: 'module-load', epoch: 1, streamId: 'debugger', sequence: 4, payload: { bindingKey: 'main', runtimeBase: 0x7000n, runtimeSize: 0x1000n, staticBase: 0x2000n, binaryId, identityState: 'exact', identityEvidenceIds: ['fixture:debugger-module-match-reload'] } });
    assert.equal(session.modules.active()[0].generation, 2);

    const batch = session.facets.debugger.events.flush();
    assert.ok(batch.events.some((event) => event.kind === 'module-unload'));
    await session.close();
    assert.equal(adapter.listeners.size, 0);
  });
}

test('P10.7 provider-reported binaryId without binding evidence stays unresolved', async () => {
  const adapter = new EventAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'unproven-debugger-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture-unproven', sessionNonce: 'debug:unproven' });
  adapter.emit({ type: 'module-load', epoch: 1, streamId: 'debugger', sequence: 1, payload: { bindingKey: 'main', runtimeBase: 0x7000n, runtimeSize: 0x1000n, staticBase: 0x1000n, binaryId } });
  const [module] = session.modules.active();
  assert.equal(module.identityState, 'unresolved');
  assert.equal(module.binaryId, null);
  assert.equal(session.facets.debugger.resolveAddress(0x7010n, { binaryId }).state, 'unresolved');
  await session.close();
});

test('P10.7 debugger mutations create provider-scoped intervention records', async () => {
  const adapter = new EventAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'debug-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'debug:nonce' });
  const register = await session.facets.debugger.writeRegister('pc', 0x7004n);
  assert.equal(register.intervention.providerId, 'debug-provider');
  assert.equal(register.intervention.kind, 'register-write');
  const memory = await session.facets.debugger.writeMemory(0x8000n, new Uint8Array([1, 2]));
  assert.equal(memory.intervention.kind, 'memory-write');
  assert.equal(session.facets.debugger.interventions.all().length, 2);
  await session.close();
});

test('P10.7 epoch changes cancel in-flight operations and reject old events', async () => {
  const adapter = new EventAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'epoch-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'epoch:nonce' });
  const controller = session.controller();
  session.newProviderEpoch();
  assert.equal(controller.signal.aborted, true);
  assert.equal(session.facets.debugger.events.ingest({ type: 'paused', epoch: 1, streamId: 'debugger', sequence: 1 }), null);
  assert.ok(session.facets.debugger.events.ingest({ type: 'paused', epoch: 2, streamId: 'debugger', sequence: 1 }));
  await session.close();
});
