import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEV_BOOTSTRAP_CAPABILITY,
  DEV_BOOTSTRAP_EXTENSION,
  DEV_BOOTSTRAP_EXTENSION_INTEGRITY,
  DEV_BOOTSTRAP_EXTENSION_VERSION,
  DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY,
  DevExtensionLoader,
  createDevBootstrapCheckpoint,
  createDevBootstrapHandoff,
  verifyDevBootstrapIdentity,
} from '../../js/ai/dev/bootstrap/dev-bootstrap-gate.js';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { createAgentProfileEngine } from '../../js/ai/dev/ui/engine-router.js';

const COMMIT = 'a'.repeat(40);
const BUILD_ID = 'b'.repeat(24);
const checkpointInput = {
  runId: 'run-round4',
  goal: 'prove the minimum bootstrap gate',
  decisionPolicy: 'normal',
  supervisorSessionKey: 'supervisor-round4',
  chatgptConversationId: 'conversation-round4',
  pendingTask: { type: 'bootstrap', step: 'activate' },
  expectedCommit: COMMIT,
  expectedBuildId: BUILD_ID,
  expectedExtensionVersion: DEV_BOOTSTRAP_EXTENSION_VERSION,
};
const sha256 = async (value) => createHash('sha256').update(String(value)).digest('hex');

assert.equal(DEV_BOOTSTRAP_EXTENSION_VERSION, '2');
assert.deepEqual(DEV_BOOTSTRAP_EXTENSION.capabilities.map((item) => item.name), [
  DEV_BOOTSTRAP_CAPABILITY,
  DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY,
]);

const checkpoint = createDevBootstrapCheckpoint(checkpointInput);
assert.deepEqual(Object.keys(checkpoint), Object.keys(checkpointInput), 'checkpoint must carry only the Round 4 minimum fields');
assert.equal(Object.isFrozen(checkpoint), true);
assert.throws(() => createDevBootstrapCheckpoint({ ...checkpointInput, extra: true }), /invalid shape/);

const handoff = createDevBootstrapHandoff(checkpoint);
assert.equal(handoff.runId, checkpoint.runId);
assert.equal(handoff.supervisorSessionKey, checkpoint.supervisorSessionKey);
assert.equal(handoff.chatgptConversationId, checkpoint.chatgptConversationId);
assert.deepEqual(handoff.checkpoint.pendingTask, checkpoint.pendingTask);

const tampered = structuredClone(DEV_BOOTSTRAP_EXTENSION);
tampered.capabilities[0].name = 'dev.bootstrap.tampered';
const integrityLoader = new DevExtensionLoader({ sha256 });
await assert.rejects(() => integrityLoader.stage(tampered), (error) => error.code === 'dev-extension-integrity-mismatch');
assert.equal(integrityLoader.stagedVersion, null, 'failed integrity must never stage an extension');
const untrusted = structuredClone(DEV_BOOTSTRAP_EXTENSION);
untrusted.id = 'dev.bootstrap-untrusted';
untrusted.integrity = `sha256-${await sha256(JSON.stringify({
  apiVersion: untrusted.apiVersion,
  id: untrusted.id,
  version: untrusted.version,
  requiresReload: untrusted.requiresReload,
  capabilities: untrusted.capabilities,
}))}`;
await assert.rejects(() => integrityLoader.stage(untrusted), (error) => error.code === 'dev-extension-untrusted', 'a self-consistent checksum must not bypass the runtime trust anchor');

const loader = new DevExtensionLoader({ sha256 });
const staged = await loader.stage(DEV_BOOTSTRAP_EXTENSION);
assert.deepEqual(staged, {
  id: 'dev.bootstrap-observer',
  version: DEV_BOOTSTRAP_EXTENSION_VERSION,
  integrity: DEV_BOOTSTRAP_EXTENSION_INTEGRITY,
  verified: true,
});
assert.equal(loader.activeVersion, null, 'staging must not activate the extension');
assert.deepEqual(loader.activeCapabilities, [], 'staging must not advertise capabilities');
assert.throws(
  () => loader.activateAtSafeBoundary({ checkpoint: { ...checkpointInput, expectedExtensionVersion: '3' }, activeIdentity: { commit: COMMIT, buildId: BUILD_ID }, reinitialized: true }),
  (error) => error.code === 'dev-extension-version-mismatch',
);

loader.beginToolCall();
assert.equal(loader.toolCallActive, true);
assert.throws(
  () => loader.activateAtSafeBoundary({ checkpoint, activeIdentity: { commit: COMMIT, buildId: BUILD_ID }, reinitialized: true }),
  (error) => error.code === 'dev-extension-tool-call-active',
  'activation must fail closed while a Dev tool call is active',
);
loader.endToolCall();
assert.equal(loader.toolCallActive, false);

const boundaryLoader = new DevExtensionLoader({ sha256 });
await boundaryLoader.stage(DEV_BOOTSTRAP_EXTENSION);
const boundaryEngine = new DevSupervisorEngineV0({ supervisor: {}, settings: {}, bridge: null, extensionLoader: boundaryLoader });
await boundaryEngine.executeWithinToolBoundary(async () => {
  assert.equal(boundaryLoader.toolCallActive, true, 'the engine must enter the activation guard before invoking a tool');
  assert.throws(
    () => boundaryEngine.activateBootstrapAtSafeBoundary({ checkpoint, activeIdentity: { commit: COMMIT, buildId: BUILD_ID }, reinitialized: true }),
    (error) => error.code === 'dev-extension-tool-call-active',
  );
});
assert.equal(boundaryLoader.toolCallActive, false, 'the engine must leave the activation guard after a tool settles');

const reload = loader.activateAtSafeBoundary({ checkpoint, activeIdentity: { commit: COMMIT, buildId: BUILD_ID } });
assert.equal(reload.status, 'reload-required');
assert.equal(reload.reason, 'extension-reinitialize');
assert.equal(reload.handoff.runId, checkpoint.runId);
assert.equal(reload.handoff.supervisorSessionKey, checkpoint.supervisorSessionKey);
assert.equal(reload.handoff.chatgptConversationId, checkpoint.chatgptConversationId);
assert.equal(loader.activeVersion, null, 'reload request must not activate before reinitialization');
assert.deepEqual(loader.activeCapabilities, [], 'reload handoff must not advertise capabilities before restoration');

assert.throws(
  () => loader.activateAtSafeBoundary({ checkpoint, activeIdentity: { commit: 'c'.repeat(40), buildId: BUILD_ID }, reinitialized: true }),
  (error) => error.code === 'dev-bootstrap-identity-mismatch' && error.mismatches.includes('commit'),
);
assert.throws(
  () => verifyDevBootstrapIdentity(checkpoint, { commit: COMMIT, buildId: 'd'.repeat(24) }, DEV_BOOTSTRAP_EXTENSION_VERSION),
  (error) => error.code === 'dev-bootstrap-identity-mismatch' && error.mismatches.includes('buildId'),
);

const activated = loader.activateAtSafeBoundary({ checkpoint, activeIdentity: { commit: COMMIT, buildId: BUILD_ID }, reinitialized: true });
assert.equal(activated.status, 'active');
assert.equal(activated.identity.verified, true);
assert.equal(loader.activeVersion, DEV_BOOTSTRAP_EXTENSION_VERSION);
assert.deepEqual(loader.activeCapabilities, [DEV_BOOTSTRAP_CAPABILITY, DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY]);

const evidence = loader.invoke(DEV_BOOTSTRAP_CAPABILITY);
assert.deepEqual(evidence, {
  capability: DEV_BOOTSTRAP_CAPABILITY,
  extensionId: 'dev.bootstrap-observer',
  extensionVersion: DEV_BOOTSTRAP_EXTENSION_VERSION,
  integrity: DEV_BOOTSTRAP_EXTENSION_INTEGRITY,
  commit: COMMIT,
  buildId: BUILD_ID,
  verified: true,
});
const proofEvidence = loader.invoke(DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY);
assert.deepEqual(proofEvidence, { ...evidence, capability: DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY });
assert.throws(() => loader.invoke('dev.bootstrap.unknown'), /Unknown Dev extension capability/);

const routingCalls = [];
const settings = { agentProfile: 'standard' };
const standardEngine = {
  async run(input) { routingCalls.push(['standard', input.mode]); return 'standard'; },
  marker() { return 'bound-standard'; },
};
const devEngine = {
  prepareBootstrapExtension() { routingCalls.push(['prepare']); return Promise.resolve(staged); },
  activateBootstrapAtSafeBoundary(options) { routingCalls.push(['activate', options]); return activated; },
  invokeBootstrapCapability(name) { routingCalls.push(['invoke', name]); return evidence; },
  async run(input) { routingCalls.push(['dev', input.mode]); return 'dev'; },
};
const routed = createAgentProfileEngine({ standardEngine, settings, devEngine });
assert.equal(await routed.devBootstrap.prepare(), staged);
assert.equal(routed.devBootstrap.activateAtSafeBoundary({ checkpoint }).status, 'active');
assert.equal(routed.devBootstrap.invoke(DEV_BOOTSTRAP_CAPABILITY).capability, DEV_BOOTSTRAP_CAPABILITY);
assert.equal(routed.marker(), 'bound-standard');
assert.equal(await routed.run({ mode: 'agent' }), 'standard', 'Standard Agent routing must remain unchanged by bootstrap support');
settings.agentProfile = 'dev';
assert.equal(await routed.run({ mode: 'agent' }), 'dev');
assert.deepEqual(routingCalls.slice(0, 3).map((item) => item[0]), ['prepare', 'activate', 'invoke']);

const productionLoader = new DevExtensionLoader({ sha256 });
await productionLoader.stage(DEV_BOOTSTRAP_EXTENSION);
productionLoader.activateAtSafeBoundary({ checkpoint, activeIdentity: { commit: COMMIT, buildId: BUILD_ID }, reinitialized: true });
const prompts = [];
const runtimeSettings = {
  decisionPolicy: 'normal',
  analysisScope: undefined,
  lastRun: null,
  setLastRun(run) { this.lastRun = run; },
};
let requestCount = 0;
const bridge = {
  async request(prompt) {
    prompts.push(String(prompt));
    requestCount += 1;
    if (requestCount === 1) return JSON.stringify({ type: 'tool', tool: DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY, arguments: {}, purpose: 'prove restored bootstrap capability' });
    return JSON.stringify({ type: 'final', answer: 'proof observed', completedTasks: ['round4-proof'], remaining: [] });
  },
};
const productionEngine = new DevSupervisorEngineV0({
  supervisor: new DevSupervisorV0({ workerTools: { toolNames: [], has: () => false } }),
  settings: runtimeSettings,
  bridge,
  extensionLoader: productionLoader,
});
const runtimeResult = await productionEngine.run({ goal: 'resume after bootstrap restoration', conversationId: 'conversation-round4' });
assert.equal(runtimeResult.answer, 'proof observed');
assert.match(prompts[0], /dev\.bootstrap\.round4-proof/, 'an activated extension capability must be advertised to the resumed Supervisor');
assert.match(prompts[1], /dev\.bootstrap\.round4-proof/, 'the next Supervisor turn must receive the extension tool result');
assert.match(prompts[1], /verified/, 'the extension proof result must be returned as Supervisor history');
assert.equal(productionLoader.toolCallActive, false, 'extension invocation must settle its tool-call boundary');

console.log('Dev Agent Seed Round 4 bootstrap gate tests passed');
