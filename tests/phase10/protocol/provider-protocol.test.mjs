import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRemotePacket } from '../../../js/debug/remote-protocol.js';
import {
  RUNTIME_PROVIDER_PROTOCOL,
  RUNTIME_PROVIDER_PROTOCOL_VERSION,
  RuntimeProviderProtocolClient,
  createProviderHello,
  negotiateProviderHello,
  validateProviderPacket,
} from '../../../js/runtime/provider-protocol.js';

function packet(type, extra = {}) {
  return {
    protocol: RUNTIME_PROVIDER_PROTOCOL,
    version: RUNTIME_PROVIDER_PROTOCOL_VERSION,
    type,
    ...extra,
  };
}

class FakeTransport {
  constructor() { this.sent = []; this.listener = null; }
  send(value) { this.sent.push(value); }
  onMessage(listener) { this.listener = listener; return () => { if (this.listener === listener) this.listener = null; }; }
  receive(value) { return this.listener?.(value); }
}

test('P10.6 provider negotiation is additive and debugger protocol v1 remains valid', () => {
  assert.equal(validateRemotePacket({ type: 'hello', version: 1 }).version, 1);
  const local = { id: 'local-provider', version: '1', facets: ['debugger', 'trace'], capabilities: {} };
  const hello = createProviderHello(local, { architecture: 'arm64', platform: 'darwin' });
  assert.equal(hello.protocol, RUNTIME_PROVIDER_PROTOCOL);
  const negotiated = negotiateProviderHello(local, {
    ...hello,
    providerId: 'remote-provider',
    providerVersion: '9',
    facets: ['trace', 'instrumentation'],
  });
  assert.deepEqual(negotiated.facets, ['trace']);
  assert.equal(negotiated.remoteProviderId, 'remote-provider');
});

test('P10.6 downgrade, protocol confusion, wrong facet and host commands fail closed', () => {
  assert.throws(() => validateProviderPacket({ ...packet('hello'), version: 0, providerId: 'x', providerVersion: '1', facets: [] }), /protocol/i);
  assert.throws(() => validateProviderPacket({ ...packet('hello'), protocol: 'debugger', providerId: 'x', providerVersion: '1', facets: [] }), /protocol/i);
  assert.throws(() => validateProviderPacket(packet('request', { id: 1, epoch: 1, facet: 'trace', method: 'debugger.readMemory' })), /does not belong|protocol/i);
  assert.throws(() => validateProviderPacket(packet('request', { id: 1, epoch: 1, facet: 'debugger', method: 'debugger.exec' })), /prohibited|permission/i);
  assert.throws(() => validateProviderPacket(packet('request', { id: 1, epoch: 1, facet: 'debugger', method: 'readMemory' })), /namespace|protocol/i);
});

test('P10.6 event batches retain canonical completeness and epoch', () => {
  const validated = validateProviderPacket(packet('event-batch', {
    epoch: 2,
    facet: 'trace',
    batch: {
      runtimeSessionId: 'runtime_fixture',
      providerId: 'remote-provider',
      sessionEpoch: 2,
      completeness: 'truncated',
      dropped: 1,
      events: [{
        eventId: 'event:gap',
        runtimeSessionId: 'runtime_fixture',
        providerId: 'remote-provider',
        providerVersion: '1',
        sessionEpoch: 2,
        kind: 'dropped-events',
        payload: { dropped: 1 },
        completeness: 'truncated',
      }],
    },
  }));
  assert.equal(validated.epoch, 2);
  assert.equal(validated.batch.completeness, 'truncated');
  assert.equal(validated.batch.events[0].kind, 'dropped-events');
});

test('P10.6 request/response path is bounded and exact-epoch', async () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000, maxPending: 2 });
  const pending = client.request('debugger.readMemory', { address: 0x1000n, size: 4 }, { facet: 'debugger' });
  assert.equal(transport.sent.length, 1);
  const request = transport.sent[0];
  assert.equal(request.type, 'request');
  assert.equal(request.epoch, 1);
  transport.receive(packet('response', { id: request.id, epoch: 1, result: { bytes: new Uint8Array([1, 2, 3, 4]) } }));
  const result = await pending;
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  client.close();
});

test('P10.6 cancellation and epoch changes cannot publish stale provider responses', async () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs: 1000 });
  const controller = new AbortController();
  const cancelled = client.request('trace.replay', {}, { facet: 'trace', signal: controller.signal });
  const first = transport.sent[0];
  controller.abort('fixture');
  await assert.rejects(cancelled, /cancelled/i);
  assert.ok(transport.sent.some((item) => item.type === 'cancel' && item.id === first.id));

  const stale = client.request('debugger.readRegisters', {}, { facet: 'debugger' });
  const second = transport.sent.findLast((item) => item.type === 'request');
  client.setEpoch(2);
  await assert.rejects(stale, /epoch|cancelled/i);
  assert.equal(transport.receive(packet('response', { id: second.id, epoch: 1, result: { pc: 1 } })), false);
  client.close();
});

test('P10.6 provider event listeners reject stale epochs', () => {
  const transport = new FakeTransport();
  const client = new RuntimeProviderProtocolClient(transport);
  let seen = 0;
  client.onEvent(() => seen++);
  const makeBatch = (epoch) => packet('event-batch', {
    epoch,
    facet: 'trace',
    batch: {
      runtimeSessionId: 'runtime_fixture',
      providerId: 'remote-provider',
      sessionEpoch: epoch,
      events: [],
      completeness: 'bounded',
      dropped: 0,
    },
  });
  assert.equal(transport.receive(makeBatch(1)), true);
  client.setEpoch(2);
  assert.equal(transport.receive(makeBatch(1)), false);
  assert.equal(transport.receive(makeBatch(2)), true);
  assert.equal(seen, 2);
  client.close();
});
