import { DEV_DECISION_POLICY } from '../policy/decision-policy.js';
import { createDevAnalysisScopeRequest } from '../run/analysis-scope.js';
import { bindDevRunIdentity, createDevRun, DEV_RUN_STATUS, transitionDevRun } from '../run/dev-run.js';
import { validateDevSupervisorDecision } from '../protocol/hex-dev-supervisor-v1.js';
import { createDevWorkerToolSurface, DEV_WORKER_TOOL } from '../workers/tool-surface.js';
import { createDevAdminToolSurface, DEV_ADMIN_TOOL } from '../admin/tool-surface.js';

let fallbackSequence = 0;
const RUN_SCOPED_POOL_TOOLS = new Set([
  DEV_ADMIN_TOOL.POOL_CLAIM,
  DEV_ADMIN_TOOL.POOL_START,
  DEV_ADMIN_TOOL.POOL_RELEASE,
]);

export class DevSupervisorV0 {
  constructor({ availableTools = [], workerTools = null, adminTools = null, workerClient = null, idFactory = defaultIdFactory, now = () => new Date().toISOString() } = {}) {
    const client = workerClient || globalThis.__HEX_DEV_WORKER_CLIENT__ || null;
    this.workerTools = workerTools || createDevWorkerToolSurface(client);
    this.adminTools = adminTools || createDevAdminToolSurface(client);
    this.availableTools = Object.freeze([...new Set([
      ...availableTools.map(String),
      ...(this.workerTools?.toolNames || []),
      ...(this.adminTools?.toolNames || []),
    ])]);
    this.idFactory = idFactory;
    this.now = now;
  }

  createRun({ goal, decisionPolicy = DEV_DECISION_POLICY.NORMAL, analysisScope, plan = [], ...identity } = {}) {
    const createdAt = this.now();
    let run = createDevRun({
      ...identity,
      runId: identity.runId || this.idFactory('run'),
      supervisorSessionKey: identity.supervisorSessionKey || this.idFactory('supervisor-session'),
      goal,
      decisionPolicy,
      analysisScope: analysisScope || createDevAnalysisScopeRequest(),
      plan: { items: plan },
      createdAt,
      updatedAt: createdAt,
    });
    run = transitionDevRun(run, DEV_RUN_STATUS.PLANNING, { now: this.now() });
    return run;
  }

  activate(run) {
    return transitionDevRun(run, DEV_RUN_STATUS.ACTIVE, { now: this.now() });
  }

  resume(run) {
    if ([DEV_RUN_STATUS.PLANNING, DEV_RUN_STATUS.WAITING_EVENT, DEV_RUN_STATUS.WAITING_HUMAN, DEV_RUN_STATUS.PAUSED].includes(run.status)) {
      return transitionDevRun(run, DEV_RUN_STATUS.ACTIVE, { now: this.now() });
    }
    return run;
  }

  applyDecision(run, input) {
    const decision = validateDevSupervisorDecision(input, { availableTools: this.availableTools });
    const active = this.resume(run);
    if (decision.type === 'tool') return { run: active, decision };
    if (decision.type === 'human') {
      return { run: transitionDevRun(active, DEV_RUN_STATUS.WAITING_HUMAN, { now: this.now() }), decision };
    }
    if (decision.type === 'wait') {
      return { run: transitionDevRun(active, DEV_RUN_STATUS.WAITING_EVENT, { now: this.now() }), decision };
    }
    const finalStatus = decision.remaining.length ? DEV_RUN_STATUS.PAUSED : DEV_RUN_STATUS.COMPLETED;
    return { run: transitionDevRun(active, finalStatus, { now: this.now() }), decision };
  }

  async executeToolDecision(run, input) {
    const applied = this.applyDecision(run, input);
    if (applied.decision.type !== 'tool') throw new TypeError('executeToolDecision requires a Dev tool decision.');
    if (this.adminTools?.has(applied.decision.tool)) {
      const argumentsForTool = runtimeOwnedAdminArguments(applied.run, applied.decision);
      const result = await this.adminTools.execute(applied.decision.tool, argumentsForTool);
      return Object.freeze({ run: applied.run, decision: applied.decision, result });
    }
    if (!this.workerTools?.has(applied.decision.tool)) {
      throw new TypeError(`No Dev tool executor is registered for: ${applied.decision.tool}`);
    }
    let runtimeRun = applied.run;
    if (applied.decision.tool !== DEV_WORKER_TOOL.DISCOVER && !runtimeRun.workerId) {
      runtimeRun = bindDevRunIdentity(runtimeRun, { workerId: this.idFactory('worker') }, { now: this.now() });
    }
    const argumentsForTool = runtimeOwnedWorkerArguments(runtimeRun, applied.decision);
    const result = await this.workerTools.execute(applied.decision.tool, argumentsForTool);
    return Object.freeze({
      run: this.bindWorkerResult(runtimeRun, result),
      decision: applied.decision,
      result,
    });
  }

  bindWorkerResult(run, result) {
    if (!result || typeof result !== 'object') return run;
    const patch = {};
    /* Worker output is evidence, not authority. The active DevRun identity was
       injected into the call before dispatch and must never be replaced by a
       returned workerId, including one supplied by a stale or hostile Worker. */
    if (result.tabNodeId != null) patch.tabNodeId = result.tabNodeId;
    if (result.chatgptConversationId != null) patch.chatgptConversationId = result.chatgptConversationId;
    return Object.keys(patch).length ? bindDevRunIdentity(run, patch, { now: this.now() }) : run;
  }
}

function runtimeOwnedAdminArguments(run, decision) {
  const supplied = decision?.arguments && typeof decision.arguments === 'object' && !Array.isArray(decision.arguments)
    ? decision.arguments
    : {};
  const args = { ...supplied };
  if (!RUN_SCOPED_POOL_TOOLS.has(decision?.tool)) return args;

  const runId = requiredRuntimeIdentity(run?.runId, 'runId');
  rejectIdentityOverride(args.runId, runId, 'runId');
  args.runId = runId;
  return args;
}

function runtimeOwnedWorkerArguments(run, decision) {
  const supplied = decision?.arguments && typeof decision.arguments === 'object' && !Array.isArray(decision.arguments)
    ? decision.arguments
    : {};
  const args = { ...supplied };
  if (decision?.tool === DEV_WORKER_TOOL.DISCOVER) return args;

  const runId = requiredRuntimeIdentity(run?.runId, 'runId');
  const workerId = requiredRuntimeIdentity(run?.workerId, 'workerId');
  rejectIdentityOverride(args.runId, runId, 'runId');
  rejectIdentityOverride(args.workerId, workerId, 'workerId');
  args.runId = runId;
  args.workerId = workerId;
  return args;
}

function rejectIdentityOverride(supplied, authoritative, field) {
  if (supplied == null) return;
  if (String(supplied) !== authoritative) {
    throw new TypeError(`Dev Worker tool may not override runtime-owned ${field}.`);
  }
}

function requiredRuntimeIdentity(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`DevRun ${field} is required for Worker tool execution.`);
  return text;
}

function defaultIdFactory(kind) {
  const prefix = String(kind || 'id').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return `${prefix}-${globalThis.crypto.randomUUID()}`;
  fallbackSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}
