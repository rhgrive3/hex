import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../../js/userscript/dev/parent-rpc.js';

const { port1, port2 } = new MessageChannel();
let markStarted;
let remoteAborted = false;
const started = new Promise((resolve) => { markStarted = resolve; });

const server = createDevWorkerParentRpc({
  port: port1,
  runtime: {
    async discover(_args, { signal } = {}) {
      markStarted();
      await new Promise((resolve) => {
        signal?.addEventListener?.('abort', () => {
          remoteAborted = true;
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
await assert.rejects(
  pending,
  (error) => error?.code === 'transport-failure',
  'closing the RPC client must reject its local pending request',
);
for (let i = 0; i < 10 && !remoteAborted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(remoteAborted, true, 'closing the RPC client must cancel the remote in-flight operation');

server.close();
port1.close();
port2.close();
console.log('Dev parent RPC close cancellation: ok');
