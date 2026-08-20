import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeSessionId } from '../../../js/core/identity/index.js';
import { runtimeEvidenceToCanonical } from '../../../js/core/evidence/compat.js';
import { DEBUG_PROTOCOL_VERSION, DebugAdapter } from '../../../js/debug/adapter.js';
import { validateRemotePacket } from '../../../js/debug/remote-protocol.js';
import { DebugSession } from '../../../js/runtime/session.js';
import { RuntimeAnalysisPlatform } from '../../../js/runtime/index.js';

class BaselineAdapter extends DebugAdapter {
  constructor() {
    super({
      id: 'phase10-baseline-adapter',
      kind: 'phase10-baseline',
      capabilities: { modules: true, threads: true },
    });
  }
  async getModules() { return [{ name: 'main', base: 0x1000n, size: 0x1000 }]; }
  async getThreads() { return [{ id: 'thread:1' }]; }
}

test('P10.0 pins canonical RuntimeSessionId creation', () => {
  const id = createRuntimeSessionId({
    binaryId: 'bin_sha256_' + '11'.repeat(32),
    provider: 'phase10-baseline',
    targetIdentity: { process: 'fixture:1' },
    sessionNonce: 'fixture-session',
  });
  assert.match(id, /^runtime_[0-9a-f]{32}$/);
  assert.equal(id, createRuntimeSessionId({
    binaryId: 'bin_sha256_' + '11'.repeat(32),
    provider: 'phase10-baseline',
    targetIdentity: { process: 'fixture:1' },
    sessionNonce: 'fixture-session',
  }));
});

test('P10.0 pins DebugSession epoch cancellation and stale-event rejection', async () => {
  const adapter = new BaselineAdapter();
  const session = new DebugSession(adapter, { binaryHash: 'fixture:binary' });
  await session.connect();
  assert.equal(session.connected, true);
  assert.equal(session.modules.length, 1);
  assert.equal(session.threads.length, 1);

  const controller = session.controller();
  const oldEpoch = session.epoch;
  assert.equal(session.acceptEvent({ epoch: oldEpoch, type: 'branch', address: 0x1000n }), true);
  session.newEpoch();
  assert.equal(controller.signal.aborted, true);
  assert.equal(session.acceptEvent({ epoch: oldEpoch, type: 'branch', address: 0x1004n }), false);
  await session.disconnect();
});

test('P10.0 pins debugger protocol v1 validation', () => {
  assert.equal(DEBUG_PROTOCOL_VERSION, 1);
  assert.equal(validateRemotePacket({ type: 'hello', version: 1 }).version, 1);
  assert.throws(() => validateRemotePacket({ type: 'hello', version: 2 }), /protocol version|unsupported remote protocol/i);
  assert.throws(() => validateRemotePacket({ type: 'request', version: 1, epoch: 0, id: 1, method: 'exec' }), /prohibited|blocked/i);
});

test('P10.0 pins runtime evidence canonical conversion without minting deterministic truth', () => {
  const canonical = runtimeEvidenceToCanonical({
    id: 'runtime-evidence:fixture',
    kind: 'trace',
    binaryHash: 'fixture:binary',
    sessionId: 'debug:fixture',
    observationComplete: false,
    verdict: 'supported',
    confidence: 0.7,
  });
  assert.equal(canonical.family, 'RuntimeEvidence');
  assert.equal(canonical.completeness, 'truncated');
  assert.equal(canonical.deterministic, false);
});

test('P10.0 pins cross-version replay ambiguity rejection before execution', async () => {
  const platform = new RuntimeAnalysisPlatform({ symbolic: false });
  const adapter = new BaselineAdapter();
  platform.registerAdapter('fixture', adapter);
  await platform.startSession({ adapter: 'fixture', binaryHash: 'target-binary' });

  const result = await platform.replayExperiment({
    binaryHash: 'source-binary',
    experiment: {
      id: 'fixture-replay',
      functionAddress: 0x1000n,
      binaryHash: 'source-binary',
      cases: [],
    },
  }, {
    resolveFunction: async () => ({
      accepted: false,
      address: 0x2000n,
      identityConfidence: 0.99,
      ambiguityMargin: 0.5,
    }),
  });

  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'function-re-resolution-ambiguous');
  await platform.sessions.close(platform.currentSession().id);
});
