import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../../js/userscript/dev/parent-rpc.js';
import { startParentDevWorkerRuntime } from '../../js/userscript/dev/parent-worker-runtime.js';

await testRpcCloseSendsRemoteCancelOnce();
await testProductionClaimDoesNotSurviveRpcClose();
console.log('Dev parent RPC close cancellation: ok');

async function testRpcCloseSendsRemoteCancelOnce() {
  const { port1, port2 } = new MessageChannel();
  let markStarted;
  let remoteAbortCount = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });

  const server = createDevWorkerParentRpc({
    port: port1,
    runtime: {
      async discover(_args, { signal } = {}) {
        markStarted();
        await new Promise((resolve) => {
          signal?.addEventListener?.('abort', () => {
            remoteAbortCount += 1;
            resolve();
          }, { once: true });
        });
        return [];
      },
    },
  });
  const client = createDevWorkerParentRpcClient({ port: port2, timeoutMs: 60000 });
  const pending = client.discover({});
  await started;
  client.close();
  client.close();
  await assert.rejects(
    pending,
    (error) => error?.code === 'transport-failure',
    'closing the RPC client must reject its local pending request',
  );
  for (let i = 0; i < 10 && remoteAbortCount === 0; i++) await tick();
  assert.equal(remoteAbortCount, 1, 'closing the RPC client must cancel each remote in-flight operation exactly once');

  server.close();
  port1.close();
  port2.close();
}

async function testProductionClaimDoesNotSurviveRpcClose() {
  const supervisor = Object.freeze({ id: 'c-supervisor', url: 'https://chatgpt.com/c/supervisor' });
  let claimReady = false;
  let releaseCount = 0;
  const controller = {
    adapter: { document: fakeDocument(), location: { href: supervisor.url } },
    on() { return () => {}; },
    adoptCurrentConversation() { return claimReady ? supervisor : null; },
    currentConversation() { return claimReady ? supervisor : null; },
    currentUserAnchors() { return [{ id: 'turn-supervisor', text: 'supervisor' }]; },
    observe() { return { state: 'available' }; },
  };
  const runtime = await startParentDevWorkerRuntime({
    controller,
    document: controller.adapter.document,
    location: controller.adapter.location,
  });
  assert.equal(runtime.enabled, true);
  const originalRelease = runtime.coordinator.release.bind(runtime.coordinator);
  runtime.coordinator.release = async (...args) => {
    releaseCount += 1;
    return originalRelease(...args);
  };

  const { port1, port2 } = new MessageChannel();
  const server = createDevWorkerParentRpc({ port: port1, runtime });
  const client = createDevWorkerParentRpcClient({ port: port2, timeoutMs: 60000 });
  const pending = client.claim({ runId: 'run-close-cancel', workerId: 'worker-close-cancel' });
  await tick();
  client.close();
  await assert.rejects(pending, (error) => error?.code === 'transport-failure');

  claimReady = true;
  for (let i = 0; i < 20 && releaseCount === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(releaseCount, 1, 'a production claim that finishes after RPC close must be released exactly once');
  assert.equal(runtime.coordinator.advertisement().claimed, false, 'RPC close must not leave an orphaned production Worker claim');

  server.close();
  runtime.close();
  port1.close();
  port2.close();
}

function fakeDocument() {
  return {
    title: 'ChatGPT',
    scripts: [],
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }
