import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { createAgentProfileEngine } from '../../js/ai/dev/ui/engine-router.js';
import { AGENT_PROFILE } from '../../js/ai/dev/policy/agent-profile.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { SingleConversationWorkerCoordinator } from '../../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';

await testSingleTabWorkerLoopReleasesClaim();
await testRuntimeRejectsWorkerIdentityOverride();
await testWaitingHumanResumesSameSupervisorRun();
await testSupervisorRestoreAcceptsPartialHistoryHydration();
console.log('Round 2 single-tab Supervisor loop passed');

async function testSingleTabWorkerLoopReleasesClaim() {
  const ids = new Map();
  const idFactory = (kind) => { const next = (ids.get(kind) || 0) + 1; ids.set(kind, next); return `${kind}-${next}`; };
  const calls = [];
  const workerOps = [];
  const workerClient = createWorkerClient(workerOps);
  const supervisor = new DevSupervisorV0({ workerClient, idFactory, now: () => '2026-08-17T00:00:00.000Z' });
  const settings = devSettings();
  const bridge = {
    async request(prompt) {
      calls.push(prompt);
      const n = calls.length;
      // Real-device regression: the model is allowed to omit runtime-owned
      // runId/workerId. The runtime must inject the active DevRun identities.
      if (n === 1) return { text: JSON.stringify({ type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim logical Worker' }) };
      if (n === 2) return { text: JSON.stringify({ type: 'tool', tool: 'worker.create_chat', arguments: {}, purpose: 'create Worker conversation' }) };
      if (n === 3) return { text: JSON.stringify({ type: 'tool', tool: 'worker.send', arguments: { instruction: 'Return one line.' }, purpose: 'delegate task' }) };
      return { text: JSON.stringify({ type: 'final', answer: 'worker answer accepted', completedTasks: ['delegated'], remaining: [] }) };
    },
  };
  const standardEngine = { run: async () => ({ answer: 'standard' }) };
  const engine = createAgentProfileEngine({
    standardEngine,
    settings,
    supervisor,
    devEngine: new DevSupervisorEngineV0({ supervisor, settings, bridge }),
  });
  const result = await engine.run({ mode: 'agent', question: 'delegate once', conversationId: 'hex-cid', model: 'chatgpt-web/sol', reasoning: 'high' });
  assert.equal(result.answer, 'worker answer accepted');
  assert.equal(calls.length, 4, 'Supervisor must continue after Worker result in the restored conversation');
  assert.match(calls[0], /single-tab/i);
  assert.match(calls[0], /runtime-owned identities/i);
  assert.match(calls[0], /worker\.send: arguments=\{\"instruction\"/);
  assert.match(calls[2], /worker.send/);
  assert.equal(settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
  assert.equal(settings.lastRun.workerId, 'worker-1');
  assert.deepEqual(workerOps.find((item) => item.op === 'claim')?.args, { runId: 'run-1', workerId: 'worker-1' });
  assert.deepEqual(workerOps.find((item) => item.op === 'createChat')?.args, { runId: 'run-1', workerId: 'worker-1' });
  const send = workerOps.find((item) => item.op === 'send')?.args;
  assert.equal(send.runId, 'run-1');
  assert.equal(send.workerId, 'worker-1');
  assert.match(send.instruction, /ASSIGNED TASK\nReturn one line\./);
  assert.equal(workerOps.filter((item) => item.op === 'release').length, 1, 'final completion must release the logical Worker claim');
  assert.deepEqual(workerOps.find((item) => item.op === 'release')?.args, { runId: 'run-1', workerId: 'worker-1' });
}

async function testRuntimeRejectsWorkerIdentityOverride() {
  const ops = [];
  const supervisor = new DevSupervisorV0({
    workerClient: createWorkerClient(ops),
    idFactory: (kind) => ({ run: 'authoritative-run', worker: 'authoritative-worker', 'supervisor-session': 'authoritative-supervisor' }[kind] || `${kind}-id`),
    now: () => '2026-08-17T00:00:00.000Z',
  });
  let run = supervisor.createRun({ goal: 'test identity ownership' });
  run = supervisor.activate(run);
  await assert.rejects(
    () => supervisor.executeToolDecision(run, {
      type: 'tool',
      tool: 'worker.claim',
      arguments: { runId: 'fabricated-run', workerId: 'authoritative-worker' },
      purpose: 'attempt wrong identity',
    }),
    /may not override runtime-owned runId/,
  );
  assert.equal(ops.length, 0, 'conflicting model-supplied identity must be rejected before reaching Worker runtime');
}

async function testWaitingHumanResumesSameSupervisorRun() {
  const fixed = {
    run: 'human-run',
    'supervisor-session': 'human-supervisor-session',
    worker: 'human-worker',
  };
  const idFactory = (kind) => fixed[kind] || `${kind}-id`;
  const supervisor = new DevSupervisorV0({ workerClient: createWorkerClient([]), idFactory, now: () => '2026-08-17T00:00:00.000Z' });
  const settings = devSettings();
  const requests = [];
  const bridge = {
    async request(prompt, options) {
      requests.push({ prompt, options });
      if (requests.length === 1) {
        return { text: JSON.stringify({ type: 'human', question: 'Proceed with the material decision?', blocking: true }) };
      }
      return { text: JSON.stringify({ type: 'final', answer: 'continued after human response', completedTasks: [], remaining: [] }) };
    },
  };
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  const first = await engine.run({ mode: 'agent', question: 'Need a material decision', conversationId: 'hex-human' });
  assert.equal(first.devRunId, 'human-run');
  assert.equal(settings.lastRun.status, DEV_RUN_STATUS.WAITING_HUMAN);
  assert.equal(requests[0].options.sessionKey, 'human-supervisor-session');

  const second = await engine.run({ mode: 'agent', question: 'yes, proceed', conversationId: 'hex-human' });
  assert.equal(second.devRunId, 'human-run', 'human response must resume the same DevRun');
  assert.equal(second.answer, 'continued after human response');
  assert.equal(settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
  assert.equal(requests[1].options.sessionKey, 'human-supervisor-session', 'human resume must retain the same Supervisor ChatGPT conversation');
  assert.match(requests[1].prompt, /human-response/);
  assert.match(requests[1].prompt, /yes, proceed/);
}

async function testSupervisorRestoreAcceptsPartialHistoryHydration() {
  const supervisor = { id: 'supervisor-cid', url: 'https://chatgpt.com/c/supervisor-cid' };
  const worker = { id: 'worker-cid', url: 'https://chatgpt.com/c/worker-cid' };
  const anchors = [
    { id: 'supervisor-user-1', text: 'first decision' },
    { id: 'supervisor-user-2', text: 'second decision' },
    { id: 'supervisor-user-latest', text: 'delegate to worker' },
  ];
  let page = supervisor;
  let hydratedWith = null;
  let routedKey = null;
  const listeners = new Set();
  const controller = {
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    currentConversation() { return page; },
    currentUserAnchors() { return page.id === supervisor.id ? anchors : [{ id: 'worker-user', text: 'worker task' }]; },
    observe() { return { state: 'QUIET' }; },
    isActive() { return false; },
    workerConversation() { return worker; },
    router: {
      bind(key, expected) { routedKey = key; assert.equal(expected.id, supervisor.id); },
      async route() { page = supervisor; return { conversation: supervisor, isNew: false }; },
    },
    async waitForConversationHydration(expected, expectedAnchors) {
      assert.equal(expected.id, supervisor.id);
      hydratedWith = expectedAnchors;
      return supervisor;
    },
  };
  const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'same-tab' });
  await coordinator.claim({ runId: 'partial-hydration-run', workerId: 'worker-1' });
  page = worker;

  const restored = await coordinator.restoreSupervisor();
  assert.equal(restored.id, supervisor.id);
  assert.equal(routedKey, 'dev-supervisor-return:partial-hydration-run');
  assert.deepEqual(
    hydratedWith,
    [anchors.at(-1)],
    'Supervisor restore must require only the latest pre-delegation continuity anchor, not every virtualized historical turn',
  );
  coordinator.close();
}

function createWorkerClient(ops) {
  return {
    discover: async (args) => { ops.push({ op: 'discover', args }); return [{ tabNodeId: 'same-tab' }]; },
    claim: async (args) => { ops.push({ op: 'claim', args }); return { ...args, tabNodeId: 'same-tab', supervisorChatgptConversationId: 'supervisor-cid' }; },
    createChat: async (args) => { ops.push({ op: 'createChat', args }); return { ...args, tabNodeId: 'same-tab' }; },
    send: async (args) => { ops.push({ op: 'send', args }); return { runId: args.runId, workerId: args.workerId, tabNodeId: 'same-tab', chatgptConversationId: 'worker-cid', status: 'COMPLETED', responseText: 'worker answer', observedAt: '2026-08-17T00:00:00.000Z' }; },
    observe: async (args) => { ops.push({ op: 'observe', args }); return {}; },
    followup: async (args) => { ops.push({ op: 'followup', args }); return {}; },
    nudge: async (args) => { ops.push({ op: 'nudge', args }); return {}; },
    stop: async (args) => { ops.push({ op: 'stop', args }); return {}; },
    result: async (args) => { ops.push({ op: 'result', args }); return { status: 'COMPLETED', responseText: 'worker answer' }; },
    release: async (args) => { ops.push({ op: 'release', args }); return { ...args, role: 'available', tabNodeId: 'same-tab' }; },
    waitEvent: async (args) => { ops.push({ op: 'waitEvent', args }); return { type: 'worker.completed', data: { runId: args.runId }, observedAt: '2026-08-17T00:00:00.000Z' }; },
  };
}

function devSettings() {
  const storage = { getItem: () => null, setItem() {} };
  const settings = new DevAgentUiSettings({ storage });
  settings.setAgentProfile(AGENT_PROFILE.DEV);
  return settings;
}
