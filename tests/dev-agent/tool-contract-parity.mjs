/* Parity safety net for the Dev tool surface.
   A public tool is only usable if four separate representations agree: the tool
   name the Supervisor is offered, the prompt contract that tells it how to call
   that tool, the client method the host dispatches through, and the parent RPC
   method the runtime answers. Each lives in its own file today, so any one of
   them can drift silently. This test fails when they stop agreeing.
   H0 is the safety net only; the canonical registry is CARD H1. */
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { DEV_WORKER_TOOL, DEV_WORKER_TOOLS, createDevWorkerToolSurface } from '../../js/ai/dev/workers/tool-surface.js';
import { DEV_ADMIN_TOOL, DEV_ADMIN_TOOLS, createDevAdminToolSurface } from '../../js/ai/dev/admin/tool-surface.js';
import { buildDevSupervisorPrompt } from '../../js/ai/dev/protocol/dev-supervisor-prompt.js';
import {
  DEV_PARENT_RPC_METHODS,
  createDevWorkerParentRpc,
  createDevWorkerParentRpcClient,
} from '../../js/userscript/dev/parent-rpc.js';
import { DEV_RUNTIME_ACTIVATION_TOOL, DEV_RUNTIME_IDENTITY_TOOL } from '../../js/ai/dev/bootstrap/self-update-gate.js';
import {
  DEV_BATCH_POLICY,
  DEV_OPERATION_CLASS,
  DEV_TOOL_CONTRACTS,
  DEV_TOOL_SURFACE,
  devToolBatchPolicy,
  devToolContract,
  devToolNamesForSurface,
  devToolOperationClass,
  devBatchPolicyFor,
} from '../../js/ai/dev/protocol/dev-tool-contracts.js';

const PUBLIC_TOOLS = Object.freeze([...new Set([
  ...DEV_WORKER_TOOLS,
  ...DEV_ADMIN_TOOLS,
  DEV_RUNTIME_IDENTITY_TOOL,
  DEV_RUNTIME_ACTIVATION_TOOL,
])]);

/* Arguments a caller cannot omit. This is a test expectation, not production
   metadata: H0 must not create a second operation table for H1 to replace. */
const REQUIRED_ARGUMENTS = Object.freeze({
  [DEV_WORKER_TOOL.SEND]: ['instruction'],
  [DEV_WORKER_TOOL.FOLLOWUP]: ['text'],
  [DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE]: ['index'],
  [DEV_ADMIN_TOOL.SKILL_DESCRIBE]: ['skillId'],
  [DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE]: ['manifest'],
  [DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE]: ['skillId'],
  [DEV_ADMIN_TOOL.SKILL_ACTIVATE]: ['skillId'],
  [DEV_ADMIN_TOOL.SKILL_ROLLBACK]: ['skillId'],
  [DEV_ADMIN_TOOL.SKILL_RUN]: ['skillId', 'program'],
  [DEV_ADMIN_TOOL.POOL_CREATE_CHAT]: ['leaseId'],
  [DEV_ADMIN_TOOL.POOL_START]: ['leaseId', 'instruction'],
  [DEV_ADMIN_TOOL.POOL_OBSERVE]: ['leaseId'],
  [DEV_ADMIN_TOOL.POOL_RESULT]: ['leaseId'],
  [DEV_ADMIN_TOOL.POOL_FOLLOWUP]: ['leaseId', 'text'],
  [DEV_ADMIN_TOOL.POOL_NUDGE]: ['leaseId'],
  [DEV_ADMIN_TOOL.POOL_STOP]: ['leaseId'],
  [DEV_ADMIN_TOOL.POOL_RELEASE]: ['leaseId'],
  [DEV_ADMIN_TOOL.GRAPH_START]: ['tasks'],
  [DEV_ADMIN_TOOL.GRAPH_STATUS]: ['graphId'],
  [DEV_ADMIN_TOOL.GRAPH_TASK_RESULT]: ['graphId', 'taskId'],
  [DEV_ADMIN_TOOL.GRAPH_CANCEL]: ['graphId'],
  [DEV_RUNTIME_ACTIVATION_TOOL]: ['expectedCommit', 'expectedBuildId'],
});

const PUBLIC_TOOL_RPC_METHOD = Object.freeze({
  [DEV_WORKER_TOOL.DISCOVER]: 'dev.worker.discover',
  [DEV_WORKER_TOOL.CLAIM]: 'dev.worker.claim',
  [DEV_WORKER_TOOL.CREATE_CHAT]: 'dev.worker.create_chat',
  [DEV_WORKER_TOOL.SEND]: 'dev.worker.send',
  [DEV_WORKER_TOOL.OBSERVE]: 'dev.worker.observe',
  [DEV_WORKER_TOOL.FOLLOWUP]: 'dev.worker.followup',
  [DEV_WORKER_TOOL.NUDGE]: 'dev.worker.nudge',
  [DEV_WORKER_TOOL.STOP]: 'dev.worker.stop',
  [DEV_WORKER_TOOL.RESULT]: 'dev.worker.result',
  [DEV_WORKER_TOOL.RELEASE]: 'dev.worker.release',
  [DEV_ADMIN_TOOL.RUNTIME_IDENTITY]: 'dev.runtime.identity',
  [DEV_ADMIN_TOOL.PAGE_SNAPSHOT]: 'dev.admin.page_snapshot',
  [DEV_ADMIN_TOOL.PAGE_SCRIPTS]: 'dev.admin.page_scripts',
  [DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE]: 'dev.admin.page_script_source',
  [DEV_ADMIN_TOOL.SKILL_LIST]: 'dev.skill.list',
  [DEV_ADMIN_TOOL.SKILL_DESCRIBE]: 'dev.skill.describe',
  [DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE]: 'dev.skill.install_candidate',
  [DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE]: 'dev.skill.validate_candidate',
  [DEV_ADMIN_TOOL.SKILL_ACTIVATE]: 'dev.skill.activate',
  [DEV_ADMIN_TOOL.SKILL_ROLLBACK]: 'dev.skill.rollback',
  [DEV_ADMIN_TOOL.SKILL_RUN]: 'dev.skill.run',
  [DEV_ADMIN_TOOL.POOL_STATUS]: 'dev.worker_pool.status',
  [DEV_ADMIN_TOOL.POOL_PROVISION]: 'dev.worker_pool.provision',
  [DEV_ADMIN_TOOL.POOL_CLAIM]: 'dev.worker_pool.claim',
  [DEV_ADMIN_TOOL.POOL_CREATE_CHAT]: 'dev.worker_pool.create_chat',
  [DEV_ADMIN_TOOL.POOL_START]: 'dev.worker_pool.start',
  [DEV_ADMIN_TOOL.POOL_OBSERVE]: 'dev.worker_pool.observe',
  [DEV_ADMIN_TOOL.POOL_RESULT]: 'dev.worker_pool.result',
  [DEV_ADMIN_TOOL.POOL_FOLLOWUP]: 'dev.worker_pool.followup',
  [DEV_ADMIN_TOOL.POOL_NUDGE]: 'dev.worker_pool.nudge',
  [DEV_ADMIN_TOOL.POOL_STOP]: 'dev.worker_pool.stop',
  [DEV_ADMIN_TOOL.POOL_RELEASE]: 'dev.worker_pool.release',
  [DEV_ADMIN_TOOL.GRAPH_START]: 'dev.task_graph.start',
  [DEV_ADMIN_TOOL.GRAPH_STATUS]: 'dev.task_graph.status',
  [DEV_ADMIN_TOOL.GRAPH_TASK_RESULT]: 'dev.task_graph.task_result',
  [DEV_ADMIN_TOOL.GRAPH_CANCEL]: 'dev.task_graph.cancel',
});

function promptContracts(availableTools) {
  const prompt = buildDevSupervisorPrompt({
    run: {
      runId: 'devrun-parity', workerId: null, supervisorSessionKey: 'session-parity',
      goal: 'parity', decisionPolicy: 'normal', analysisScope: 'none', status: 'running',
    },
    availableTools,
    history: [],
  });
  const contracts = new Map();
  for (const line of prompt.split('\n')) {
    const match = /^- ([a-z0-9_.]+): arguments=(.+)$/.exec(line);
    if (match) contracts.set(match[1], match[2]);
  }
  return { prompt, contracts };
}

function everyPublicToolIsCallableFromThePrompt() {
  const { contracts } = promptContracts(PUBLIC_TOOLS);
  const missing = PUBLIC_TOOLS.filter((tool) => !contracts.has(tool));
  assert.deepEqual(missing, [], 'every exposed public Dev tool must carry a prompt argument contract');

  for (const [tool, required] of Object.entries(REQUIRED_ARGUMENTS)) {
    const contract = contracts.get(tool);
    assert.ok(contract, `${tool} must have a prompt contract`);
    for (const field of required) {
      assert.ok(contract.includes(`"${field}"`), `${tool} contract must document its required "${field}" argument`);
    }
  }
}

function thePromptNeverAdvertisesAToolThatDoesNotExist() {
  const known = new Set(PUBLIC_TOOLS);
  // Ask for every contract the prompt is capable of rendering, not just the
  // ones that happen to be installed, so a contract for a deleted tool is caught.
  const { contracts } = promptContracts([...known, 'worker.pool.wait_result', 'worker.graph.wait', 'not.a.tool']);
  for (const tool of contracts.keys()) {
    assert.ok(known.has(tool), `the prompt advertises "${tool}", which is not an exposed public tool`);
  }

  // And a tool that is not offered this turn must not be described this turn.
  const narrow = promptContracts([DEV_WORKER_TOOL.DISCOVER]);
  assert.deepEqual([...narrow.contracts.keys()], [DEV_WORKER_TOOL.DISCOVER], 'only the offered tools are described');
  assert.equal(
    narrow.prompt.includes('worker.pool.claim -> worker.pool.create_chat'),
    false,
    'Pool delegation must not be described when the Pool is not available',
  );
  assert.equal(
    narrow.prompt.includes('The multi-Worker Pool is not available this turn.'),
    true,
    'capability wording follows the actual inventory',
  );

  // The single-tab constraint is permanent architecture, not capability drift:
  // it must be stated whatever the inventory is.
  for (const { prompt } of [narrow, promptContracts([...DEV_ADMIN_TOOLS])]) {
    assert.match(prompt, /single-tab/i, 'the single-tab Worker constraint is always stated');
  }

  const pooled = promptContracts([...DEV_ADMIN_TOOLS]);
  assert.equal(pooled.prompt.includes('The multi-Worker iframe Pool is available.'), true);
  assert.equal(pooled.prompt.includes('Six Workers is the capacity limit, not a target.'), true);
  assert.equal(pooled.prompt.includes('"size":6'), false, 'the provision example must not hard-code the capacity as the target');
  assert.equal(pooled.prompt.includes('the current single slot'), false, 'stale single-slot wording must not survive');
  assert.equal(pooled.prompt.includes('only one Worker may be active at a time'), false);

  const partialPool = promptContracts([DEV_ADMIN_TOOL.POOL_CLAIM]);
  assert.match(partialPool.prompt, /Available worker\.pool\.\* operations this turn: worker\.pool\.claim\./);
  for (const unavailable of [
    'worker.pool.provision',
    'worker.pool.create_chat',
    'worker.pool.start',
    'worker.pool.result',
    'worker.pool.release',
  ]) {
    assert.equal(partialPool.prompt.includes(unavailable), false, `partial Pool prompt must not instruct unavailable ${unavailable}`);
  }

  for (const availableTool of [DEV_ADMIN_TOOL.POOL_STATUS, DEV_ADMIN_TOOL.POOL_PROVISION]) {
    const partial = promptContracts([availableTool]);
    assert.equal(partial.prompt.includes('The multi-Worker Pool is not available this turn.'), false);
    assert.match(partial.prompt, new RegExp(`Available worker\\.pool\\.\\* operations this turn: ${availableTool}\\.`));
    for (const unavailable of ['worker.pool.claim', 'worker.pool.create_chat', 'worker.pool.start', 'worker.pool.result', 'worker.pool.release']) {
      if (unavailable !== availableTool) {
        assert.equal(partial.prompt.includes(unavailable), false, `partial Pool prompt must not instruct unavailable ${unavailable}`);
      }
    }
  }

  const partialClaim = promptContracts([DEV_WORKER_TOOL.CLAIM]);
  for (const unavailable of ['worker.create_chat', 'worker.send', 'worker.result', 'worker.release']) {
    assert.equal(partialClaim.prompt.includes(unavailable), false, `partial Worker prompt must not instruct unavailable ${unavailable}`);
  }
  const partialSend = promptContracts([DEV_WORKER_TOOL.SEND]);
  assert.equal(partialSend.prompt.includes('worker.send and worker.followup'), false);
  assert.equal(partialSend.prompt.includes('worker.followup'), false);
}

async function everyAdminToolReachesADistinctRuntimeOperation() {
  const { port1, port2 } = new MessageChannel();
  const routed = [];
  const runtime = new Proxy({}, {
    get: (_target, name) => (params) => { routed.push({ name: String(name), params }); return { ok: String(name) }; },
    has: () => true,
  });
  const server = createDevWorkerParentRpc({ port: port1, runtime });
  const client = createDevWorkerParentRpcClient({ port: port2, timeoutMs: 2000 });
  const admin = createDevAdminToolSurface(client);
  const worker = createDevWorkerToolSurface(client);
  try {
    assert.deepEqual([...DEV_PARENT_RPC_METHODS].sort(), Object.keys(CLIENT_METHOD_FOR).sort(), 'the RPC allow-list must contain every declared client method');
    assert.deepEqual(
      [...DEV_ADMIN_TOOLS, ...DEV_WORKER_TOOLS].sort(),
      Object.keys(PUBLIC_TOOL_RPC_METHOD).sort(),
      'every public surface tool must have an explicit RPC mapping',
    );
    for (const [tool, rpcMethod] of Object.entries(PUBLIC_TOOL_RPC_METHOD)) {
      assert.ok(DEV_PARENT_RPC_METHODS.includes(rpcMethod), `${tool} must be allowed by the parent RPC`);
      const surface = DEV_WORKER_TOOLS.includes(tool) ? worker : admin;
      assert.ok(surface?.has(tool), `${tool} must be exposed by its canonical surface`);
      routed.length = 0;
      const answer = await surface.execute(tool, publicToolArguments(tool));
      assert.equal(routed.length, 1, `${tool} must reach exactly one runtime operation`);
      assert.equal(routed[0].name, runtimeMethodFor(rpcMethod), `${tool} must route to ${rpcMethod}`);
      assert.deepEqual(answer, { ok: routed[0].name }, `${tool} must return its runtime operation's answer`);
    }

    // The wait-event client method is transport-only, not a Supervisor tool,
    // but it remains part of the parent RPC contract and must stay reachable.
    routed.length = 0;
    const waitAnswer = await client.waitEvent({ events: ['worker.completed'] });
    assert.equal(routed.length, 1, 'dev.worker.wait_event must reach exactly one runtime operation');
    assert.equal(routed[0].name, CLIENT_METHOD_FOR['dev.worker.wait_event']);
    assert.deepEqual(waitAnswer, { ok: routed[0].name });

    // Exercise every allow-listed method directly as well. This catches a
    // method removed from DEV_PARENT_RPC_METHODS even if a surface mapping is
    // accidentally edited in the same test.
    for (const method of DEV_PARENT_RPC_METHODS) {
      routed.length = 0;
      const clientMethod = CLIENT_METHOD_FOR[method];
      assert.ok(clientMethod, `RPC method ${method} has no client method`);
      assert.equal(typeof client[clientMethod], 'function', `client.${clientMethod}() must exist for ${method}`);
      const answer = await client[clientMethod]({});
      assert.equal(routed.length, 1, `${method} must reach exactly one runtime operation`);
      assert.deepEqual(answer, { ok: routed[0].name }, `${method} must return its runtime operation's answer`);
    }
    const runtimeOperations = new Set();
    for (const method of DEV_PARENT_RPC_METHODS) {
      routed.length = 0;
      await client[CLIENT_METHOD_FOR[method]]({});
      assert.equal(runtimeOperations.has(routed[0].name), false, `${method} shares a runtime operation with another method`);
      runtimeOperations.add(routed[0].name);
    }

    await assert.rejects(
      client.graphStatus({}, { signal: abortedSignal() }),
      (error) => error?.code === 'cancelled',
      'cancellation semantics are preserved',
    );
  } finally {
    client.close();
    server.close();
    port1.close();
    port2.close();
  }
}

function runtimeMethodFor(rpcMethod) {
  const graphMethods = Object.freeze({
    'dev.task_graph.start': 'taskGraphStart',
    'dev.task_graph.status': 'taskGraphStatus',
    'dev.task_graph.task_result': 'taskGraphTaskResult',
    'dev.task_graph.cancel': 'taskGraphCancel',
  });
  return graphMethods[rpcMethod] || CLIENT_METHOD_FOR[rpcMethod];
}

function publicToolArguments(tool) {
  if (tool === DEV_WORKER_TOOL.SEND) return { instruction: 'parity probe' };
  if (tool === DEV_WORKER_TOOL.FOLLOWUP) return { text: 'parity probe' };
  if (tool === DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE) return { index: 0 };
  if (tool === DEV_ADMIN_TOOL.SKILL_DESCRIBE) return { skillId: 'parity' };
  if (tool === DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE) return { manifest: {} };
  if (tool === DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE) return { skillId: 'parity' };
  if (tool === DEV_ADMIN_TOOL.SKILL_ACTIVATE) return { skillId: 'parity' };
  if (tool === DEV_ADMIN_TOOL.SKILL_ROLLBACK) return { skillId: 'parity' };
  if (tool === DEV_ADMIN_TOOL.SKILL_RUN) return { skillId: 'parity', program: 'probe' };
  if ([
    DEV_ADMIN_TOOL.POOL_CREATE_CHAT,
    DEV_ADMIN_TOOL.POOL_OBSERVE,
    DEV_ADMIN_TOOL.POOL_RESULT,
    DEV_ADMIN_TOOL.POOL_NUDGE,
    DEV_ADMIN_TOOL.POOL_STOP,
    DEV_ADMIN_TOOL.POOL_RELEASE,
  ].includes(tool)) return { leaseId: 'parity-lease' };
  if (tool === DEV_ADMIN_TOOL.POOL_START) return { leaseId: 'parity-lease', instruction: 'parity probe' };
  if (tool === DEV_ADMIN_TOOL.POOL_FOLLOWUP) return { leaseId: 'parity-lease', text: 'parity probe' };
  if (tool === DEV_ADMIN_TOOL.GRAPH_STATUS || tool === DEV_ADMIN_TOOL.GRAPH_CANCEL) return { graphId: 'parity-graph' };
  if (tool === DEV_ADMIN_TOOL.GRAPH_TASK_RESULT) return { graphId: 'parity-graph', taskId: 'parity-task' };
  return {};
}

function unknownToolsAreStillRejected() {
  const admin = createDevAdminToolSurface(adminClientStub());
  assert.equal(admin.has('worker.graph.wait'), false);
  assert.throws(() => admin.execute('worker.graph.wait', {}), /Unavailable Dev Admin tool/);
  assert.throws(() => admin.execute('', {}), /Unavailable Dev Admin tool/);

  const worker = createDevWorkerToolSurface(workerClientStub());
  assert.equal(worker.has('worker.pool.claim'), false, 'the single-slot surface must not answer for Pool tools');
  assert.throws(() => worker.execute('worker.pool.claim', {}), /Unavailable Dev Worker tool/);

  // The Standard Agent has no Dev tool surface at all.
  assert.equal(createDevAdminToolSurface({ enabled: false }), null);
  assert.equal(createDevAdminToolSurface(null), null);
  assert.equal(createDevWorkerToolSurface({ enabled: false }), null);
  assert.equal(createDevWorkerToolSurface({ discover() {} }), null, 'a partial client must not become a usable Dev surface');
}

/* CARD H1: the registry is the one truth every projection is derived from.
   These prove the projections still agree with it and with each other. */
function everyExposedToolHasCanonicalMetadata() {
  for (const tool of PUBLIC_TOOLS) {
    const contract = devToolContract(tool);
    assert.ok(contract, `${tool} is exposed but has no canonical metadata`);
    assert.ok(contract.owner && typeof contract.owner === 'string', `${tool} must declare a non-empty owner`);
    assert.ok(contract.argumentContract.length > 0, `${tool} must declare an argument contract`);
    assert.ok(
      Object.values(DEV_OPERATION_CLASS).includes(contract.operationClass),
      `${tool} operation class must be one of the allowed classes, got ${contract.operationClass}`,
    );
  }
  assert.equal(DEV_TOOL_CONTRACTS.length, PUBLIC_TOOLS.length, 'the registry describes exactly the exposed tools, no more');
  assert.equal(new Set(DEV_TOOL_CONTRACTS.map((item) => item.publicName)).size, DEV_TOOL_CONTRACTS.length, 'tool names are unique');

  // The surfaces are projections of the registry, in registry order.
  assert.deepEqual([...DEV_ADMIN_TOOLS], [...devToolNamesForSurface(DEV_TOOL_SURFACE.ADMIN)], 'the Admin surface is the registry Admin projection');
  assert.deepEqual([...DEV_WORKER_TOOLS], [...devToolNamesForSurface(DEV_TOOL_SURFACE.WORKER)], 'the Worker surface matches its registry projection');

  // RPC-backed entries must name a real RPC method and its real client method.
  const rpcMethods = new Set(DEV_PARENT_RPC_METHODS);
  for (const contract of DEV_TOOL_CONTRACTS) {
    if (!contract.rpcName) continue;
    assert.ok(rpcMethods.has(contract.rpcName), `${contract.publicName} names a non-existent RPC method ${contract.rpcName}`);
    assert.equal(
      CLIENT_METHOD_FOR[contract.rpcName],
      contract.clientMethod,
      `${contract.publicName} must name the same client method the RPC transport uses`,
    );
  }
  // dev.worker.wait_event has no public tool, and must not gain one silently.
  const mapped = new Set(DEV_TOOL_CONTRACTS.map((item) => item.rpcName).filter(Boolean));
  assert.deepEqual(
    DEV_PARENT_RPC_METHODS.filter((method) => !mapped.has(method)),
    ['dev.worker.wait_event'],
    'every RPC method except the internal wait_event transport is owned by exactly one public tool',
  );
}

/* Tools whose misclassification would be dangerous. An independent expectation,
   deliberately not derived from the registry: a registry that reclassified any
   of these as an observation would otherwise make itself batch-eligible. */
const MUST_NOT_BE_OBSERVATION = Object.freeze({
  [DEV_ADMIN_TOOL.POOL_PROVISION]: DEV_OPERATION_CLASS.MUTATION,
  [DEV_ADMIN_TOOL.POOL_CLAIM]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.POOL_CREATE_CHAT]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.POOL_START]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.POOL_STOP]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.POOL_RELEASE]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.POOL_FOLLOWUP]: DEV_OPERATION_CLASS.FULL_TURN,
  [DEV_ADMIN_TOOL.POOL_NUDGE]: DEV_OPERATION_CLASS.FULL_TURN,
  [DEV_ADMIN_TOOL.GRAPH_START]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.GRAPH_CANCEL]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE]: DEV_OPERATION_CLASS.MUTATION,
  [DEV_ADMIN_TOOL.SKILL_ACTIVATE]: DEV_OPERATION_CLASS.MUTATION,
  [DEV_ADMIN_TOOL.SKILL_ROLLBACK]: DEV_OPERATION_CLASS.MUTATION,
  [DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_ADMIN_TOOL.SKILL_RUN]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_WORKER_TOOL.CLAIM]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_WORKER_TOOL.CREATE_CHAT]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_WORKER_TOOL.SEND]: DEV_OPERATION_CLASS.FULL_TURN,
  [DEV_WORKER_TOOL.FOLLOWUP]: DEV_OPERATION_CLASS.FULL_TURN,
  [DEV_WORKER_TOOL.NUDGE]: DEV_OPERATION_CLASS.FULL_TURN,
  [DEV_WORKER_TOOL.STOP]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_WORKER_TOOL.RELEASE]: DEV_OPERATION_CLASS.CONTROL,
  [DEV_RUNTIME_ACTIVATION_TOOL]: DEV_OPERATION_CLASS.CONTROL,
});

// The returned identity is read-only data, but the normal handler also
// updates the self-update gate. That ownership-state side effect makes it
// ineligible for H2 even while its operation class remains observation.
const MUST_NOT_BE_BATCHABLE = Object.freeze([
  DEV_ADMIN_TOOL.RUNTIME_IDENTITY,
]);

/* Batch eligibility is opt-in and fails closed. This card adds no batch tool;
   it only makes the eligibility explicit for CARD H2. */
function batchEligibilityIsOptInAndFailsClosed() {
  for (const contract of DEV_TOOL_CONTRACTS) {
    assert.ok(
      Object.values(DEV_BATCH_POLICY).includes(contract.batchPolicy),
      `${contract.publicName} batch policy must be a known value`,
    );
    if (contract.operationClass !== DEV_OPERATION_CLASS.OBSERVATION) {
      assert.equal(
        contract.batchPolicy,
        DEV_BATCH_POLICY.NEVER,
        `${contract.publicName} is ${contract.operationClass}, so it must never be batch-eligible`,
      );
    }
  }

  // Nothing that mutates, controls, or takes a full turn may be batched.
  const batchable = DEV_TOOL_CONTRACTS.filter((item) => item.batchPolicy === DEV_BATCH_POLICY.OBSERVATION);
  assert.ok(batchable.length > 0, 'at least one observation is eligible, or H2 would have nothing to batch');
  for (const contract of batchable) {
    assert.equal(contract.operationClass, DEV_OPERATION_CLASS.OBSERVATION);
    assert.equal(
      contract.argumentContract.includes('leaseId'),
      false,
      `${contract.publicName} is lease-scoped, which is exactly the ambiguity batch policy must refuse`,
    );
  }

  // A state-changing tool must never be reclassified into eligibility.
  for (const [tool, expected] of Object.entries(MUST_NOT_BE_OBSERVATION)) {
    assert.equal(devToolOperationClass(tool), expected, `${tool} must stay classified as ${expected}`);
    assert.notEqual(devToolOperationClass(tool), DEV_OPERATION_CLASS.OBSERVATION, `${tool} changes state and is never an observation`);
    assert.equal(devToolBatchPolicy(tool), DEV_BATCH_POLICY.NEVER);
  }
  for (const tool of MUST_NOT_BE_BATCHABLE) {
    assert.equal(devToolOperationClass(tool), DEV_OPERATION_CLASS.OBSERVATION);
    assert.equal(devToolBatchPolicy(tool), DEV_BATCH_POLICY.NEVER, `${tool} has ownership-state side effects and must never be batchable`);
  }

  // The fail-closed rule itself, across every combination.
  assert.equal(devBatchPolicyFor(DEV_OPERATION_CLASS.OBSERVATION, DEV_BATCH_POLICY.OBSERVATION), DEV_BATCH_POLICY.OBSERVATION);
  assert.equal(devBatchPolicyFor(DEV_OPERATION_CLASS.OBSERVATION, undefined), DEV_BATCH_POLICY.NEVER, 'opting in is required');
  assert.equal(devBatchPolicyFor(DEV_OPERATION_CLASS.OBSERVATION, 'yes-please'), DEV_BATCH_POLICY.NEVER, 'an unknown value is never');
  for (const operationClass of [DEV_OPERATION_CLASS.MUTATION, DEV_OPERATION_CLASS.CONTROL, DEV_OPERATION_CLASS.FULL_TURN, DEV_OPERATION_CLASS.WAIT, 'invented']) {
    assert.equal(
      devBatchPolicyFor(operationClass, DEV_BATCH_POLICY.OBSERVATION),
      DEV_BATCH_POLICY.NEVER,
      `${operationClass} can never opt into batching`,
    );
  }

  // A tool the registry does not describe is never batch-eligible.
  assert.equal(devToolBatchPolicy('worker.graph.wait'), DEV_BATCH_POLICY.NEVER);
  assert.equal(devToolBatchPolicy(''), DEV_BATCH_POLICY.NEVER);
  assert.equal(devToolBatchPolicy(undefined), DEV_BATCH_POLICY.NEVER);
  assert.equal(devToolOperationClass('not.a.tool'), null, 'unknown metadata is null, never a guess');
}

const CLIENT_METHOD_FOR = Object.freeze({
  'dev.worker.discover': 'discover',
  'dev.worker.claim': 'claim',
  'dev.worker.create_chat': 'createChat',
  'dev.worker.send': 'send',
  'dev.worker.observe': 'observe',
  'dev.worker.followup': 'followup',
  'dev.worker.nudge': 'nudge',
  'dev.worker.stop': 'stop',
  'dev.worker.result': 'result',
  'dev.worker.release': 'release',
  'dev.worker.wait_event': 'waitEvent',
  'dev.runtime.identity': 'runtimeIdentity',
  'dev.admin.page_snapshot': 'pageSnapshot',
  'dev.admin.page_scripts': 'pageScripts',
  'dev.admin.page_script_source': 'pageScriptSource',
  'dev.skill.list': 'skillList',
  'dev.skill.describe': 'skillDescribe',
  'dev.skill.install_candidate': 'skillInstallCandidate',
  'dev.skill.validate_candidate': 'skillValidateCandidate',
  'dev.skill.activate': 'skillActivate',
  'dev.skill.rollback': 'skillRollback',
  'dev.skill.run': 'skillRun',
  'dev.worker_pool.status': 'poolStatus',
  'dev.worker_pool.provision': 'poolProvision',
  'dev.worker_pool.claim': 'poolClaim',
  'dev.worker_pool.create_chat': 'poolCreateChat',
  'dev.worker_pool.start': 'poolStart',
  'dev.worker_pool.observe': 'poolObserve',
  'dev.worker_pool.result': 'poolResult',
  'dev.worker_pool.followup': 'poolFollowup',
  'dev.worker_pool.nudge': 'poolNudge',
  'dev.worker_pool.stop': 'poolStop',
  'dev.worker_pool.release': 'poolRelease',
  'dev.task_graph.start': 'graphStart',
  'dev.task_graph.status': 'graphStatus',
  'dev.task_graph.task_result': 'graphTaskResult',
  'dev.task_graph.cancel': 'graphCancel',
});

function adminClientStub() {
  const client = { enabled: true };
  for (const name of [
    'runtimeIdentity', 'pageSnapshot', 'pageScripts', 'pageScriptSource',
    'skillList', 'skillDescribe', 'skillInstallCandidate', 'skillValidateCandidate',
    'skillActivate', 'skillRollback', 'skillRun',
    'poolStatus', 'poolProvision', 'poolClaim', 'poolCreateChat', 'poolStart',
    'poolObserve', 'poolResult', 'poolFollowup', 'poolNudge', 'poolStop', 'poolRelease',
    'graphStart', 'graphStatus', 'graphTaskResult', 'graphCancel',
  ]) client[name] = async () => ({ called: name });
  return client;
}

function workerClientStub() {
  const client = { enabled: true };
  for (const name of [
    'discover', 'claim', 'createChat', 'send', 'observe', 'followup',
    'nudge', 'stop', 'result', 'release', 'waitEvent',
  ]) client[name] = async () => ({ called: name });
  return client;
}

function abortedSignal() {
  const controller = new AbortController();
  controller.abort('parity-cancelled');
  return controller.signal;
}

everyPublicToolIsCallableFromThePrompt();
thePromptNeverAdvertisesAToolThatDoesNotExist();
await everyAdminToolReachesADistinctRuntimeOperation();
unknownToolsAreStillRejected();
everyExposedToolHasCanonicalMetadata();
batchEligibilityIsOptInAndFailsClosed();
console.log('dev tool contract parity: ok');
