import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';
import { DEV_ADMIN_TOOL } from '../../js/ai/dev/admin/tool-surface.js';
import { buildDevSupervisorPrompt } from '../../js/ai/dev/protocol/dev-supervisor-prompt.js';
import {
  DEV_BOOTSTRAP_EXTENSION,
  DEV_BOOTSTRAP_EXTENSION_VERSION,
  DevExtensionLoader,
} from '../../js/ai/dev/bootstrap/dev-bootstrap-gate.js';
import {
  DEV_RUNTIME_ACTIVATION_TOOL,
  DEV_RUNTIME_IDENTITY_TOOL,
  DEV_SELF_UPDATE_ACTION,
  DEV_SELF_UPDATE_HISTORY_KIND,
  DEV_SELF_UPDATE_REJECTION_CODE,
  DEV_SELF_UPDATE_STATE,
  DevSelfUpdateGate,
} from '../../js/ai/dev/bootstrap/self-update-gate.js';

const OLD_COMMIT = 'a'.repeat(40);
const NEW_COMMIT = 'b'.repeat(40);
const OLD_BUILD = '1'.repeat(24);
const NEW_BUILD = '2'.repeat(24);

testGateUnit();
testTeardownToolsAreNeverGated();
testWithdrawingAWrongExpectation();
await testIdentityToolWorksWithoutParentSupport();
testAdminSurfaceExposesIdentity();
testPromptTeachesTheGate();
await testStaleRuntimeBlocksProofUntilReactivation();
await testBootstrapReloadArmsTheSameGate();
console.log('Dev self-update activation gate: ok');

function testGateUnit() {
  const gate = new DevSelfUpdateGate();
  assert.equal(gate.state, DEV_SELF_UPDATE_STATE.IDLE);
  assert.equal(gate.blocks('chatgpt.skill.run'), false, 'an unarmed gate must not block anything');

  gate.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, capabilities: ['chatgpt.skill.run'], reason: 'merged DOM Skill change' });
  assert.equal(gate.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED, 'merge alone must never count as active');
  assert.equal(gate.blocks('chatgpt.skill.run'), true);
  assert.equal(gate.blocks('chatgpt.page.snapshot'), false, 'only the declared capabilities are gated');
  assert.equal(gate.blocks(DEV_RUNTIME_IDENTITY_TOOL), false, 'the identity re-read must always be reachable');
  assert.equal(gate.blocks(DEV_RUNTIME_ACTIVATION_TOOL), false);

  const rejection = gate.rejectionFor('chatgpt.skill.run');
  assert.equal(rejection.code, DEV_SELF_UPDATE_REJECTION_CODE);
  assert.equal(rejection.action, DEV_SELF_UPDATE_ACTION);
  assert.equal(rejection.identityTool, DEV_RUNTIME_IDENTITY_TOOL);
  assert.equal(rejection.expected.commit, NEW_COMMIT);
  assert.equal(rejection.expected.buildId, NEW_BUILD);

  gate.observeActiveRuntime({ commit: OLD_COMMIT, buildId: OLD_BUILD, userscriptVersion: '2.0.1' });
  assert.equal(gate.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED, 'the old runtime must not satisfy the gate');
  assert.deepEqual([...gate.rejectionFor('chatgpt.skill.run').mismatches], ['commit', 'buildId']);

  gate.observeActiveRuntime({ commit: NEW_COMMIT, buildId: NEW_BUILD, userscriptVersion: '2.0.2' });
  assert.equal(gate.state, DEV_SELF_UPDATE_STATE.ACTIVE);
  assert.equal(gate.blocks('chatgpt.skill.run'), false);
  assert.equal(gate.rejectionFor('chatgpt.skill.run'), null);

  /* Declaring no capabilities gates every proof, not none of them. */
  const strict = new DevSelfUpdateGate();
  strict.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD });
  assert.equal(strict.blocks('chatgpt.page.snapshot'), true);
  assert.equal(strict.blocks(DEV_RUNTIME_IDENTITY_TOOL), false);

  /* A later self-update invalidates an identity observed before it. */
  strict.observeActiveRuntime({ commit: NEW_COMMIT, buildId: NEW_BUILD });
  assert.equal(strict.state, DEV_SELF_UPDATE_STATE.ACTIVE);
  strict.requireActivation({ expectedCommit: OLD_COMMIT, expectedBuildId: OLD_BUILD });
  assert.equal(strict.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.equal(strict.activeIdentity, null, 'a new expectation must discard the previously observed identity');

  assert.throws(() => strict.requireActivation({ expectedCommit: 'not-a-commit', expectedBuildId: NEW_BUILD }), /expectedCommit/);
  assert.throws(() => strict.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: 'short' }), /expectedBuildId/);
  assert.throws(() => strict.observeActiveRuntime({ commit: NEW_COMMIT }), (error) => error.code === 'dev-runtime-identity-unreadable');
  assert.throws(() => strict.observeActiveRuntime(null), (error) => error.code === 'dev-runtime-identity-unreadable');

  /* userscriptVersion is only compared when it is part of the expectation. */
  const versioned = new DevSelfUpdateGate();
  versioned.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, expectedUserscriptVersion: '2.0.2' });
  versioned.observeActiveRuntime({ commit: NEW_COMMIT, buildId: NEW_BUILD, userscriptVersion: '2.0.1' });
  assert.equal(versioned.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.deepEqual([...versioned.status().mismatches], ['userscriptVersion']);
  versioned.observeActiveRuntime({ commit: NEW_COMMIT, buildId: NEW_BUILD, loaderVersion: '2.0.2' });
  assert.equal(versioned.state, DEV_SELF_UPDATE_STATE.ACTIVE);
}

function testAdminSurfaceExposesIdentity() {
  assert.equal(DEV_ADMIN_TOOL.RUNTIME_IDENTITY, DEV_RUNTIME_IDENTITY_TOOL);
  const supervisor = new DevSupervisorV0({
    workerClient: { enabled: true, runtimeIdentity: async () => ({ commit: OLD_COMMIT, buildId: OLD_BUILD }) },
    idFactory: (kind) => `${kind}-identity`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  assert.ok(supervisor.availableTools.includes(DEV_RUNTIME_IDENTITY_TOOL), 'the active runtime identity must be readable as a tool');
}

function testPromptTeachesTheGate() {
  const supervisor = new DevSupervisorV0({
    workerClient: { enabled: true, runtimeIdentity: async () => ({}) },
    idFactory: (kind) => `${kind}-prompt`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  const run = supervisor.activate(supervisor.createRun({ goal: 'self-update' }));
  const prompt = buildDevSupervisorPrompt({
    run,
    availableTools: [...supervisor.availableTools, DEV_RUNTIME_ACTIVATION_TOOL],
  });
  assert.match(prompt, /mergeだけでは新しいruntimeはactiveにならない/);
  assert.match(prompt, new RegExp(escapeRegExp(`- ${DEV_RUNTIME_IDENTITY_TOOL}: arguments=`)));
  assert.match(prompt, new RegExp(escapeRegExp(`- ${DEV_RUNTIME_ACTIVATION_TOOL}: arguments=`)));
  assert.match(prompt, /kind="tool-error"/);
}

/* Required regression: old runtime -> source merge -> proof attempt is
   rejected as reload-required -> reinitialize with the new identity -> the
   same capability succeeds. */
async function testStaleRuntimeBlocksProofUntilReactivation() {
  let liveIdentity = { commit: OLD_COMMIT, buildId: OLD_BUILD, userscriptVersion: '2.0.1' };
  const skillRuns = [];
  const harness = createHarness({
    client: {
      enabled: true,
      runtimeIdentity: async () => ({ realm: 'parent-userscript', ...liveIdentity }),
      skillRun: async (args) => { skillRuns.push(args); return { skillId: args.skillId, ran: true }; },
    },
    decisions: [
      { type: 'tool', tool: DEV_RUNTIME_ACTIVATION_TOOL, arguments: { expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, expectedUserscriptVersion: '2.0.2', capabilities: ['chatgpt.skill.run'], reason: 'merged Project automation skill' }, purpose: 'declare the merged runtime identity' },
      { type: 'tool', tool: 'chatgpt.skill.run', arguments: { skillId: 'project.create', program: 'probe' }, purpose: 'prove the new capability too early' },
      { type: 'tool', tool: DEV_RUNTIME_IDENTITY_TOOL, arguments: {}, purpose: 'read the active runtime identity' },
      { type: 'tool', tool: 'chatgpt.skill.run', arguments: { skillId: 'project.create', program: 'probe' }, purpose: 'prove again on the stale runtime' },
      { type: 'tool', tool: DEV_RUNTIME_IDENTITY_TOOL, arguments: {}, purpose: 'read the identity after reload' },
      { type: 'tool', tool: 'chatgpt.skill.run', arguments: { skillId: 'project.create', program: 'probe' }, purpose: 'prove on the activated runtime' },
      { type: 'final', answer: 'proved on the activated runtime', completedTasks: ['self-update'], remaining: [] },
    ],
    onDecision(index) {
      /* Between the two identity reads the page reloads into the new build. */
      if (index === 4) liveIdentity = { commit: NEW_COMMIT, buildId: NEW_BUILD, userscriptVersion: '2.0.2' };
    },
  });

  const result = await harness.engine.run({ goal: 'prove the merged capability', conversationId: 'conversation-self-update' });
  assert.equal(result.answer, 'proved on the activated runtime');
  assert.equal(harness.settings.lastRun.status, DEV_RUN_STATUS.COMPLETED);
  assert.equal(skillRuns.length, 1, 'the gated capability must run only after the identity matches');

  const firstRejection = harness.historyAt(2).at(-1);
  assert.equal(firstRejection.kind, DEV_SELF_UPDATE_HISTORY_KIND, 'a merged-but-not-loaded capability proof must be rejected');
  assert.equal(firstRejection.tool, 'chatgpt.skill.run');
  assert.equal(firstRejection.code, DEV_SELF_UPDATE_REJECTION_CODE);
  assert.equal(firstRejection.action, DEV_SELF_UPDATE_ACTION);
  assert.equal(firstRejection.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.equal(firstRejection.identityTool, DEV_RUNTIME_IDENTITY_TOOL);

  const staleObservation = harness.historyAt(3).at(-1);
  assert.equal(staleObservation.kind, 'runtime-activation');
  assert.equal(staleObservation.state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  assert.deepEqual(staleObservation.mismatches, ['commit', 'buildId', 'userscriptVersion']);
  assert.equal(staleObservation.active.commit, OLD_COMMIT);

  const secondRejection = harness.historyAt(4).at(-1);
  assert.equal(secondRejection.kind, DEV_SELF_UPDATE_HISTORY_KIND, 'a stale runtime must keep rejecting the proof');
  assert.deepEqual(secondRejection.mismatches, ['commit', 'buildId', 'userscriptVersion']);

  const activated = harness.historyAt(5).at(-1);
  assert.equal(activated.kind, 'runtime-activation');
  assert.equal(activated.state, DEV_SELF_UPDATE_STATE.ACTIVE);
  assert.equal(activated.active.commit, NEW_COMMIT);
  assert.equal(activated.active.buildId, NEW_BUILD);
  assert.deepEqual(activated.mismatches, []);

  const proof = harness.historyAt(6).at(-1);
  assert.equal(proof.kind, 'tool-result');
  assert.equal(proof.tool, 'chatgpt.skill.run');
  assert.equal(proof.result.ran, true);
  assert.equal(new Set(harness.sessionKeys).size, 1, 'the whole activation cycle stays in one Supervisor session');
}

/* Round 4 bootstrap activation must keep working and must feed the same gate. */
async function testBootstrapReloadArmsTheSameGate() {
  const sha256 = async (value) => createHash('sha256').update(String(value)).digest('hex');
  const loader = new DevExtensionLoader({ sha256 });
  await loader.stage(DEV_BOOTSTRAP_EXTENSION);
  const engine = new DevSupervisorEngineV0({
    supervisor: new DevSupervisorV0({ workerTools: { toolNames: [], has: () => false } }),
    settings: { decisionPolicy: 'normal', lastRun: null, setLastRun() {} },
    bridge: null,
    extensionLoader: loader,
  });
  const checkpoint = {
    runId: 'run-round4',
    goal: 'prove the bootstrap gate',
    decisionPolicy: 'normal',
    supervisorSessionKey: 'supervisor-round4',
    chatgptConversationId: 'conversation-round4',
    pendingTask: { type: 'round4-bootstrap', step: 'resume-proof' },
    expectedCommit: NEW_COMMIT,
    expectedBuildId: NEW_BUILD,
    expectedExtensionVersion: DEV_BOOTSTRAP_EXTENSION_VERSION,
  };

  const reload = engine.activateBootstrapAtSafeBoundary({ checkpoint, activeIdentity: { commit: NEW_COMMIT, buildId: NEW_BUILD } });
  assert.equal(reload.status, 'reload-required', 'Round 4 reload handling must be unchanged');
  assert.equal(engine.runtimeActivationStatus().state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED, 'a bootstrap reload must arm the general gate');
  assert.equal(engine.runtimeActivationStatus().expected.commit, NEW_COMMIT);
  assert.deepEqual([...engine.runtimeActivationStatus().gatedCapabilities], [
    'dev.bootstrap.identity',
    'dev.bootstrap.round4-proof',
  ], 'a bootstrap reload must gate only the extension capabilities');

  /* The Round 4 checkpoint records the identity that is already running, so an
     identity read alone must not be able to open the gate. */
  engine.observeActiveRuntimeIdentity({ commit: NEW_COMMIT, buildId: NEW_BUILD });
  assert.equal(engine.runtimeActivationStatus().state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED, 'a matching read on a runtime that never reinitialized must not satisfy the gate');
  assert.ok(engine.runtimeActivationStatus().mismatches.includes('reinitialization'));

  const activated = engine.activateBootstrapAtSafeBoundary({ checkpoint, activeIdentity: { commit: NEW_COMMIT, buildId: NEW_BUILD }, reinitialized: true });
  assert.equal(activated.status, 'active');
  assert.equal(engine.runtimeActivationStatus().state, DEV_SELF_UPDATE_STATE.ACTIVE, 'a verified reinitialization must satisfy the general gate');
}

/* Winding a Worker down is cleanup, not a capability proof. */
function testTeardownToolsAreNeverGated() {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD });
  for (const tool of ['worker.release', 'worker.stop', 'worker.pool.release', 'worker.pool.stop']) {
    assert.equal(gate.blocks(tool), false, `${tool} must stay reachable while the gate is armed`);
  }
  assert.equal(gate.blocks('worker.send'), true, 'work that is not teardown stays gated');
}

/* A mistyped expectation must not brick the Dev tool surface for the session. */
function testWithdrawingAWrongExpectation() {
  const gate = new DevSelfUpdateGate();
  gate.requireActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD, reason: 'typo' });
  assert.equal(gate.blocks('chatgpt.page.snapshot'), true);
  const cleared = gate.requireActivation({ clear: true, reason: 'withdrew a wrong expectation' });
  assert.equal(cleared.state, DEV_SELF_UPDATE_STATE.IDLE);
  assert.equal(cleared.reason, 'withdrew a wrong expectation');
  assert.equal(gate.blocks('chatgpt.page.snapshot'), false);
}

/* The stale parent build predates the dev.runtime.identity RPC method, so the
   engine must still be able to read and report the active identity. */
async function testIdentityToolWorksWithoutParentSupport() {
  const supervisor = new DevSupervisorV0({
    workerClient: { enabled: true, skillRun: async () => ({ ran: true }) },
    idFactory: (kind) => `${kind}-fallback`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  assert.equal(supervisor.availableTools.includes(DEV_RUNTIME_IDENTITY_TOOL), false, 'a pre-update parent runtime does not expose the identity method');

  const settings = { decisionPolicy: 'normal', lastRun: null, setLastRun(run) { this.lastRun = run; } };
  const engine = new DevSupervisorEngineV0({
    supervisor,
    settings,
    bridge: null,
    runtimeIdentityProvider: async () => ({ commit: NEW_COMMIT, buildId: NEW_BUILD, userscriptVersion: '2.0.2' }),
  });
  assert.ok(engine.availableTools().includes(DEV_RUNTIME_IDENTITY_TOOL), 'the engine must always advertise the identity re-read');

  engine.requireRuntimeActivation({ expectedCommit: NEW_COMMIT, expectedBuildId: NEW_BUILD });
  assert.equal(engine.runtimeActivationStatus().state, DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED);
  const identity = await engine.readActiveRuntimeIdentity({});
  assert.equal(identity.source, 'runtime-identity-provider');
  assert.equal(identity.commit, NEW_COMMIT);
  engine.observeActiveRuntimeIdentity(identity);
  assert.equal(engine.runtimeActivationStatus().state, DEV_SELF_UPDATE_STATE.ACTIVE, 'the fallback read must be able to satisfy the gate');
}

function createHarness({ client, decisions, onDecision }) {
  let sequence = 0;
  const prompts = [];
  const sessionKeys = [];
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => `${kind}-${++sequence}`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  const settings = {
    decisionPolicy: 'normal',
    analysisScope: undefined,
    lastRun: null,
    setLastRun(run) { this.lastRun = run; },
  };
  let index = 0;
  const bridge = {
    async request(prompt, options = {}) {
      prompts.push(String(prompt));
      sessionKeys.push(String(options.sessionKey || ''));
      onDecision?.(index);
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return JSON.stringify(decision);
    },
  };
  return {
    engine: new DevSupervisorEngineV0({ supervisor, settings, bridge }),
    settings,
    prompts,
    sessionKeys,
    historyAt(promptIndex) {
      const match = String(prompts[promptIndex]).match(/<HEX_DEV_DATA>\n([\s\S]*?)\n<\/HEX_DEV_DATA>/);
      assert.ok(match, 'the Supervisor prompt must carry its data block');
      return JSON.parse(match[1]).history;
    },
  };
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
