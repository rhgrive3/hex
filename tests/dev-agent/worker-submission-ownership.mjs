import assert from 'node:assert/strict';
import { WorkerChatController } from '../../js/userscript/dev/worker-host/worker-chat-controller.js';
import { buildDevWorkerInstruction, DEV_WORKER_STATE } from '../../js/ai/dev/workers/contracts.js';

await testGraphEnvelopeDoesNotRequireRendererTextEquality();
console.log('Worker submission ownership regression passed');

async function testGraphEnvelopeDoesNotRequireRendererTextEquality() {
  let users = [];
  let observedPrompt = null;
  const adapter = {
    document: { visibilityState: 'visible', body: null, documentElement: null },
    conversation: () => null,
    userTurns: () => users.map((turn) => ({ ...turn })),
    conversationTurns: () => users.map((turn) => ({ ...turn })),
    assistantTurns: () => [],
    composer: () => ({}),
    isGenerating: () => false,
  };
  const router = {
    bind() {},
    async route() { return { conversation: null, isNew: true }; },
  };
  const turns = {
    run(prompt, { signal } = {}) {
      observedPrompt = prompt;
      // Reproduce the iPad/WebKit defect class fixed in the canonical turn
      // verifier: the owned user turn exists, but its renderer text is still a
      // hydration placeholder rather than the exact long prompt.
      users = [{ id: 'graph-user-1', text: '読み込み中…' }];
      return new Promise((resolve, reject) => {
        signal?.addEventListener?.('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    stopOwnedGeneration: () => false,
  };

  const controller = new WorkerChatController({ adapter, router, turns });
  await controller.createChat();
  const instruction = buildDevWorkerInstruction('Return exactly the number 2.');
  const submitted = await controller.send(instruction, { runId: 'graph-run', workerId: 'graph-worker' });

  assert.equal(submitted.submitted, true, 'one fresh owned user-turn identity must prove Worker submission');
  assert.equal(submitted.status, DEV_WORKER_STATE.WORKING);
  assert.equal(observedPrompt, instruction, 'Graph Worker envelope must reach the canonical turn controller unchanged');
  assert.notEqual(users[0].text, instruction, 'regression requires renderer text to differ from the owned prompt');

  await controller.stop();
  await Promise.resolve();
  assert.equal(controller.isActive(), false, 'test cleanup must settle the aborted synthetic turn');
}
