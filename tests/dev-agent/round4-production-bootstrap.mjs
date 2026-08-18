import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installDevBootstrapHost } from '../../js/userscript/dev/bootstrap-host.js';
import { runProductionDevBootstrap } from '../../js/ai/dev/bootstrap/production-bootstrap.js';
import {
  DEV_BOOTSTRAP_EXTENSION,
  DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY,
  DevExtensionLoader,
} from '../../js/ai/dev/bootstrap/dev-bootstrap-gate.js';
import { DevSupervisorEngineV0 } from '../../js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';

const COMMIT = 'a'.repeat(40);
const BUILD = 'b'.repeat(24);
const TOKEN = 'c'.repeat(64);
const sha256 = async (value) => createHash('sha256').update(String(value)).digest('hex');

await testParentHandoffBoundary();
await testProductionOrchestratorGenerations();
await testRequiredSupervisorProof();

console.log('Dev Agent Round 4 production bootstrap tests passed');

async function testParentHandoffBoundary() {
  const parent = fakeWindow();
  const child1 = { messages: [], postMessage(message) { this.messages.push(message); } };
  const child2 = { messages: [], postMessage(message) { this.messages.push(message); } };
  let iframe = { contentWindow: child1, dataset: { hexGeneration: '1', hexSandboxToken: TOKEN } };
  let reloads = 0;
  const host = {
    get iframe() { return iframe; },
    reload() {
      reloads += 1;
      iframe = { contentWindow: child2, dataset: { hexGeneration: '2', hexSandboxToken: TOKEN } };
      return Promise.resolve();
    },
  };
  const installed = installDevBootstrapHost({ host, runtimeIdentity: { commit: COMMIT, buildId: BUILD }, windowRef: parent });
  const handoff = { checkpoint: { runId: 'bootstrap-run', pendingTask: { type: 'round4-bootstrap' } } };

  parent.emit({
    origin: 'null', source: child1,
    data: { protocol: installed.protocol, type: 'hex.dev.bootstrap.reload-request', generation: '1', sandboxToken: 'd'.repeat(64), handoff },
  });
  await delay(5);
  assert.equal(reloads, 0, 'wrong sandbox token must not trigger bootstrap reload');

  parent.emit({
    origin: 'null', source: child1,
    data: { protocol: installed.protocol, type: 'hex.dev.bootstrap.reload-request', generation: '1', sandboxToken: TOKEN, handoff },
  });
  await delay(5);
  assert.equal(reloads, 1, 'validated child may request exactly one bootstrap reload');
  assert.equal(child1.messages.at(-1)?.type, 'hex.dev.bootstrap.reload-accepted');

  parent.emit({
    origin: 'null', source: child2,
    data: { protocol: installed.protocol, type: 'hex.dev.bootstrap.handoff-request', generation: '2', sandboxToken: TOKEN },
  });
  const response = child2.messages.at(-1);
  assert.equal(response.type, 'hex.dev.bootstrap.handoff-response');
  assert.deepEqual(response.handoff, handoff);
  assert.deepEqual(response.runtimeIdentity, { commit: COMMIT, buildId: BUILD });
  installed.close();
}

async function testProductionOrchestratorGenerations() {
  const handoff = {
    runId: 'bootstrap-run',
    supervisorSessionKey: 'supervisor-session',
    chatgptConversationId: 'chatgpt-conversation',
    checkpoint: {
      runId: 'bootstrap-run', goal: 'Round 4', decisionPolicy: 'normal', supervisorSessionKey: 'supervisor-session',
      chatgptConversationId: 'chatgpt-conversation', pendingTask: { type: 'round4-bootstrap', step: 'resume-proof', hexConversationId: 'hex-conversation' },
      expectedCommit: COMMIT, expectedBuildId: BUILD, expectedExtensionVersion: '2',
    },
  };
  const firstParent = responsiveParent({ handoff: null, runtimeIdentity: { commit: COMMIT, buildId: BUILD }, expectedReloadHandoff: handoff });
  const firstGlobal = fakeSandboxGlobal(firstParent);
  const firstCalls = [];
  const firstEngine = { devBootstrap: {
    prepare: async () => firstCalls.push('prepare'),
    sessionFor: (conversationId) => { firstCalls.push(['sessionFor', conversationId]); return { supervisorSessionKey: 'supervisor-session' }; },
    createCheckpoint: (options) => { firstCalls.push(['createCheckpoint', options]); return handoff.checkpoint; },
    activateAtSafeBoundary: () => ({ status: 'reload-required', handoff }),
  } };
  const bridge = {
    async request() { return { text: '{}', conversation: { id: 'chatgpt-conversation' } }; },
    conversationFor() { return null; },
  };
  const session = { current: { id: 'hex-conversation', model: null, reasoning: null } };
  const staged = await runProductionDevBootstrap({ engine: firstEngine, session, bridge, globalObject: firstGlobal });
  assert.equal(staged.state, 'reload-requested');
  assert.equal(firstParent.reloadRequests.length, 1);
  assert.deepEqual(firstParent.reloadRequests[0], handoff);
  assert.ok(firstCalls.some((item) => Array.isArray(item) && item[0] === 'createCheckpoint'));

  const secondParent = responsiveParent({ handoff, runtimeIdentity: { commit: COMMIT, buildId: BUILD } });
  const secondGlobal = fakeSandboxGlobal(secondParent, '2');
  const secondCalls = [];
  const secondEngine = { devBootstrap: {
    prepare: async () => secondCalls.push('prepare'),
    restore: (value) => { secondCalls.push(['restore', value]); return handoff; },
    activateAtSafeBoundary: () => ({ status: 'active', extensionVersion: '2', integrity: 'sha256-' + 'd'.repeat(64) }),
    runProof: async (options) => { secondCalls.push(['runProof', options]); return { answer: 'proof observed' }; },
  } };
  const complete = await runProductionDevBootstrap({ engine: secondEngine, session, bridge, globalObject: secondGlobal });
  assert.equal(complete.state, 'complete');
  assert.equal(complete.capability, DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY);
  assert.equal(complete.proofAnswer, 'proof observed');
  assert.ok(secondCalls.some((item) => Array.isArray(item) && item[0] === 'runProof'));
}

async function testRequiredSupervisorProof() {
  const loader = new DevExtensionLoader({ sha256 });
  await loader.stage(DEV_BOOTSTRAP_EXTENSION);
  const checkpoint = {
    runId: 'bootstrap-run', goal: 'Round 4', decisionPolicy: 'normal', supervisorSessionKey: 'supervisor-session',
    chatgptConversationId: 'chatgpt-conversation', pendingTask: { type: 'round4-bootstrap', step: 'resume-proof', hexConversationId: 'hex-conversation' },
    expectedCommit: COMMIT, expectedBuildId: BUILD, expectedExtensionVersion: '2',
  };
  loader.activateAtSafeBoundary({ checkpoint, activeIdentity: { commit: COMMIT, buildId: BUILD }, reinitialized: true });
  const settings = { decisionPolicy: 'normal', analysisScope: undefined, lastRun: null, setLastRun(run) { this.lastRun = run; } };
  let requests = 0;
  const prompts = [];
  const bridge = { async request(prompt) {
    prompts.push(String(prompt)); requests += 1;
    if (requests === 1) return JSON.stringify({ type: 'final', answer: 'too early', completedTasks: [], remaining: [] });
    if (requests === 2) return JSON.stringify({ type: 'tool', tool: DEV_BOOTSTRAP_ROUND4_PROOF_CAPABILITY, arguments: {}, purpose: 'verify bootstrap identity' });
    return JSON.stringify({ type: 'final', answer: 'proof complete', completedTasks: ['round4-proof'], remaining: [] });
  } };
  const engine = new DevSupervisorEngineV0({
    supervisor: new DevSupervisorV0({ workerTools: { toolNames: [], has: () => false } }), settings, bridge, extensionLoader: loader,
  });
  engine.restoreBootstrapHandoff({ checkpoint });
  const result = await engine.runBootstrapProof({ handoff: { checkpoint } });
  assert.equal(result.answer, 'proof complete');
  assert.equal(requests, 3, 'final before proof must be rejected and re-decided');
  assert.match(prompts[1], /bootstrap-proof-required/);
  assert.match(prompts[2], /verified/);
}

function responsiveParent({ handoff, runtimeIdentity, expectedReloadHandoff = null }) {
  const child = null;
  const parent = {
    reloadRequests: [],
    postMessage(message) {
      queueMicrotask(() => {
        if (message.type === 'hex.dev.bootstrap.handoff-request') {
          parent.target.emit({ origin: 'https://chatgpt.com', source: parent, data: {
            protocol: message.protocol, type: 'hex.dev.bootstrap.handoff-response', generation: message.generation,
            sandboxToken: message.sandboxToken, handoff, runtimeIdentity,
          } });
        } else if (message.type === 'hex.dev.bootstrap.reload-request') {
          parent.reloadRequests.push(message.handoff);
          if (expectedReloadHandoff) assert.deepEqual(message.handoff, expectedReloadHandoff);
          parent.target.emit({ origin: 'https://chatgpt.com', source: parent, data: {
            protocol: message.protocol, type: 'hex.dev.bootstrap.reload-accepted', generation: message.generation,
            sandboxToken: message.sandboxToken,
          } });
        }
      });
    },
  };
  return parent;
}

function fakeSandboxGlobal(parent, generation = '1') {
  const target = fakeWindow();
  parent.target = target;
  target.parent = parent;
  target.location = { origin: 'null', search: `?__hex_embed_generation=${generation}&__hex_dev_bootstrap=1` };
  target.__HEX_EMBED_SANDBOX_TOKEN__ = TOKEN;
  return target;
}

function fakeWindow() {
  const listeners = new Set();
  return {
    parent: null,
    location: null,
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    emit(event) { for (const listener of [...listeners]) listener(event); },
  };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
