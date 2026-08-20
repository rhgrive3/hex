import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaimNode, EvidenceGraph } from '../../../js/core/evidence/index.js';
import { DebugAdapter } from '../../../js/debug/adapter.js';
import { RuntimeProviderPlatform } from '../../../js/runtime/provider-platform.js';
import { RuntimeEvidenceBridge } from '../../../js/runtime/evidence-bridge.js';

const binaryId = 'bin_sha256_' + 'ef'.repeat(32);

class DebugFixture extends DebugAdapter {
  constructor() { super({ id: 'debug-fixture', kind: 'lldb', capabilities: { modules: true, readRegisters: true, writeRegister: true } }); }
  async getModules() {
    return [{
      id: 'main',
      base: 0x7000n,
      size: 0x1000n,
      staticBase: 0x1000n,
      binaryId,
      identityState: 'exact',
      identityEvidenceIds: ['fixture:provider-plane-debug-module-match'],
    }];
  }
  async readRegisters() { return { pc: 0x7010n }; }
  async writeRegister(name, value) { return { name, value }; }
}

class InstrumentFixture {
  constructor() { this.id = 'instrument-fixture'; this.listeners = new Set(); }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async connect() {}
  async disconnect() {}
  async installProbe(spec) { return { handle: 'probe:1', spec }; }
  async removeProbe() { return true; }
  async replace(target, replacement) { return { target, replacement }; }
}

class EmulatorFixture {
  constructor() { this.id = 'emulator-fixture'; this.version = '1'; this.deterministic = true; }
  async execute(input) { return { stop: { kind: 'return' }, returnValue: input.value, events: [{ type: 'call', payload: { target: 'helper' } }] }; }
}

test('P10.I provider plane composes debugger, instrumentation, trace and emulator without a second identity system', async () => {
  const platform = new RuntimeProviderPlatform();
  platform.registerDebugAdapter(new DebugFixture(), { id: 'debugger' });
  platform.registerInstrumentationBackend(new InstrumentFixture(), { id: 'instrumentation' });
  platform.registerTrace({
    recordingId: 'trace:fixture',
    sourceProvider: 'fixture-tracer',
    binaryId,
    modules: [{
      bindingKey: 'main',
      runtimeBase: 0x7000n,
      runtimeSize: 0x1000n,
      staticBase: 0x1000n,
      binaryId,
      identityState: 'exact',
      identityEvidenceIds: ['fixture:provider-plane-trace-module-match'],
    }],
    events: [{ type: 'call', streamId: 't1', sequence: 1, moduleBindingKey: 'main', moduleGeneration: 1, payload: { target: 'helper' } }],
  }, { id: 'trace' });
  platform.registerEmulator(new EmulatorFixture(), { id: 'emulator' });

  assert.deepEqual(platform.providers().map((provider) => provider.id).sort(), ['debugger', 'emulator', 'instrumentation', 'trace']);

  const debugSession = await platform.openSession('debugger', { binaryId, targetIdentity: 'process:debug', sessionNonce: 'debug:1' });
  const debugResolution = debugSession.facets.debugger.resolveAddress(0x7010n, { binaryId });
  assert.equal(debugResolution.state, 'exact');
  await debugSession.close();

  const traceSession = await platform.openSession('trace', { targetIdentity: 'recording' });
  const replay = await traceSession.facets.trace.replay();
  assert.equal(replay.events[0].runtimeSessionId, traceSession.runtimeSessionId);
  assert.equal(replay.events[0].providerId, traceSession.providerId);
  await traceSession.close();

  const instrumentationSession = await platform.openSession('instrumentation', { binaryId, targetIdentity: 'process:instrument', sessionNonce: 'instrument:1' });
  assert.equal(instrumentationSession.facets.debugger, undefined);
  await instrumentationSession.facets.instrumentation.installProbe({ address: 0x7010n });
  await instrumentationSession.close();

  const emulatorSession = await platform.openSession('emulator', { binaryId, targetIdentity: 'emulated:fixture', sessionNonce: 'emu:1' });
  const emulated = await emulatorSession.facets.emulator.run({ value: 42 });
  assert.equal(emulated.batch.events[0].observationMode, 'synthetic');
  await emulatorSession.close();
  assert.equal(platform.sessions.size, 0);
});

test('P10.I runtime evidence can contradict a static claim only after verified mapping and never rewrites the claim', () => {
  const graph = new EvidenceGraph({ nodes: [createClaimNode({
    id: 'claim:branch',
    binaryId,
    targetEntityIds: ['function:fixture'],
    semanticKind: 'branch-unreachable',
    verdict: 'unknown',
  })] });
  const bridge = new RuntimeEvidenceBridge({ graph });
  const event = {
    runtimeSessionId: 'runtime_fixture', providerId: 'trace', providerVersion: '1', sessionEpoch: 1,
    kind: 'basic-block', payload: { address: '0x1010' }, completeness: 'bounded', observationMode: 'observed',
  };
  const unresolvedEvidence = bridge.eventToEvidence(event, { state: 'unresolved', targetEntityIds: [], evidenceIds: [] });
  assert.equal(bridge.linkClaim('claim:branch', unresolvedEvidence.id, 'contradicts', { state: 'unresolved', targetEntityIds: [] }).linked, false);
  assert.equal(graph.evaluateClaim('claim:branch').verdict, 'unknown');

  const resolution = { state: 'exact', method: 'verified-module-offset', binaryId, staticAddress: 0x1010n, targetEntityIds: ['function:fixture'], evidenceIds: ['evidence:mapping'] };
  const resolvedEvidence = bridge.eventToEvidence({ ...event, eventId: 'event:resolved' }, resolution);
  assert.equal(bridge.linkClaim('claim:branch', resolvedEvidence.id, 'contradicts', resolution).linked, true);
  assert.equal(graph.evaluateClaim('claim:branch').verdict, 'contradicted');
  const claim = graph.getNode('claim:branch');
  assert.equal(claim.semanticKind, 'branch-unreachable');
});
