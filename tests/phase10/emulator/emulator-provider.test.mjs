import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

const binaryId = 'bin_sha256_' + 'de'.repeat(32);

class FakeEngine {
  constructor() { this.id = 'fake-engine'; this.version = '2.0'; this.deterministic = true; this.calls = 0; }
  descriptor() { return { id: this.id, version: this.version, architecture: 'arm64', environment: 'fixture', deterministic: true }; }
  async execute(input, options) {
    this.calls++;
    if (input.mode === 'unsupported') return { stop: { kind: 'unsupported' }, reason: 'fixture-op' };
    if (input.mode === 'fault') return { stop: { kind: 'fault' }, reason: 'unmapped' };
    if (input.mode === 'wait') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(String(options.signal.reason || 'cancelled'))); }, { once: true });
      });
    }
    return { stop: { kind: 'return' }, returnValue: input.value ?? 0, events: [{ type: 'call', payload: { target: 'helper' } }] };
  }
}

test('P10.9 emulator events and evidence are explicitly synthetic', async () => {
  const provider = new EmulatorProvider(new FakeEngine(), { id: 'emulator-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'emu:1' });
  const result = await session.facets.emulator.run({ value: 7 });
  assert.equal(result.termination, 'return');
  assert.equal(result.completeness, 'bounded');
  assert.equal(result.batch.events[0].observationMode, 'synthetic');
  assert.ok(result.evidence.length > 0);
  assert.equal(result.evidence[0].family, 'RuntimeEvidence');
  assert.equal(result.evidence[0].deterministic, false);
  await session.close();
});

test('P10.9 unsupported, fault and timeout remain distinct', async () => {
  const provider = new EmulatorProvider(new FakeEngine(), { id: 'emulator-termination-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'emu:2' });
  const unsupported = await session.facets.emulator.run({ mode: 'unsupported' });
  assert.equal(unsupported.termination, 'unsupported');
  assert.equal(unsupported.completeness, 'unsupported');
  const fault = await session.facets.emulator.run({ mode: 'fault' });
  assert.equal(fault.termination, 'fault');
  assert.equal(fault.completeness, 'bounded');
  const timeout = await session.facets.emulator.run({ mode: 'wait' }, { timeoutMs: 10 });
  assert.equal(timeout.termination, 'timeout');
  assert.equal(timeout.completeness, 'truncated');
  await session.close();
});

test('P10.9 deterministic replay re-executes the same bounded input', async () => {
  const engine = new FakeEngine();
  const provider = new EmulatorProvider(engine, { id: 'emulator-replay-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'emu:3' });
  const first = await session.facets.emulator.run({ value: 9 }, { maxSteps: 20, timeoutMs: 100 });
  const replay = await session.facets.emulator.replay(first.recording);
  assert.equal(replay.termination, first.termination);
  assert.equal(replay.raw.returnValue, first.raw.returnValue);
  assert.equal(engine.calls, 2);
  await session.close();
});

test('P10.9 emulator static attachment remains gated by an explicit resolution', async () => {
  const provider = new EmulatorProvider(new FakeEngine(), { id: 'emulator-identity-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: 'fixture', sessionNonce: 'emu:4' });
  const runtimeOnly = await session.facets.emulator.run({ value: 1 });
  assert.deepEqual(runtimeOnly.evidence[0].targetEntityIds, []);
  const resolved = await session.facets.emulator.run({ value: 1 }, { resolution: {
    runtimeSessionId: session.runtimeSessionId,
    state: 'exact',
    method: 'fixture',
    binaryId,
    staticAddress: 0x1000n,
    targetEntityIds: ['function:fixture'],
    evidenceIds: ['evidence:fixture-map'],
  } });
  assert.deepEqual(resolved.evidence[0].targetEntityIds, ['function:fixture']);
  await session.close();
});
