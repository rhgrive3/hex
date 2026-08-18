import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { ProgressBudgetDevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-progress-budget.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../../js/ai/dev/policy/agent-profile.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

// R4 production exposes a frozen bridge; this pins the exact Proxy-invariant
// condition while also proving successful tools still replenish the budget.
await successfulToolsResetDecisionBudgetWithFrozenBridge();
console.log('Dev Supervisor progress budget: ok');

async function successfulToolsResetDecisionBudgetWithFrozenBridge() {
  const requests = [];
  const client = workerClient(async () => [{ tabNodeId: 'same-tab' }]);
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `progress-${kind}`,
    now: () => '2026-08-18T08:00:00.000Z',
  });
  const storage = { getItem: () => null, setItem() {} };
  const settings = new DevAgentUiSettings({ storage });
  settings.setAgentProfile(AGENT_PROFILE.DEV);

  let count = 0;
  const bridge = Object.freeze({
    async request(_prompt, options = {}) {
      count += 1;
      requests.push(options.sessionKey);
      if (count <= 5) {
        return { text: JSON.stringify({ type: 'tool', tool: 'worker.discover', arguments: {}, purpose: `progress-${count}` }) };
      }
      return { text: JSON.stringify({ type: 'final', answer: 'done', completedTasks: ['progress-budget'], remaining: [] }) };
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(bridge, 'request');
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.writable, false);

  const engine = new ProgressBudgetDevSupervisorEngineV0({ supervisor, settings, bridge, maxDecisions: 2 });
  const result = await engine.run({ goal: 'make repeated successful tool progress', conversationId: 'hex-progress' });

  assert.equal(result.answer, 'done');
  assert.equal(requests.length, 6, 'successful tool calls must provide a fresh decision window instead of exhausting maxDecisions');
  assert.equal(new Set(requests).size, 1, 'budget reset must retain the same Supervisor session');
  assert.equal(settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
}

function workerClient(discover) {
  const noop = async (args = {}) => args;
  return {
    enabled: true,
    discover,
    claim: noop,
    createChat: noop,
    send: noop,
    observe: noop,
    followup: noop,
    nudge: noop,
    stop: noop,
    result: noop,
    release: noop,
    waitEvent: async () => ({ type: 'worker.completed', data: {}, observedAt: '2026-08-18T08:00:00.000Z' }),
  };
}
