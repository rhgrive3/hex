/* One canonical description of every public Dev tool.

   The same tool used to be described in four places: the name a surface exposes,
   the argument contract the prompt renders, the client method the host calls,
   and the RPC method the runtime answers. Four copies drift, and CARD H0 found
   three that already had. This file is the single truth those projections are
   derived from.

   It is a static table, not a plugin system. There is no loader, no eval, no
   reflection dispatch, and no generic mega-handler: each surface still wires its
   own handlers explicitly, and the security-sensitive RPC dispatch is untouched.
*/
import { DEV_RUNTIME_ACTIVATION_TOOL, DEV_RUNTIME_IDENTITY_TOOL } from '../bootstrap/self-update-gate.js';

/* What kind of operation this is. Metadata only: it never grants permission and
   never changes RPC or runtime timeout behaviour. */
export const DEV_OPERATION_CLASS = Object.freeze({
  CONTROL: 'control',
  OBSERVATION: 'observation',
  WAIT: 'wait',
  FULL_TURN: 'full-turn',
  MUTATION: 'mutation',
});
const OPERATION_CLASSES = new Set(Object.values(DEV_OPERATION_CLASS));

/* Which surface exposes the tool to the Supervisor. */
export const DEV_TOOL_SURFACE = Object.freeze({
  WORKER: 'worker',
  ADMIN: 'admin',
  RUNTIME: 'runtime',
});

/* Where the authority and the evidence come from. This records ownership; it is
   not a permission grant, and nothing may infer authority from prose at call
   time when the registry states it directly. */
export const DEV_TOOL_OWNER = Object.freeze({
  DEV_RUNTIME: 'dev-runtime',
  SINGLE_SLOT_WORKER: 'single-slot-worker',
  CHATGPT_PAGE: 'chatgpt-page',
  DOM_SKILL_SYSTEM: 'dom-skill-system',
  WORKER_POOL: 'worker-pool',
  TASK_GRAPH: 'task-graph',
});

/* Whether a tool may ever join the bounded read-only observation batch of
   CARD H2. The batch dispatcher is itself explicitly `never`; this metadata
   only opts normal read-only observations into the existing direct path.
   `observation` is opt-in and is granted only to a read-only, idempotent
   observation whose normal handler runs without touching repository, runtime or
   DOM ownership state. Everything else -- including anything lease-scoped, and
   anything at all uncertain -- is `never`. */
export const DEV_BATCH_POLICY = Object.freeze({ NEVER: 'never', OBSERVATION: 'observation' });
export const DEV_BATCH_MAX_CALLS = 6;

const { CONTROL, OBSERVATION, FULL_TURN, MUTATION } = DEV_OPERATION_CLASS;
const { NEVER, OBSERVATION: BATCHABLE } = DEV_BATCH_POLICY;

const BATCH_SELECTOR = /^[^\u0000\r\n]{1,256}$/;
const BATCH_SKILL_ID = /^[a-z0-9][a-z0-9._-]{1,95}$/;
const BATCH_GRAPH_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;

function validateEmptyBatchArguments(args) {
  assertBatchObject(args);
  assertBatchKeys(args, []);
}

function validatePageSnapshotBatchArguments(args) {
  assertBatchObject(args);
  assertBatchKeys(args, ['selectors', 'includeHtml', 'htmlSelector', 'maxNodes', 'maxHtmlChars']);
  if (args.selectors != null) {
    if (!Array.isArray(args.selectors) || args.selectors.length > 16) throw new TypeError('selectors must contain at most 16 items.');
    for (const selector of args.selectors) assertBatchString(selector, 'selector', BATCH_SELECTOR);
  }
  if (args.includeHtml != null && typeof args.includeHtml !== 'boolean') throw new TypeError('includeHtml must be boolean.');
  if (args.htmlSelector != null) assertBatchString(args.htmlSelector, 'htmlSelector', BATCH_SELECTOR);
  assertBatchFinite(args.maxNodes, 'maxNodes');
  assertBatchFinite(args.maxHtmlChars, 'maxHtmlChars');
}

function validatePageScriptSourceBatchArguments(args) {
  assertBatchObject(args);
  assertBatchKeys(args, ['index', 'src', 'offset', 'maxChars', 'needle', 'contextChars', 'maxMatches']);
  const hasIndex = args.index != null && args.index !== '';
  const hasSrc = args.src != null && args.src !== '';
  if (!hasIndex && !hasSrc) throw new TypeError('script_source requires an index or src.');
  if (hasIndex) assertBatchFinite(args.index, 'index');
  if (hasSrc) assertBatchString(args.src, 'src', /^[^\u0000\r\n]{1,4096}$/);
  assertBatchFinite(args.offset, 'offset');
  assertBatchFinite(args.maxChars, 'maxChars');
  assertBatchFinite(args.contextChars, 'contextChars');
  assertBatchFinite(args.maxMatches, 'maxMatches');
  if (args.needle != null) assertBatchString(args.needle, 'needle', /^[^\u0000\r\n]{0,160}$/);
}

function validateSkillDescribeBatchArguments(args) {
  assertBatchObject(args);
  assertBatchKeys(args, ['skillId']);
  assertBatchPattern(args.skillId, 'skillId', BATCH_SKILL_ID);
}

function validateGraphStatusBatchArguments(args) {
  assertBatchObject(args);
  assertBatchKeys(args, ['graphId']);
  assertBatchPattern(args.graphId, 'graphId', BATCH_GRAPH_ID);
}

function validateGraphTaskResultBatchArguments(args) {
  assertBatchObject(args);
  assertBatchKeys(args, ['graphId', 'taskId']);
  assertBatchPattern(args.graphId, 'graphId', BATCH_GRAPH_ID);
  assertBatchPattern(args.taskId, 'taskId', BATCH_GRAPH_ID);
}

function assertBatchObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Batch target arguments must be a plain object.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Batch target arguments must be a plain object.');
}

function assertBatchKeys(value, allowed) {
  const expected = new Set(allowed);
  if (Object.keys(value).some((key) => !expected.has(key))) throw new TypeError('Batch target arguments contain an unknown field.');
}

function assertBatchString(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new TypeError(`${name} has an invalid value.`);
}

function assertBatchPattern(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new TypeError(`${name} has an invalid value.`);
}

function assertBatchFinite(value, name) {
  if (value == null || value === '') return;
  if (!Number.isFinite(Number(value))) throw new TypeError(`${name} must be finite.`);
}

/* Order is significant: the prompt renders argument contracts in this order and
   each surface exposes its tools in this order. */
const ENTRIES = [
  // Reading identity also observes/updates the self-update gate, so it is not
  // safe to replay through H2 even though the returned value is observational.
  entry(DEV_RUNTIME_IDENTITY_TOOL, DEV_TOOL_SURFACE.ADMIN, 'runtimeIdentity', OBSERVATION, DEV_TOOL_OWNER.DEV_RUNTIME, '{}', { rpcName: 'dev.runtime.identity', batchPolicy: NEVER }),
  entry(DEV_RUNTIME_ACTIVATION_TOOL, DEV_TOOL_SURFACE.RUNTIME, null, CONTROL, DEV_TOOL_OWNER.DEV_RUNTIME, '{"expectedCommit":"<merged 40-hex commit>","expectedBuildId":"<24-hex runtime buildId>","expectedUserscriptVersion":"<optional version>","capabilities":["<tool gated until activation>"],"reason":"<why the runtime must be reloaded>"}'),

  entry('worker.discover', DEV_TOOL_SURFACE.WORKER, 'discover', OBSERVATION, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.discover' }),
  entry('worker.claim', DEV_TOOL_SURFACE.WORKER, 'claim', CONTROL, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.claim' }),
  entry('worker.create_chat', DEV_TOOL_SURFACE.WORKER, 'createChat', CONTROL, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.create_chat' }),
  entry('worker.send', DEV_TOOL_SURFACE.WORKER, 'send', FULL_TURN, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{"instruction":"<specific task for the Worker>"}', { rpcName: 'dev.worker.send' }),
  entry('worker.observe', DEV_TOOL_SURFACE.WORKER, 'observe', OBSERVATION, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.observe' }),
  entry('worker.followup', DEV_TOOL_SURFACE.WORKER, 'followup', FULL_TURN, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{"text":"<follow-up instruction>"}', { rpcName: 'dev.worker.followup' }),
  entry('worker.nudge', DEV_TOOL_SURFACE.WORKER, 'nudge', FULL_TURN, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.nudge' }),
  entry('worker.stop', DEV_TOOL_SURFACE.WORKER, 'stop', CONTROL, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.stop' }),
  entry('worker.result', DEV_TOOL_SURFACE.WORKER, 'result', OBSERVATION, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.result' }),
  entry('worker.release', DEV_TOOL_SURFACE.WORKER, 'release', CONTROL, DEV_TOOL_OWNER.SINGLE_SLOT_WORKER, '{}', { rpcName: 'dev.worker.release' }),

  entry('chatgpt.page.snapshot', DEV_TOOL_SURFACE.ADMIN, 'pageSnapshot', OBSERVATION, DEV_TOOL_OWNER.CHATGPT_PAGE, '{"selectors":["<CSS selector>"],"includeHtml":false,"htmlSelector":"<CSS selector>","maxNodes":96,"maxHtmlChars":16384}', { rpcName: 'dev.admin.page_snapshot', batchPolicy: BATCHABLE, batchArgumentValidator: validatePageSnapshotBatchArguments }),
  entry('chatgpt.page.scripts', DEV_TOOL_SURFACE.ADMIN, 'pageScripts', OBSERVATION, DEV_TOOL_OWNER.CHATGPT_PAGE, '{}', { rpcName: 'dev.admin.page_scripts', batchPolicy: BATCHABLE, batchArgumentValidator: validateEmptyBatchArguments }),
  entry('chatgpt.page.script_source', DEV_TOOL_SURFACE.ADMIN, 'pageScriptSource', OBSERVATION, DEV_TOOL_OWNER.CHATGPT_PAGE, '{"index":0,"offset":0,"maxChars":24576,"needle":"<optional literal>","contextChars":768,"maxMatches":5}', { rpcName: 'dev.admin.page_script_source', batchPolicy: BATCHABLE, batchArgumentValidator: validatePageScriptSourceBatchArguments }),

  entry('chatgpt.skill.list', DEV_TOOL_SURFACE.ADMIN, 'skillList', OBSERVATION, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{}', { rpcName: 'dev.skill.list', batchPolicy: BATCHABLE, batchArgumentValidator: validateEmptyBatchArguments }),
  entry('chatgpt.skill.describe', DEV_TOOL_SURFACE.ADMIN, 'skillDescribe', OBSERVATION, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{"skillId":"<skill id>"}', { rpcName: 'dev.skill.describe', batchPolicy: BATCHABLE, batchArgumentValidator: validateSkillDescribeBatchArguments }),
  entry('chatgpt.skill.install_candidate', DEV_TOOL_SURFACE.ADMIN, 'skillInstallCandidate', MUTATION, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{"manifest":{"schema":"hex-dom-skill-v1","skillId":"<skill id>","version":"<version>","validationPrograms":["probe"],"programs":{"probe":{"version":1,"name":"probe","readOnly":true,"steps":[]}}}}', { rpcName: 'dev.skill.install_candidate' }),
  entry('chatgpt.skill.validate_candidate', DEV_TOOL_SURFACE.ADMIN, 'skillValidateCandidate', CONTROL, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{"skillId":"<skill id>","programs":["probe"]}', { rpcName: 'dev.skill.validate_candidate' }),
  entry('chatgpt.skill.activate', DEV_TOOL_SURFACE.ADMIN, 'skillActivate', MUTATION, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{"skillId":"<skill id>"}', { rpcName: 'dev.skill.activate' }),
  entry('chatgpt.skill.rollback', DEV_TOOL_SURFACE.ADMIN, 'skillRollback', MUTATION, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{"skillId":"<skill id>"}', { rpcName: 'dev.skill.rollback' }),
  entry('chatgpt.skill.run', DEV_TOOL_SURFACE.ADMIN, 'skillRun', CONTROL, DEV_TOOL_OWNER.DOM_SKILL_SYSTEM, '{"skillId":"<skill id>","program":"<program>","args":{}}', { rpcName: 'dev.skill.run' }),

  entry('worker.pool.status', DEV_TOOL_SURFACE.ADMIN, 'poolStatus', OBSERVATION, DEV_TOOL_OWNER.WORKER_POOL, '{}', { rpcName: 'dev.worker_pool.status', batchPolicy: BATCHABLE, batchArgumentValidator: validateEmptyBatchArguments }),
  entry('worker.pool.provision', DEV_TOOL_SURFACE.ADMIN, 'poolProvision', MUTATION, DEV_TOOL_OWNER.WORKER_POOL, '{"size":"<how many Workers this work actually needs, up to 6>","projectUrl":"<optional ChatGPT Project URL>"}', { rpcName: 'dev.worker_pool.provision' }),
  entry('worker.pool.claim', DEV_TOOL_SURFACE.ADMIN, 'poolClaim', CONTROL, DEV_TOOL_OWNER.WORKER_POOL, '{"taskId":"<task id>","wait":true}', { rpcName: 'dev.worker_pool.claim' }),
  entry('worker.pool.create_chat', DEV_TOOL_SURFACE.ADMIN, 'poolCreateChat', CONTROL, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>"}', { rpcName: 'dev.worker_pool.create_chat' }),
  entry('worker.pool.start', DEV_TOOL_SURFACE.ADMIN, 'poolStart', CONTROL, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>","instruction":"<specific task>"}', { rpcName: 'dev.worker_pool.start' }),
  // Lease-scoped reads stay `never`: they are only meaningful against the lease
  // that owns them, so batching them across leases is exactly the ambiguity the
  // policy is meant to prevent.
  entry('worker.pool.observe', DEV_TOOL_SURFACE.ADMIN, 'poolObserve', OBSERVATION, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>"}', { rpcName: 'dev.worker_pool.observe' }),
  entry('worker.pool.result', DEV_TOOL_SURFACE.ADMIN, 'poolResult', OBSERVATION, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>"}', { rpcName: 'dev.worker_pool.result' }),
  entry('worker.pool.followup', DEV_TOOL_SURFACE.ADMIN, 'poolFollowup', FULL_TURN, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>","text":"<follow-up>"}', { rpcName: 'dev.worker_pool.followup' }),
  entry('worker.pool.nudge', DEV_TOOL_SURFACE.ADMIN, 'poolNudge', FULL_TURN, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>"}', { rpcName: 'dev.worker_pool.nudge' }),
  entry('worker.pool.stop', DEV_TOOL_SURFACE.ADMIN, 'poolStop', CONTROL, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>"}', { rpcName: 'dev.worker_pool.stop' }),
  entry('worker.pool.release', DEV_TOOL_SURFACE.ADMIN, 'poolRelease', CONTROL, DEV_TOOL_OWNER.WORKER_POOL, '{"leaseId":"<returned lease id>"}', { rpcName: 'dev.worker_pool.release' }),

  entry('worker.graph.start', DEV_TOOL_SURFACE.ADMIN, 'graphStart', CONTROL, DEV_TOOL_OWNER.TASK_GRAPH, '{"graphId":"<optional graph id>","maxConcurrency":"<1-6, only as many Workers as the graph needs>","tasks":[{"id":"<task id>","dependencies":["<task id this one waits for>"],"instruction":"<specific task>","maxAttempts":"<1-5>","timeoutMs":"<omit for no deadline, or an explicit deadline in ms>"}]}', { rpcName: 'dev.task_graph.start' }),
  entry('worker.graph.status', DEV_TOOL_SURFACE.ADMIN, 'graphStatus', OBSERVATION, DEV_TOOL_OWNER.TASK_GRAPH, '{"graphId":"<returned graph id>"}', { rpcName: 'dev.task_graph.status', batchPolicy: BATCHABLE, batchArgumentValidator: validateGraphStatusBatchArguments }),
  entry('worker.graph.task_result', DEV_TOOL_SURFACE.ADMIN, 'graphTaskResult', OBSERVATION, DEV_TOOL_OWNER.TASK_GRAPH, '{"graphId":"<returned graph id>","taskId":"<task id>"}', { rpcName: 'dev.task_graph.task_result', batchPolicy: BATCHABLE, batchArgumentValidator: validateGraphTaskResultBatchArguments }),
  entry('worker.graph.cancel', DEV_TOOL_SURFACE.ADMIN, 'graphCancel', CONTROL, DEV_TOOL_OWNER.TASK_GRAPH, '{"graphId":"<returned graph id>","reason":"<why the graph is being cancelled>"}', { rpcName: 'dev.task_graph.cancel' }),

  /* This is a host-side dispatcher, not an observation target. It is exposed
     through the Admin surface but has no client/RPC mapping and can never
     participate in another batch. */
  entry('dev.batch.observe', DEV_TOOL_SURFACE.ADMIN, null, OBSERVATION, DEV_TOOL_OWNER.DEV_RUNTIME, '{"calls":[{"tool":"<batch-eligible observation tool>","arguments":{}}]}', { batchPolicy: NEVER }),
];

/* The fail-closed rule itself, exported so it is a tested contract rather than
   an unreachable guard: only an observation that explicitly opted in is ever
   batch-eligible. Anything else -- another class, a missing value, an unknown
   value -- is `never`. */
export function devBatchPolicyFor(operationClass, requested) {
  if (operationClass !== OBSERVATION) return NEVER;
  return requested === BATCHABLE ? BATCHABLE : NEVER;
}

function entry(publicName, surface, clientMethod, operationClass, owner, argumentContract, { rpcName = null, batchPolicy = NEVER, batchArgumentValidator = null } = {}) {
  if (!publicName || !surface || !operationClass || !owner || typeof argumentContract !== 'string') {
    throw new TypeError(`Dev tool contract is incomplete: ${publicName}`);
  }
  if (!OPERATION_CLASSES.has(operationClass)) throw new TypeError(`Unknown operation class for ${publicName}: ${operationClass}`);
  const normalizedBatchPolicy = devBatchPolicyFor(operationClass, batchPolicy);
  if (normalizedBatchPolicy === BATCHABLE && typeof batchArgumentValidator !== 'function') {
    throw new TypeError(`Batchable observation lacks argument validation: ${publicName}`);
  }
  return Object.freeze({
    publicName, surface, clientMethod, operationClass, owner, argumentContract, rpcName,
    batchPolicy: normalizedBatchPolicy,
    batchArgumentValidator: typeof batchArgumentValidator === 'function' ? batchArgumentValidator : null,
  });
}

export const DEV_TOOL_CONTRACTS = Object.freeze(ENTRIES);
const BY_NAME = new Map(ENTRIES.map((item) => [item.publicName, item]));

export function devToolContract(publicName) {
  return BY_NAME.get(String(publicName || '')) || null;
}
export function devToolContractsForSurface(surface) {
  return Object.freeze(ENTRIES.filter((item) => item.surface === surface));
}
export function devToolNamesForSurface(surface) {
  return Object.freeze(devToolContractsForSurface(surface).map((item) => item.publicName));
}
/* Unknown metadata fails closed: a tool the registry does not describe is never
   batch-eligible. */
export function devToolBatchPolicy(publicName) {
  return devToolContract(publicName)?.batchPolicy || NEVER;
}
export function devToolBatchArgumentValidator(publicName) {
  return devToolContract(publicName)?.batchArgumentValidator || null;
}
export function devToolOperationClass(publicName) {
  return devToolContract(publicName)?.operationClass || null;
}
