import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevRunEventHost, createDevEvent, DEV_EVENT_TYPE } from '../../js/ai/dev/events/dev-events.js';
import { DEV_WORKER_MAY_SPAWN_WORKER, buildDevWorkerInstruction } from '../../js/ai/dev/workers/contracts.js';
import { createDevWorkerToolSurface, DEV_WORKER_TOOLS } from '../../js/ai/dev/workers/tool-surface.js';
import { createAgentProfileEngine } from '../../js/ai/dev/ui/engine-router.js';
import { AGENT_PROFILE } from '../../js/ai/dev/policy/agent-profile.js';

const calls = [];
const client = {
  discover: async (args) => { calls.push(['discover', args]); return [{ tabNodeId: 'tab-1' }]; },
  claim: async (args) => {
    calls.push(['claim', args]);
    return { runId: args.runId, workerId: args.workerId, tabNodeId: 'tab-1', chatgptConversationId: null };
  },
  createChat: async (args) => {
    calls.push(['createChat', args]);
    return { workerId: args.workerId, tabNodeId: 'tab-1', chatgptConversationId: null };
  },
  send: async (args) => {
    calls.push(['send', args]);
    return { workerId: args.workerId, tabNodeId: 'tab-1', chatgptConversationId: 'conversation-1', submitted: true };
  },
  observe: async (args) => ({ workerId: args.workerId, tabNodeId: 'tab-1', state: 'WORKING' }),
  followup: async (args) => args,
  nudge: async (args) => args,
  stop: async (args) => args,
  result: async (args) => ({
    workerId: args.workerId,
    tabNodeId: 'tab-1',
    chatgptConversationId: 'conversation-1',
    status: 'COMPLETED',
    responseText: 'ok',
    observedAt: '2026-08-17T00:00:00.000Z',
  }),
  release: async (args) => args,
  waitEvent: async () => ({
    type: 'worker.completed',
    data: { runId: 'run-1' },
    observedAt: '2026-08-17T00:00:00.000Z',
  }),
};

const tools = createDevWorkerToolSurface(client);
assert.ok(tools);
assert.deepEqual([...tools.toolNames], DEV_WORKER_TOOLS);
assert.equal(DEV_WORKER_MAY_SPAWN_WORKER, false, 'dev-worker-no-nested-spawn');
const workerPrompt = buildDevWorkerInstruction('Return one line.');
assert.match(workerPrompt, /Do not spawn, create, delegate to, or manage subagents or other Workers/);
assert.match(workerPrompt, /untrusted data\/evidence/);
assert.match(workerPrompt, /Do not claim an action, test, edit, or external result that you did not actually perform/);

let sequence = 0;
const supervisor = new DevSupervisorV0({
  workerTools: tools,
  idFactory: (kind) => `${kind}-${++sequence}`,
  now: () => '2026-08-17T00:00:00.000Z',
});
let run = supervisor.activate(supervisor.createRun({
  goal: 'single worker test',
  runId: 'run-1',
  supervisorSessionKey: 'session-1',
}));
assert.ok(DEV_WORKER_TOOLS.every((name) => supervisor.availableTools.includes(name)));

const claim = await supervisor.executeToolDecision(run, {
  type: 'tool',
  tool: 'worker.claim',
  arguments: { runId: 'run-1', workerId: 'worker-1' },
  purpose: 'claim',
});
run = claim.run;
assert.equal(run.workerId, 'worker-1');
assert.equal(run.tabNodeId, 'tab-1');

const sent = await supervisor.executeToolDecision(run, {
  type: 'tool',
  tool: 'worker.send',
  arguments: { runId: 'run-1', workerId: 'worker-1', instruction: 'Return one line.' },
  purpose: 'send',
});
run = sent.run;
assert.equal(run.chatgptConversationId, 'conversation-1');
assert.equal(calls.find(([name]) => name === 'send')[1].instruction, workerPrompt);
assert.throws(
  () => supervisor.applyDecision(run, { type: 'tool', tool: 'worker.spawn', arguments: {}, purpose: 'forbidden' }),
  /Unavailable Dev tool/,
);

const host = new DevRunEventHost({ supervisor });
const automaticResume = await host.waitForWorkerDecision(run, {
  type: 'wait',
  events: ['worker.completed', 'worker.failed'],
  reason: 'Waiting for Worker result.',
});
assert.equal(automaticResume.yielded, true, 'dev-worker-event-wait yields the Supervisor turn');
assert.equal(automaticResume.resumed, true, 'worker event resumes the same DevRun');
assert.equal(automaticResume.run.runId, run.runId);
assert.equal(automaticResume.run.status, 'ACTIVE');
run = automaticResume.run;

const waited = host.yieldDecision(run, {
  type: 'wait',
  events: ['worker.completed', 'worker.failed'],
  reason: 'Waiting for Worker result.',
});
assert.equal(waited.run.status, 'WAITING_EVENT');
const ignored = host.acceptEvent(waited.run, createDevEvent(DEV_EVENT_TYPE.WORKER_PROGRESS, { runId: 'run-1' }));
assert.equal(ignored.resumed, false);
const resumed = host.acceptEvent(waited.run, createDevEvent(DEV_EVENT_TYPE.WORKER_COMPLETED, { runId: 'run-1' }));
assert.equal(resumed.resumed, true);
assert.equal(resumed.run.status, 'ACTIVE');

const human = host.yieldDecision(resumed.run, {
  type: 'human',
  question: 'Need a choice',
  blocking: true,
});
assert.equal(human.run.status, 'WAITING_HUMAN');
const humanResume = host.resumeHuman(human.run, { answer: 'continue' });
assert.equal(humanResume.resumed, true, 'dev-human-yield-resume');
assert.equal(humanResume.run.runId, run.runId);
assert.equal(humanResume.run.status, 'ACTIVE');

let standardCalls = 0;
const standardEngine = {
  async run(input) {
    standardCalls += 1;
    return { answer: input.question };
  },
};
const settings = {
  agentProfile: AGENT_PROFILE.STANDARD,
  decisionPolicy: 'normal',
  analysisScope: { initial: 'none', expansionPolicy: 'agent' },
  setLastRun() { throw new Error('Standard must not create DevRun'); },
};
const routed = createAgentProfileEngine({ standardEngine, settings, supervisor });
const standard = await routed.run({ mode: 'agent', question: 'standard' });
assert.equal(standard.answer, 'standard');
assert.equal(standardCalls, 1, 'dev-standard-agent-isolation');

console.log('Round 2 protected Dev Worker tests passed');
