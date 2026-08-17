import assert from 'node:assert/strict';
import { ChatGPTConversationRouter } from '../../js/userscript/chatgpt-adapter.js';
import { installChatGPTWebBridge } from '../../js/userscript/chatgpt-bridge.js';
import { SingleConversationWorkerCoordinator } from '../../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';

await testDelayedConversationIdentityStaysOnOneSupervisorChat();
await testUnboundSupervisorSurfaceNeverCreatesAnotherChat();
await testWorkerSendRefreshesLatestSupervisorAnchorAfterVirtualization();
await testWorkerFollowupRefreshesLatestSupervisorAnchorAfterVirtualization();
console.log('dev-agent supervisor conversation continuity: ok');

async function testDelayedConversationIdentityStaysOnOneSupervisorChat() {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;

  let current = null;
  let turnsInDom = [];
  let newChatClicks = 0;
  let requestCount = 0;
  const adapter = fixtureAdapter({
    current: () => current,
    turns: () => turnsInDom,
    onNewChat() { newChatClicks++; current = null; turnsInDom = []; },
  });
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 100 });
  const models = fixtureModels();
  const turns = {
    async run(_prompt, options = {}) {
      requestCount++;
      if (requestCount === 1) {
        assert.equal(options.expectedConversation, null);
        assert.equal(options.newConversation, true);
        turnsInDom = [{ id: 'assistant-supervisor-1', text: '{"type":"tool","tool":"worker.claim"}' }];
        setTimeout(() => {
          current = { id: 'supervisor-chat', url: 'https://chatgpt.com/c/supervisor-chat' };
        }, 100);
        return supervisorResult('assistant-supervisor-1', null, 'worker.claim');
      }

      assert.equal(options.expectedConversation?.id, 'supervisor-chat', 'the second Supervisor decision must reuse the first ChatGPT conversation');
      assert.equal(options.newConversation, false);
      turnsInDom.push({ id: 'assistant-supervisor-2', text: '{"type":"tool","tool":"worker.create_chat"}' });
      return supervisorResult('assistant-supervisor-2', current, 'worker.create_chat');
    },
  };

  const bridge = installChatGPTWebBridge({ adapter, router, models, turns, lateBindingWaitMs: 1 });
  const first = await bridge.request('first supervisor decision', { sessionKey: 'supervisor-session' });
  assert.equal(first.conversation, null, 'fixture must reproduce a response settling before /c/<id> becomes observable');
  await delay(40);

  const second = await bridge.request('second supervisor decision', { sessionKey: 'supervisor-session' });
  assert.equal(second.conversation?.id, 'supervisor-chat');
  assert.equal(bridge.conversationFor('supervisor-session')?.id, 'supervisor-chat');
  assert.equal(newChatClicks, 0, 'late binding must prevent a second Supervisor Chat from being created');
  assert.equal(requestCount, 2);
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

async function testUnboundSupervisorSurfaceNeverCreatesAnotherChat() {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;

  let turnsInDom = [];
  let newChatClicks = 0;
  let requestCount = 0;
  const adapter = fixtureAdapter({
    current: () => null,
    turns: () => turnsInDom,
    onNewChat() { newChatClicks++; turnsInDom = []; },
  });
  const router = new ChatGPTConversationRouter(adapter, { storage: null, navigationTimeoutMs: 20 });
  const turns = {
    async run(_prompt, options = {}) {
      requestCount++;
      assert.equal(options.expectedConversation, null);
      assert.equal(options.newConversation, true);
      const id = `assistant-unbound-${requestCount}`;
      turnsInDom.push({ id, text: `supervisor-${requestCount}` });
      return supervisorResult(id, null, requestCount === 1 ? 'worker.claim' : 'worker.create_chat');
    },
  };
  const bridge = installChatGPTWebBridge({ adapter, router, models: fixtureModels(), turns, lateBindingWaitMs: 1 });

  await bridge.request('first supervisor decision', { sessionKey: 'unbound-supervisor-session' });
  assert.ok(turnsInDom.some((turn) => turn.id === 'assistant-unbound-1'));
  await bridge.request('second supervisor decision', { sessionKey: 'unbound-supervisor-session' });

  assert.equal(requestCount, 2);
  assert.equal(newChatClicks, 0, 'an exact prior Supervisor turn on the current unbound surface must suppress redundant New Chat');
  assert.ok(turnsInDom.some((turn) => turn.id === 'assistant-unbound-1'), 'continuity must preserve the first Supervisor turn');
  assert.ok(turnsInDom.some((turn) => turn.id === 'assistant-unbound-2'), 'the second decision must append to the same surface');
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

async function testWorkerSendRefreshesLatestSupervisorAnchorAfterVirtualization() {
  const harness = createWorkerAnchorHarness();
  const { coordinator, controller, supervisor, navigation } = harness;

  await coordinator.claim({ runId: 'send-anchor-run', workerId: 'send-anchor-worker' });
  assert.deepEqual(harness.claimAnchor(), harness.turnA, 'claim must initially capture Supervisor turn A');

  harness.setSupervisorAnchors([harness.turnB, harness.turnC]);
  const result = await coordinator.send({ workerId: 'send-anchor-worker', instruction: 'run delegated task' });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(controller.currentConversation().id, supervisor.id);
  const restore = navigation.at(-1);
  assert.equal(restore.conversation.id, supervisor.id);
  assert.deepEqual(
    restore.options.continuityAnchor,
    harness.turnC,
    'worker.send must refresh to the latest visible Supervisor turn C immediately before handoff, not stale claim-time turn A',
  );
  assert.notDeepEqual(restore.options.continuityAnchor, harness.turnA);
  coordinator.close();
}

async function testWorkerFollowupRefreshesLatestSupervisorAnchorAfterVirtualization() {
  const harness = createWorkerAnchorHarness();
  const { coordinator, controller, supervisor, worker, navigation } = harness;

  await coordinator.claim({ runId: 'followup-anchor-run', workerId: 'followup-anchor-worker' });
  assert.deepEqual(harness.claimAnchor(), harness.turnA, 'claim must initially capture Supervisor turn A');
  harness.seedWorkerConversation();
  harness.setSupervisorAnchors([harness.turnB, harness.turnC]);

  const result = await coordinator.followup({ workerId: 'followup-anchor-worker', text: 'continue delegated task' });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(navigation.at(-2).conversation.id, worker.id, 'followup must first return to the retained Worker conversation');
  assert.equal(navigation.at(-2).options.continuityAnchor, undefined, 'Worker return keeps strict remembered-history hydration');
  const restore = navigation.at(-1);
  assert.equal(restore.conversation.id, supervisor.id);
  assert.deepEqual(
    restore.options.continuityAnchor,
    harness.turnC,
    'worker.followup must refresh to latest visible Supervisor turn C before leaving the Supervisor surface',
  );
  assert.notDeepEqual(restore.options.continuityAnchor, harness.turnA);
  assert.equal(controller.currentConversation().id, supervisor.id);
  coordinator.close();
}

function createWorkerAnchorHarness() {
  const supervisor = { id: 'supervisor-anchor-chat', url: 'https://chatgpt.com/c/supervisor-anchor-chat' };
  const worker = { id: 'worker-anchor-chat', url: 'https://chatgpt.com/c/worker-anchor-chat' };
  const turnA = { id: 'supervisor-turn-a', text: 'Supervisor turn A: claim worker' };
  const turnB = { id: 'supervisor-turn-b', text: 'Supervisor turn B: create chat' };
  const turnC = { id: 'supervisor-turn-c', text: 'Supervisor turn C: send now' };
  let page = { ...supervisor };
  let supervisorAnchors = [{ ...turnA }];
  let workerConversation = null;
  let state = 'STARTING';
  let responseText = '';
  const listeners = new Set();
  const navigation = [];

  const emit = (kind, data = {}) => {
    for (const listener of listeners) listener({ kind, data, observedAt: '2026-08-18T00:00:00.000Z' });
  };
  const completeWorkerTurn = (text, context) => {
    workerConversation = { ...worker };
    page = { ...worker };
    state = 'WORKING';
    queueMicrotask(() => {
      responseText = text;
      state = 'COMPLETED';
      emit('completed', { ...context, responseText });
    });
    return { submitted: true, status: 'WORKING', chatgptConversationId: worker.id };
  };

  const controller = {
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    currentConversation() { return page ? { ...page } : null; },
    currentUserAnchors() {
      if (page?.id === supervisor.id) return supervisorAnchors.map((anchor) => ({ ...anchor }));
      return [{ id: 'worker-user-turn', text: 'worker task' }];
    },
    observe() { return { state, chatgptConversationId: workerConversation?.id || null }; },
    isActive() { return false; },
    workerConversation() { return workerConversation ? { ...workerConversation } : null; },
    async navigateToConversation(conversation, options = {}) {
      navigation.push({ conversation: { ...conversation }, options: { ...options } });
      page = { ...conversation };
      return { ...page };
    },
    async send(text, context) { return completeWorkerTurn(`send:${text}`, context); },
    async followup(text, context) { return completeWorkerTurn(`followup:${text}`, context); },
    result() {
      return {
        status: state,
        responseText,
        chatgptConversationId: workerConversation?.id || null,
        observedAt: '2026-08-18T00:00:00.000Z',
      };
    },
  };

  const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'same-ipad-tab' });
  return {
    coordinator,
    controller,
    supervisor,
    worker,
    turnA,
    turnB,
    turnC,
    navigation,
    setSupervisorAnchors(anchors) {
      supervisorAnchors = anchors.map((anchor) => ({ ...anchor }));
      page = { ...supervisor };
    },
    seedWorkerConversation() { workerConversation = { ...worker }; },
    claimAnchor() { return coordinator.claimed?.supervisorAnchor ? { ...coordinator.claimed.supervisorAnchor } : null; },
  };
}

function fixtureAdapter({ current, turns, onNewChat }) {
  return {
    conversation: current,
    composer: () => ({}),
    newChatButton: () => ({ click: onNewChat }),
    sidebarToggle: () => null,
    assistantTurns: turns,
    conversationTurns: turns,
    all: () => [],
    currentSelection: () => ({ model: null, reasoning: null, observedText: '' }),
    isGenerating: () => false,
    stop: () => false,
    errorState: () => null,
    location: { hostname: 'chatgpt.com' },
  };
}
function fixtureModels() { return { select: async () => ({ model: null, reasoning: null, observedText: '' }) }; }
function supervisorResult(turnId, conversation, tool) {
  return {
    text: `{"type":"tool","tool":"${tool}","arguments":{},"purpose":"test"}`,
    conversation,
    turnId,
  };
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
