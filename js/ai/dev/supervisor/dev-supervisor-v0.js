import { DEV_DECISION_POLICY } from '../policy/decision-policy.js';
import { createDevAnalysisScopeRequest } from '../run/analysis-scope.js';
import { createDevRun, DEV_RUN_STATUS, transitionDevRun } from '../run/dev-run.js';
import { validateDevSupervisorDecision } from '../protocol/hex-dev-supervisor-v1.js';

let fallbackSequence = 0;

export class DevSupervisorV0 {
  constructor({ availableTools = [], idFactory = defaultIdFactory, now = () => new Date().toISOString() } = {}) {
    this.availableTools = Object.freeze([...availableTools].map(String));
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
}

function defaultIdFactory(kind) {
  const prefix = String(kind || 'id').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return `${prefix}-${globalThis.crypto.randomUUID()}`;
  fallbackSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}
