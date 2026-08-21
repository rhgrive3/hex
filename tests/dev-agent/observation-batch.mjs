/* CARD H2 focused regression.
   The batch is a host-side Admin surface operation. Its targets must remain
   ordinary H1 registry entries and must use the same client handlers as a
   direct call. This test intentionally starts red on a pre-H2 main. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEV_ADMIN_TOOL, DEV_ADMIN_TOOLS, createDevAdminToolSurface } from '../../js/ai/dev/admin/tool-surface.js';
import {
  DEV_BATCH_POLICY,
  DEV_OPERATION_CLASS,
  DEV_TOOL_CONTRACTS,
  devToolBatchPolicy,
  devToolContract,
  devToolOperationClass,
} from '../../js/ai/dev/protocol/dev-tool-contracts.js';

const BATCH_MAX_CALLS = 6;
const BATCH_TOOL = DEV_ADMIN_TOOL.BATCH_OBSERVE;

/* These are the H1 entries explicitly opted in to H2. Keep this expectation
   independent of the registry projection so a dangerous reclassification does
   not make the test bless itself. */
const EXPECTED_BATCHABLE_TOOLS = Object.freeze([
  DEV_ADMIN_TOOL.PAGE_SNAPSHOT,
  DEV_ADMIN_TOOL.PAGE_SCRIPTS,
  DEV_ADMIN_TOOL.SKILL_LIST,
  DEV_ADMIN_TOOL.SKILL_DESCRIBE,
  DEV_ADMIN_TOOL.POOL_STATUS,
  DEV_ADMIN_TOOL.GRAPH_STATUS,
  DEV_ADMIN_TOOL.GRAPH_TASK_RESULT,
]);

const CLIENT_METHODS = Object.freeze([
  'runtimeIdentity', 'pageSnapshot', 'pageScripts', 'pageScriptSource',
  'skillList', 'skillDescribe', 'skillInstallCandidate', 'skillValidateCandidate',
  'skillActivate', 'skillRollback', 'skillRun',
  'poolStatus', 'poolProvision', 'poolClaim', 'poolCreateChat', 'poolStart',
  'poolObserve', 'poolResult', 'poolFollowup', 'poolNudge', 'poolStop', 'poolRelease',
  'graphStart', 'graphStatus', 'graphTaskResult', 'graphCancel',
]);

function makeClient() {
  const calls = [];
  const failures = new Map();
  let active = 0;
  let maxActive = 0;
  const client = { enabled: true };

  for (const method of CLIENT_METHODS) {
    client[method] = async (args = {}) => {
      calls.push({ method, arguments: args });
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        // The yield makes accidental Promise.all/parallel dispatch observable.
        await Promise.resolve();
        const failure = failures.get(method);
        if (failure) {
          failures.delete(method);
          throw failure;
        }
        return { observedBy: method, arguments: { ...args } };
      } finally {
        active -= 1;
      }
    };
  }

  return Object.freeze({
    client,
    calls,
    failNext(method, error) { failures.set(method, error); },
    get maxActive() { return maxActive; },
  });
}

function call(tool, argumentsValue = {}) {
  return { tool, arguments: argumentsValue };
}

function adminFor(fixture) {
  const admin = createDevAdminToolSurface(fixture.client);
  assert.ok(admin, 'the enabled fixture must produce an Admin surface');
  return admin;
}

function resultEntries(answer) {
  assert.ok(answer && typeof answer === 'object', 'the batch result must be an object');
  assert.ok(Array.isArray(answer.results), 'the batch result must contain ordered results');
  return answer.results;
}

function assertSuccessfulEntry(entry, index, tool, method) {
  assert.deepEqual(
    entry && { index: entry.index, tool: entry.tool, ok: entry.ok },
    { index, tool, ok: true },
    `${tool} must be a successful ordered entry`,
  );
  assert.deepEqual(entry.result, { observedBy: method, arguments: {} });
}

async function canonicalRegistryAndSurfaceContract() {
  assert.equal(BATCH_TOOL, 'dev.batch.observe', 'H2 must use the documented public name');
  assert.ok(DEV_ADMIN_TOOLS.includes(BATCH_TOOL), 'H2 must be an Admin projection of the H1 registry');

  const batchContract = devToolContract(BATCH_TOOL);
  assert.ok(batchContract, 'the batch tool must have canonical H1 metadata');
  assert.equal(batchContract.batchPolicy, DEV_BATCH_POLICY.NEVER, 'the batch dispatcher cannot be nested');
  assert.equal(devToolBatchPolicy(BATCH_TOOL), DEV_BATCH_POLICY.NEVER);

  assert.deepEqual(
    DEV_TOOL_CONTRACTS.filter((contract) => contract.batchPolicy === DEV_BATCH_POLICY.OBSERVATION).map((contract) => contract.publicName),
    EXPECTED_BATCHABLE_TOOLS,
    'only the explicitly opted-in H1 observations may be batchable, in registry order',
  );
  for (const tool of EXPECTED_BATCHABLE_TOOLS) {
    assert.equal(devToolOperationClass(tool), DEV_OPERATION_CLASS.OBSERVATION, `${tool} must remain an observation`);
    assert.equal(devToolBatchPolicy(tool), DEV_BATCH_POLICY.OBSERVATION, `${tool} must explicitly opt in`);
  }

  // The returned identity updates the self-update gate and lease-scoped reads
  // are ambiguous. Both must remain normal direct observations only.
  for (const tool of [
    DEV_ADMIN_TOOL.RUNTIME_IDENTITY,
<<<<<<< HEAD
=======
    DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE,
>>>>>>> origin/main
    DEV_ADMIN_TOOL.POOL_OBSERVE,
    DEV_ADMIN_TOOL.POOL_RESULT,
  ]) {
    assert.equal(devToolOperationClass(tool), DEV_OPERATION_CLASS.OBSERVATION);
    assert.equal(devToolBatchPolicy(tool), DEV_BATCH_POLICY.NEVER, `${tool} must fail closed`);
  }
  assert.equal(devToolOperationClass('dev.worker.wait_event'), null, 'the internal wait path is not a public target');
  assert.equal(devToolBatchPolicy('dev.worker.wait_event'), DEV_BATCH_POLICY.NEVER);
}

async function orderedEligibleObservationsUseNormalHandlers() {
  const fixture = makeClient();
  const admin = adminFor(fixture);
  const answer = await admin.execute(BATCH_TOOL, {
    calls: [
      call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT),
      call(DEV_ADMIN_TOOL.PAGE_SCRIPTS),
      call(DEV_ADMIN_TOOL.POOL_STATUS),
    ],
  });
  const results = resultEntries(answer);

  assert.deepEqual(
    results.map(({ index, tool, ok }) => ({ index, tool, ok })),
    [
      { index: 0, tool: DEV_ADMIN_TOOL.PAGE_SNAPSHOT, ok: true },
      { index: 1, tool: DEV_ADMIN_TOOL.PAGE_SCRIPTS, ok: true },
      { index: 2, tool: DEV_ADMIN_TOOL.POOL_STATUS, ok: true },
    ],
  );
  assertSuccessfulEntry(results[0], 0, DEV_ADMIN_TOOL.PAGE_SNAPSHOT, 'pageSnapshot');
  assertSuccessfulEntry(results[1], 1, DEV_ADMIN_TOOL.PAGE_SCRIPTS, 'pageScripts');
  assertSuccessfulEntry(results[2], 2, DEV_ADMIN_TOOL.POOL_STATUS, 'poolStatus');
  assert.deepEqual(fixture.calls.map(({ method }) => method), ['pageSnapshot', 'pageScripts', 'poolStatus']);
  assert.equal(fixture.maxActive, 1, 'H2 must execute sequentially, not through a parallel scheduler');
}

async function aFailureIsDistinctAndDoesNotStopLaterValidatedObservations() {
  const fixture = makeClient();
  fixture.failNext('pageScripts', Object.assign(new Error('synthetic observation failure'), { code: 'observation-failed' }));
  const admin = adminFor(fixture);
  const results = resultEntries(await admin.execute(BATCH_TOOL, {
    calls: [call(DEV_ADMIN_TOOL.PAGE_SCRIPTS), call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT)],
  }));

  assert.deepEqual(fixture.calls.map(({ method }) => method), ['pageScripts', 'pageSnapshot']);
  assert.equal(results[0].index, 0);
  assert.equal(results[0].tool, DEV_ADMIN_TOOL.PAGE_SCRIPTS);
  assert.equal(results[0].ok, false, 'a failed observation must not become a success');
  assert.equal(results[0].result, undefined);
  assert.ok(results[0].error && typeof results[0].error === 'object');
  assert.equal(results[0].error.code, 'observation-failed');
  assert.equal(results[0].error.message, 'synthetic observation failure');
  assert.equal(results[0].error.message.length <= 512, true, 'batch errors must be bounded');

  assertSuccessfulEntry(results[1], 1, DEV_ADMIN_TOOL.PAGE_SNAPSHOT, 'pageSnapshot');
}

async function directAndBatchedCallsShareTheNormalHandlerPath() {
  const fixture = makeClient();
  const admin = adminFor(fixture);
  const argumentsValue = { selectors: ['main'] };
  const direct = await admin.execute(DEV_ADMIN_TOOL.PAGE_SNAPSHOT, argumentsValue);
  const results = resultEntries(await admin.execute(BATCH_TOOL, {
    calls: [call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT, argumentsValue)],
  }));

  assert.deepEqual(results[0].result, direct, 'batching must preserve direct observation result semantics');
  assert.deepEqual(fixture.calls.map(({ method }) => method), ['pageSnapshot', 'pageSnapshot']);
}

async function assertRejectedBeforeAnyTargetDispatch(label, request) {
  const fixture = makeClient();
  const admin = adminFor(fixture);
  await assert.rejects(
    async () => { await admin.execute(BATCH_TOOL, request); },
    undefined,
    `${label} must reject deterministically`,
  );
  assert.deepEqual(fixture.calls, [], `${label} must reject before the first target dispatch`);
}

async function invalidTargetsAndBatchShapesFailClosedBeforeDispatch() {
  const valid = call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT);
  await assertRejectedBeforeAnyTargetDispatch('mutation target', {
    calls: [valid, call(DEV_ADMIN_TOOL.SKILL_ACTIVATE, { skillId: 'x' })],
  });
  await assertRejectedBeforeAnyTargetDispatch('control target', {
    calls: [valid, call(DEV_ADMIN_TOOL.GRAPH_CANCEL, { graphId: 'g' })],
  });
  await assertRejectedBeforeAnyTargetDispatch('full-turn target', {
    calls: [valid, call(DEV_ADMIN_TOOL.POOL_FOLLOWUP, { leaseId: 'lease', text: 'x' })],
  });
  await assertRejectedBeforeAnyTargetDispatch('wait target', {
    calls: [valid, call('dev.worker.wait_event', { events: ['worker.completed'] })],
  });
  await assertRejectedBeforeAnyTargetDispatch('unknown target with missing metadata', {
    calls: [valid, call('dev.unknown.observation')],
  });
  await assertRejectedBeforeAnyTargetDispatch('nested batch target', {
    calls: [valid, call(BATCH_TOOL, { calls: [valid] })],
  });
  await assertRejectedBeforeAnyTargetDispatch('runtime identity side-effect target', {
    calls: [valid, call(DEV_ADMIN_TOOL.RUNTIME_IDENTITY)],
  });
  await assertRejectedBeforeAnyTargetDispatch('lease-scoped observation target', {
    calls: [valid, call(DEV_ADMIN_TOOL.POOL_OBSERVE, { leaseId: 'lease' })],
  });
<<<<<<< HEAD
=======
  await assertRejectedBeforeAnyTargetDispatch('non-batchable script source target', {
    calls: [valid, call(DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE, { needle: 'probe' })],
  });
  await assertRejectedBeforeAnyTargetDispatch('target-specific invalid graph identity', {
    calls: [valid, call(DEV_ADMIN_TOOL.GRAPH_STATUS, { graphId: 'not a graph id' })],
  });
  await assertRejectedBeforeAnyTargetDispatch('target-specific invalid skill identity', {
    calls: [valid, call(DEV_ADMIN_TOOL.SKILL_DESCRIBE, { skillId: 'Not-A-Skill' })],
  });
>>>>>>> origin/main

  const malformedRequests = [
    ['missing calls', {}],
    ['empty calls', { calls: [] }],
    ['too many calls', { calls: Array.from({ length: BATCH_MAX_CALLS + 1 }, () => valid) }],
    ['calls not an array', { calls: null }],
    ['missing call entry', { calls: [null] }],
    ['missing tool', { calls: [{ arguments: {} }] }],
    ['non-string tool', { calls: [{ tool: 7 }] }],
    ['blank tool', { calls: [call('')] }],
    ['extra call key', { calls: [{ ...valid, extra: true }] }],
    ['arguments not a plain object', { calls: [call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT, [])] }],
    ['non-JSON-safe argument', { calls: [call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT, { callback: () => {} })] }],
  ];
  for (const [label, request] of malformedRequests) {
    await assertRejectedBeforeAnyTargetDispatch(label, request);
  }
}

async function onePublicDecisionCanCollectThreeObservations() {
  const fixture = makeClient();
  const admin = adminFor(fixture);
  let publicDecisions = 0;
  const answerOnePublicDecision = async () => {
    publicDecisions += 1;
    return admin.execute(BATCH_TOOL, {
      calls: [
        call(DEV_ADMIN_TOOL.PAGE_SNAPSHOT),
        call(DEV_ADMIN_TOOL.PAGE_SCRIPTS),
        call(DEV_ADMIN_TOOL.GRAPH_STATUS, { graphId: 'g' }),
      ],
    });
  };

  const results = resultEntries(await answerOnePublicDecision());
  assert.equal(publicDecisions, 1, 'the deterministic fixture uses one public Supervisor tool decision');
  assert.equal(fixture.calls.length, 3, 'one batch decision must still perform three normal observations');
  assert.deepEqual(results.map(({ tool, ok }) => ({ tool, ok })), [
    { tool: DEV_ADMIN_TOOL.PAGE_SNAPSHOT, ok: true },
    { tool: DEV_ADMIN_TOOL.PAGE_SCRIPTS, ok: true },
    { tool: DEV_ADMIN_TOOL.GRAPH_STATUS, ok: true },
  ]);
}

async function forbiddenExecutionPrimitivesAreAbsentFromTheBatchSurface() {
  const source = await readFile(new URL('../../js/ai/dev/admin/tool-surface.js', import.meta.url), 'utf8');
  for (const [label, pattern] of [
    ['eval', /\beval\s*\(/],
    ['Function constructor', /\bnew\s+Function\s*\(/],
    ['parallel Promise.all dispatch', /\bPromise\.all\s*\(/],
    ['interval scheduler', /\bsetInterval\s*\(/],
  ]) {
    assert.equal(pattern.test(source), false, `H2 must not introduce a ${label}`);
  }
}

await canonicalRegistryAndSurfaceContract();
await orderedEligibleObservationsUseNormalHandlers();
await aFailureIsDistinctAndDoesNotStopLaterValidatedObservations();
await directAndBatchedCallsShareTheNormalHandlerPath();
await invalidTargetsAndBatchShapesFailClosedBeforeDispatch();
await onePublicDecisionCanCollectThreeObservations();
await forbiddenExecutionPrimitivesAreAbsentFromTheBatchSurface();
console.log('dev observation batch: ok');
