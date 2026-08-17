import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { createAgentProfileEngine } from '../../js/ai/dev/ui/engine-router.js';
import { AGENT_PROFILE } from '../../js/ai/dev/policy/agent-profile.js';

const ids = new Map();
const idFactory = (kind) => { const next = (ids.get(kind) || 0) + 1; ids.set(kind, next); return `${kind}-${next}`; };
const calls = [];
const workerClient = {
  discover: async () => [{ tabNodeId: 'same-tab' }],
  claim: async (args) => ({ ...args, tabNodeId: 'same-tab', supervisorChatgptConversationId: 'supervisor-cid' }),
  createChat: async (args) => ({ ...args, tabNodeId: 'same-tab' }),
  send: async (args) => ({ runId: args.runId, workerId: args.workerId, tabNodeId: 'same-tab', chatgptConversationId: 'worker-cid', status: 'COMPLETED', responseText: 'worker answer', observedAt: '2026-08-17T00:00:00.000Z' }),
  observe: async () => ({}), followup: async () => ({}), nudge: async () => ({}), stop: async () => ({}),
  result: async () => ({ status: 'COMPLETED', responseText: 'worker answer' }), release: async () => ({ role: 'available' }),
  waitEvent: async () => ({ type: 'worker.completed', data: { runId: 'run-1' }, observedAt: '2026-08-17T00:00:00.000Z' }),
};
const supervisor = new DevSupervisorV0({ workerClient, idFactory, now: () => '2026-08-17T00:00:00.000Z' });
const storage = { getItem: () => null, setItem() {} };
const settings = new DevAgentUiSettings({ storage });
settings.setAgentProfile(AGENT_PROFILE.DEV);
const bridge = {
  async request(prompt) {
    calls.push(prompt);
    const n = calls.length;
    if (n === 1) return { text: JSON.stringify({ type: 'tool', tool: 'worker.claim', arguments: { runId: 'run-1', workerId: 'worker-1' }, purpose: 'claim logical Worker' }) };
    if (n === 2) return { text: JSON.stringify({ type: 'tool', tool: 'worker.create_chat', arguments: { runId: 'run-1', workerId: 'worker-1' }, purpose: 'create Worker conversation' }) };
    if (n === 3) return { text: JSON.stringify({ type: 'tool', tool: 'worker.send', arguments: { runId: 'run-1', workerId: 'worker-1', instruction: 'Return one line.' }, purpose: 'delegate task' }) };
    return { text: JSON.stringify({ type: 'final', answer: 'worker answer accepted', completedTasks: ['delegated'], remaining: [] }) };
  },
};
const standardEngine = { run: async () => ({ answer: 'standard' }) };
const engine = createAgentProfileEngine({ standardEngine, settings, supervisor, devEngine: new (await import('../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js')).DevSupervisorEngineV0({ supervisor, settings, bridge }) });
const result = await engine.run({ mode: 'agent', question: 'delegate once', conversationId: 'hex-cid', model: 'chatgpt-web/sol', reasoning: 'high' });
assert.equal(result.answer, 'worker answer accepted');
assert.equal(calls.length, 4, 'Supervisor must continue after Worker result in the restored conversation');
assert.match(calls[0], /single-tab/i);
assert.match(calls[2], /worker.send/);
assert.equal(settings.lastRun.status, 'COMPLETED');
assert.equal(settings.lastRun.workerId, 'worker-1');
console.log('Round 2 single-tab Supervisor loop passed');
