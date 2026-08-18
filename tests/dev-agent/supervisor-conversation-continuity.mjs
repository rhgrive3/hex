import assert from 'node:assert/strict';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { ChatGPTConversationRouter } from '../../js/userscript/chatgpt-adapter.js';
import { installChatGPTWebBridge } from '../../js/userscript/chatgpt-bridge.js';
import { SingleConversationWorkerCoordinator } from '../../js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';

await testDevSupervisorRunReusesSessionWithinHexConversation();
await testDelayedConversationIdentityStaysOnOneSupervisorChat();
await testUnboundSupervisorSurfaceNeverCreatesAnotherChat();
await testWorkerSendRefreshesLatestSupervisorAnchorAfterVirtualization();
await testWorkerFollowupRefreshesLatestSupervisorAnchorAfterVirtualization();
await testReleaseAdoptsAlreadyRoutedSupervisorSurfaceAfterVirtualization();
console.log('dev-agent supervisor conversation continuity: ok');

async function testDevSupervisorRunReusesSessionWithinHexConversation() {
  const settings = new DevAgentUiSettings({ storage: null });
  settings.setAgentProfile('dev');
  settings.setDecisionPolicy('yolo');

  let sequence = 0;
  const supervisor = new DevSupervisorV0({
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  const sessions = [];
  const bridge = {
    async request(_prompt, options = {}) {
      sessions.push(String(options.sessionKey || ''));
      return {
        text: JSON.stringify({ type: 'final', answer: 'done', completedTasks: [], remaining: [] }),
      };
    },
  };

  const firstEngine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  await firstEngine.run({ mode: 'agent', question: 'first YOLO turn', conversationId: 'hex-chat-a' });
  const firstRun = settings.lastRun;
  assert.equal(firstRun.status, 'COMPLETED');

  // Reconstruct the engine to ensure continuity is not accidentally dependent
  // on one engine object's private map. The settings-owned last Run is enough to
  // recover the same logical Supervisor session for the same Hex conversation.
  const secondEngine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  await secondEngine.run({ mode: 'agent', question: 'second YOLO turn', conversationId: 'hex-chat-a' });
  const secondRun = settings.lastRun;

  assert.notEqual(secondRun.runId, firstRun.runId, 'ordinary user messages still start a fresh DevRun');
  assert.notEqual(secondRun.workerId, firstRun.workerId, 'Worker identity remains Run-scoped');
  assert.equal(
    secondRun.supervisorSessionKey,
    firstRun.supervisorSessionKey,
    'the same Hex conversation must retain one ChatGPT Supervisor session across completed YOLO Runs',
  );
  assert.deepEqual(
    sessions.slice(0, 2),
    [firstRun.supervisorSessionKey, firstRun.supervisorSessionKey],
    'the bridge must receive the same sessionKey instead of routing the next message through New Chat',
  );

  await secondEngine.run({ mode: 'agent', question: 'different Hex chat', conversationId: 'hex-chat-b' });
  const thirdRun = settings.lastRun;
  assert.notEqual(
    thirdRun.supervisorSessionKey,
    firstRun.supervisorSessionKey,
    'different Hex conversations must not share a Supervisor ChatGPT session',
  );
}

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
  assert.deepEqual(harness.claimAnchor(), harness.turnC, 'worker.send must refresh the retained Supervisor anchor to turn C before handoff');
  const restore = navigation.at(-1);
  assert.equal(restore.conversation.id, supervisor.id);
  assert.equal(restore.options.continuityAnchor, null, 'Supervisor restore must not require one virtualizable historical turn to reappear');
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
  assert.deepEqual(harness.claimAnchor(), harness.turnC, 'worker.followup must retain the latest Supervisor turn C before leaving the Supervisor surface');
  const restore = navigation.at(-1);
  assert.equal(restore.conversation.id, supervisor.id);
  assert.equal(restore.options.continuityAnchor, null, 'Supervisor restore uses settled target-surface adoption instead of exact historical-turn hydration');
  assert.equal(controller.currentConversation().id, supervisor.id);
  coordinator.close();
}

async function testReleaseAdoptsAlreadyRoutedSupervisorSurfaceAfterVirtualization() {
  const harness = createWorkerAnchorHarness();
  const { coordinator, navigation } = harness;

  await coordinator.claim({ runId: 'release-anchor-run', workerId: 'release-anchor-worker' });
  harness.setSupervisorAnchors([harness.turnB]);
  harness.setStrictSupervisorUnavailable(true);

  const released = await coordinator.release({ workerId: 'release-anchor-worker' });

  assert.equal(released.claimed, false);
  assert.equal(released.role, 'available');
  assert.equal(navigation.length, 0, 'an already-routed Supervisor surface must be adopted in place instead of navigating again');
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
  let strictSupervisorUnavailable = false;
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
    adapter: {
      conversation() { return page ? { ...page } : null; },
      composer() { return {}; },
      isGenerating() { return false; },
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    currentConversation() {
      if (strictSupervisorUnavailable && page?.id === supervisor.id) return null;
      return page ? { ...page } : null;
    },
    adoptCurrentConversation() {
      if (page?.id !== supervisor.id) return null;
      return { ...page };
    },
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
    setStrictSupervisorUnavailable(value) { strictSupervisorUnavailable = !!value; },
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
