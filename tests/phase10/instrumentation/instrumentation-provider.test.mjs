import assert from 'node:assert/strict';
import test from 'node:test';

import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

const binaryId = 'bin_sha256_' + 'bc'.repeat(32);

class InstrumentBackend {
  constructor({ moduleIdentity = true } = {}) { this.id = 'frida-fixture'; this.listeners = new Set(); this.probes = new Map(); this.next = 1; this.connected = false; this.moduleIdentity = moduleIdentity; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of [...this.listeners]) listener(event); }
  async getModules() {
    const module = { id: 'main', base: 0x7000n, size: 0x1000n, staticBase: 0x1000n };
    if (!this.moduleIdentity) return [module];
    return [{ ...module, binaryId, sliceId: 'slice:arm64', identityState: 'exact', identityEvidenceIds: ['fixture:frida-module-match'] }];
  }
  async installProbe(spec) { const handle = `probe:${this.next++}`; this.probes.set(handle, spec); return { handle }; }
  async removeProbe(handle) { return this.probes.delete(handle); }
  async replace(target, replacement) { return { target, replacement, installed: true }; }
  async readMemory(_address, size) { return new Uint8Array(size); }
  async writeMemory(_address, bytes) { return { written: bytes.length }; }
  async getObjCRuntimeInfo() { return { classes: ['Fixture'] }; }
  async getSwiftRuntimeInfo() { return { types: ['Fixture.Type'] }; }
}

test('P10.8 instrumentation is first-class and probe installation is intervention-tracked', async () => {
  const backend = new InstrumentBackend();
  const provider = new InstrumentationProvider(backend, { id: 'frida-provider' });
  const session = await provider.openSession({ binaryId, sliceId: 'slice:arm64', targetIdentity: 'process:1', sessionNonce: 'inst:1' });
  assert.equal(session.state, 'ready');
  assert.ok(session.facets.instrumentation);
  assert.equal(session.facets.debugger, undefined);
  assert.equal(session.modules.resolve(0x7010n, { binaryId }).state, 'exact');
  const probe = await session.facets.instrumentation.installProbe({ address: 0x7010n, kind: 'call' });
  assert.match(probe.result.handle, /^probe:/);
  assert.equal(probe.intervention.kind, 'probe-install');
  assert.equal(session.facets.instrumentation.interventions.all().length, 1);
  backend.emit({ type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1, payload: { probeHandle: probe.result.handle, call: 'foo' } });
  const batch = session.facets.instrumentation.events.flush();
  assert.deepEqual(batch.events[0].interventionIds, [probe.intervention.interventionId]);
  const removed = await session.facets.instrumentation.removeProbe(probe.result.handle);
  assert.equal(removed.intervention.kind, 'probe-remove');
  assert.deepEqual(removed.intervention.parentInterventionIds, [probe.intervention.interventionId]);
  await session.close();
  assert.equal(backend.connected, false);
  assert.equal(backend.listeners.size, 0);
});

test('P10.8 instrumentation does not authenticate a first module from session identity alone', async () => {
  const provider = new InstrumentationProvider(new InstrumentBackend({ moduleIdentity: false }), { id: 'frida-unproven-provider' });
  const session = await provider.openSession({ binaryId, sliceId: 'slice:arm64', targetIdentity: 'process:unproven', sessionNonce: 'inst:unproven' });
  const [module] = session.modules.active();
  assert.equal(module.identityState, 'unresolved');
  assert.equal(module.binaryId, null);
  assert.equal(session.modules.resolve(0x7010n, { binaryId }).state, 'unresolved');
  await session.close();
});

test('P10.8 replacement and writes require provider-owned authority and create intervention lineage', async () => {
  const provider = new InstrumentationProvider(new InstrumentBackend(), {
    id: 'frida-mutation-provider',
    authorizeMutation: async ({ context }) => context?.grant === 'trusted-runtime-mutation',
  });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:2', sessionNonce: 'inst:2' });
  await assert.rejects(() => session.facets.instrumentation.replace('foo', 'bar'), /permission|authorization/i);
  await assert.rejects(() => session.facets.instrumentation.replace('foo', 'bar', { authorized: true }), /permission|authorization/i);
  const replacement = await session.facets.instrumentation.replace('foo', 'bar', { authorizationContext: { grant: 'trusted-runtime-mutation' } });
  assert.equal(replacement.intervention.kind, 'function-replacement');
  await assert.rejects(() => session.facets.instrumentation.writeMemory(0x7000n, new Uint8Array([1]), { authorized: true }), /permission|authorization/i);
  const write = await session.facets.instrumentation.writeMemory(0x7000n, new Uint8Array([1]), {
    authorizationContext: { grant: 'trusted-runtime-mutation' },
    parentInterventionIds: [replacement.intervention.interventionId],
  });
  assert.equal(write.intervention.kind, 'memory-write');
  const ancestry = session.facets.instrumentation.interventions.ancestry([write.intervention.interventionId]);
  assert.deepEqual(new Set(ancestry.map((item) => item.interventionId)), new Set([replacement.intervention.interventionId, write.intervention.interventionId]));
  await session.close();
});

test('P10.8 high-volume event loss remains explicit and truncated', async () => {
  const backend = new InstrumentBackend();
  const provider = new InstrumentationProvider(backend, { id: 'frida-events-provider', events: { maxEvents: 1, maxBytes: 65536 } });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:3', sessionNonce: 'inst:3' });
  backend.emit({ type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 1, payload: { call: 'foo' } });
  backend.emit({ type: 'instrumentation-observation', epoch: 1, streamId: 'thread:1', sequence: 2, payload: { call: 'bar' } });
  const batch = session.facets.instrumentation.events.flush();
  assert.equal(batch.completeness, 'truncated');
  assert.ok(batch.events.some((event) => event.kind === 'dropped-events'));
  await session.close();
});

test('P10.8 metadata observations stay observation capabilities rather than mutation authority', async () => {
  const provider = new InstrumentationProvider(new InstrumentBackend(), { id: 'frida-runtime-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'process:4', sessionNonce: 'inst:4' });
  assert.deepEqual(await session.facets.instrumentation.getObjCRuntimeInfo(), { classes: ['Fixture'] });
  assert.deepEqual(await session.facets.instrumentation.getSwiftRuntimeInfo(), { types: ['Fixture.Type'] });
  assert.equal(session.facets.instrumentation.interventions.all().length, 0);
  await session.close();
});
