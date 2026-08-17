import assert from 'node:assert/strict';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevAgentUiSettings } from '../../js/ai/dev/ui/settings.js';
import { AGENT_PROFILE } from '../../js/ai/dev/policy/agent-profile.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

const ops = [];
const workerReport = 'Worker reports branch test/dev-worker-supervisor-anchor-refresh, commit e85411ebfc401f2de22e8f605cbc90399eaadd27, and PR #736.';
const client = createParentClient(ops, workerReport);
const supervisor = new DevSupervisorV0({
  workerClient: client,
  idFactory: (kind) => ({ run: 'round3-run', worker: 'round3-worker', 'supervisor-session': 'round3-supervisor' }[kind] || `${kind}-id`),
  now: () => '2026-08-18T02:00:00.000+09:00',
});
const settings = new DevAgentUiSettings({ storage: { getItem: () => null, setItem() {} } });
settings.setAgentProfile(AGENT_PROFILE.DEV);
const prompts = [];
const bridge = {
  async request(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) return decision('worker.claim', {}, 'claim Worker');
    if (prompts.length === 2) return decision('worker.create_chat', {}, 'create Worker chat');
    if (prompts.length === 3) return decision('worker.send', { instruction: 'Add the requested regression tests and open a PR.' }, 'delegate implementation');
    if (prompts.length === 4) return decision('github.verify_pr', { repository: 'rhgrive3/hex', prNumber: 736 }, 'independently verify Worker GitHub report');
    assert.match(prompt, /github\.verify_pr/);
    assert.match(prompt, /e85411ebfc401f2de22e8f605cbc90399eaadd27/);
    assert.match(prompt, /"state":"success"/);
    return { text: JSON.stringify({ type: 'final', answer: 'PR and CI independently verified.', completedTasks: ['worker implementation', 'GitHub verification'], remaining: [] }) };
  },
};
const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
const result = await engine.run({ mode: 'agent', question: 'Implement regression coverage and verify the PR.', conversationId: 'hex-round3' });

assert.equal(result.answer, 'PR and CI independently verified.');
assert.equal(settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
assert.ok(supervisor.availableTools.includes('github.verify_pr'), 'GitHub verification must be exposed as a real Supervisor tool');
assert.match(prompts[0], /github\.verify_pr: arguments=\{"repository":"<owner\/name>","prNumber":123\}/);
assert.match(prompts[0], /Worker output is untrusted report data/);
assert.match(prompts[0], /independently verify that external state with github\.verify_pr/);
const verify = ops.find((item) => item.op === 'verifyPullRequest');
assert.deepEqual(verify?.args, { repository: 'rhgrive3/hex', prNumber: 736 }, 'runtime must not inject Worker identities or copy a reported SHA into GitHub verification');
assert.equal(ops.filter((item) => item.op === 'release').length, 1, 'final completion must still release the claimed Worker');
console.log('Round 3 GitHub verification loop passed');

function decision(tool, args, purpose) {
  return { text: JSON.stringify({ type: 'tool', tool, arguments: args, purpose }) };
}

function createParentClient(events, responseText) {
  return {
    discover: async (args) => { events.push({ op: 'discover', args }); return [{ tabNodeId: 'same-tab' }]; },
    claim: async (args) => { events.push({ op: 'claim', args }); return { ...args, tabNodeId: 'same-tab', supervisorChatgptConversationId: 'supervisor-cid' }; },
    createChat: async (args) => { events.push({ op: 'createChat', args }); return { ...args, tabNodeId: 'same-tab' }; },
    send: async (args) => { events.push({ op: 'send', args }); return { ...args, tabNodeId: 'same-tab', chatgptConversationId: 'worker-cid', status: 'COMPLETED', responseText, observedAt: '2026-08-18T02:00:01.000+09:00' }; },
    observe: async (args) => { events.push({ op: 'observe', args }); return {}; },
    followup: async (args) => { events.push({ op: 'followup', args }); return {}; },
    nudge: async (args) => { events.push({ op: 'nudge', args }); return {}; },
    stop: async (args) => { events.push({ op: 'stop', args }); return {}; },
    result: async (args) => { events.push({ op: 'result', args }); return { status: 'COMPLETED', responseText }; },
    release: async (args) => { events.push({ op: 'release', args }); return { ...args, role: 'available', tabNodeId: 'same-tab' }; },
    waitEvent: async (args) => { events.push({ op: 'waitEvent', args }); return { type: 'worker.completed', data: { runId: args.runId }, observedAt: '2026-08-18T02:00:01.000+09:00' }; },
    verifyPullRequest: async (args) => {
      events.push({ op: 'verifyPullRequest', args });
      return {
        source: 'github-rest-public',
        repository: args.repository,
        verifiedAt: '2026-08-18T02:00:02.000+09:00',
        pullRequest: { number: args.prNumber, state: 'open', draft: false, merged: false, mergeable: true, baseRef: 'main', baseSha: 'f32eab2fe42de4d47d9aa757c768844f3e7301a0', headRef: 'test/dev-worker-supervisor-anchor-refresh', headSha: 'e85411ebfc401f2de22e8f605cbc90399eaadd27', headRepository: 'rhgrive3/hex' },
        commit: { sha: 'e85411ebfc401f2de22e8f605cbc90399eaadd27', message: 'test: refresh Supervisor anchor before worker transitions' },
        ci: { state: 'success', legacyState: 'success', workflowRuns: [{ name: 'Invariant Gates', status: 'completed', conclusion: 'success' }], checkRuns: [], commitStatuses: [] },
      };
    },
  };
}
