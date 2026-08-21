/* CARD I2: deterministic context selection.
   Smaller is not the pass condition. These fixtures exist to prove the opposite
   property: that the parts a decision actually depends on -- constraints,
   unknowns, negative evidence, required facts -- survive every budget, and that
   an omission is always recorded rather than quietly performed. */
import assert from 'node:assert/strict';
import { createDevContextPacket, createDevWorkerResult } from '../../js/ai/dev/protocol/context-packet.js';
import {
  DEV_OMISSION_REASON,
  DEV_SELECTION_BLOCKER,
  selectDevContext,
} from '../../js/ai/dev/protocol/context-selection.js';
import { DEV_PROMPT_MODE, buildDevSupervisorPrompt } from '../../js/ai/dev/protocol/dev-supervisor-prompt.js';

const CONSTRAINT = 'never merge to main directly';
const FORBIDDEN = 'do not enable auto-merge';
const STOP = 'stop if the lease is superseded';
const UNKNOWN = 'whether webkit CI is flaky on this runner';
const NEGATIVE = 'viewport-mobile-state failed on webkit but passed on chromium with identical content';

function packet(extra = {}) {
  return createDevContextPacket({
    orchestrationRunId: 'run-1', taskId: 'task-1', role: 'worker',
    objective: 'land CARD I2 without losing evidence',
    successCriteria: ['dev-agent gate green', 'no model call added'],
    scope: 'js/ai/dev',
    constraints: [CONSTRAINT],
    forbiddenActions: [FORBIDDEN],
    stopConditions: [STOP],
    unknowns: [UNKNOWN],
    knownFailures: [NEGATIVE],
    requiredEvidence: ['exact-head CI result'],
    ...extra,
  });
}

function bulk(size, seed) {
  return `${seed}:${'x'.repeat(size)}`;
}

function criticalContextSurvivesEveryBudgetThatIsSatisfiable() {
  const source = packet({
    artifactRefs: [
      { ref: 'reports/huge.log', kind: 'log', excerpt: bulk(4000, 'log') },
      { ref: 'reports/other.log', kind: 'log', excerpt: bulk(4000, 'other') },
    ],
    contextDelta: ['the composer selector moved'],
    dependencyResults: [{ taskId: 'dep-1', state: 'SUCCEEDED', summary: bulk(2000, 'dep') }],
  });
  const unbounded = selectDevContext({ packet: source });
  assert.equal(unbounded.blocker, null);

  // Tighten the budget until only the protected core fits.
  const core = selectDevContext({ packet: source, budgetBytes: 900 });
  assert.equal(core.blocker, null, 'the core alone must still fit at a tight budget');
  assert.deepEqual(core.packet.constraints, [CONSTRAINT], 'hard constraints survive a tight budget');
  assert.deepEqual(core.packet.forbiddenActions, [FORBIDDEN], 'forbidden actions survive');
  assert.deepEqual(core.packet.stopConditions, [STOP], 'stop conditions survive');
  assert.deepEqual(core.packet.unknowns, [UNKNOWN], 'unknowns survive');
  assert.deepEqual(core.packet.knownFailures, [NEGATIVE], 'negative evidence survives');
  assert.deepEqual(core.packet.requiredEvidence, ['exact-head CI result']);
  assert.equal(core.packet.objective, source.objective);
  assert.deepEqual(core.packet.successCriteria, [...source.successCriteria]);
  assert.ok(core.bytes <= 900);
  assert.ok(core.bytes < unbounded.bytes, 'the tight selection is materially smaller');

  // Bulk lost its excerpt before anything critical was touched, and the omission
  // is recorded with the ref preserved.
  const reasons = new Set(core.omitted.map((item) => item.reason));
  assert.ok(
    reasons.has(DEV_OMISSION_REASON.OVER_BUDGET) || reasons.has(DEV_OMISSION_REASON.EXCERPT_OVER_BUDGET),
    'bulk evidence is what gets dropped',
  );
  for (const omission of core.omitted) {
    assert.notEqual(omission.section, 'constraints');
    assert.notEqual(omission.section, 'unknowns');
    assert.notEqual(omission.section, 'knownFailures');
  }
}

function bulkExcerptsBecomeRefsBeforeAnythingIsLost() {
  const source = packet({
    artifactRefs: [{ ref: 'reports/huge.log', kind: 'log', excerpt: bulk(3000, 'log') }],
  });
  const full = selectDevContext({ packet: source });
  assert.equal(full.packet.artifactRefs[0].excerpt.length, bulk(3000, 'log').length, 'with no budget nothing is trimmed');

  // A budget that fits the reference but not the excerpt keeps the reference.
  const budget = full.bytes - 1500;
  const trimmed = selectDevContext({ packet: source, budgetBytes: budget });
  assert.equal(trimmed.blocker, null);
  assert.equal(trimmed.packet.artifactRefs.length, 1, 'the reference to omitted bulk is preserved');
  assert.equal(trimmed.packet.artifactRefs[0].ref, 'reports/huge.log');
  assert.equal(trimmed.packet.artifactRefs[0].excerpt, null, 'only the bulk excerpt was given up');
  assert.ok(trimmed.omitted.some((item) => item.ref === 'reports/huge.log' && item.reason === DEV_OMISSION_REASON.EXCERPT_OVER_BUDGET));
  assert.ok(trimmed.bytes < full.bytes);
}

function fresherOwningSystemFactWinsWithoutErasingTheConflict() {
  const source = packet({
    authoritativeFacts: [
      { statement: 'main is at abc123', source: 'cached-status', authority: 'cache', observedAt: '2026-08-20T09:00:00.000Z' },
      { statement: 'main is at abc123', source: 'git', authority: 'owning-system', observedAt: '2026-08-20T11:00:00.000Z', conflictsWith: ['cached-status'] },
      { statement: 'the branch is behind', source: 'git', authority: 'owning-system', observedAt: '2026-08-20T11:00:00.000Z', supersedes: ['stale-branch-note'] },
      { statement: 'the branch is ahead', source: 'stale-branch-note', authority: 'cache', observedAt: '2026-08-20T08:00:00.000Z' },
    ],
  });
  const selection = selectDevContext({ packet: source });

  const statements = selection.packet.authoritativeFacts.map((fact) => fact.statement);
  assert.deepEqual(statements, ['main is at abc123', 'the branch is behind'], 'the stale duplicate and the superseded fact both lose');

  const winner = selection.packet.authoritativeFacts[0];
  assert.equal(winner.authority, 'owning-system', 'the owning system outranks the cache');
  assert.equal(winner.observedAt, '2026-08-20T11:00:00.000Z');
  assert.deepEqual(winner.conflictsWith, ['cached-status'], 'the conflict remains inspectable on the winner');

  // The losers are audit evidence, not deletions.
  const supersededStatements = selection.supersededFacts.map((fact) => fact.statement);
  assert.deepEqual(supersededStatements.sort(), ['main is at abc123', 'the branch is ahead'].sort());
  const staleCache = selection.supersededFacts.find((fact) => fact.source === 'cached-status');
  assert.equal(staleCache.observedAt, '2026-08-20T09:00:00.000Z', 'the loser keeps its own provenance');
  assert.equal(staleCache.authority, 'cache');
  assert.ok(selection.omitted.some((item) => item.reason === DEV_OMISSION_REASON.DUPLICATE));
  assert.ok(selection.omitted.some((item) => item.reason === DEV_OMISSION_REASON.SUPERSEDED));

  /* Equally fresh is the hard case: a cached copy and the owning system observed
     at the same instant. The system that owns the truth wins, and the cached
     copy is still kept as audit evidence. */
  const tied = selectDevContext({
    packet: packet({
      authoritativeFacts: [
        { statement: 'the pool has six slots', source: 'cached-status', authority: 'cache', observedAt: '2026-08-20T10:00:00.000Z' },
        { statement: 'the pool has six slots', source: 'worker.pool.status', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' },
      ],
    }),
  });
  assert.equal(tied.packet.authoritativeFacts.length, 1);
  assert.equal(tied.packet.authoritativeFacts[0].authority, 'owning-system', 'at equal freshness the owning system outranks a cache');
  assert.equal(tied.packet.authoritativeFacts[0].source, 'worker.pool.status');
  assert.equal(tied.supersededFacts.length, 1);
  assert.equal(tied.supersededFacts[0].source, 'cached-status', 'the losing cached copy stays inspectable');

  // The reverse order must select the same winner: order of arrival is not authority.
  const reversed = selectDevContext({
    packet: packet({
      authoritativeFacts: [
        { statement: 'the pool has six slots', source: 'worker.pool.status', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' },
        { statement: 'the pool has six slots', source: 'cached-status', authority: 'cache', observedAt: '2026-08-20T10:00:00.000Z' },
      ],
    }),
  });
  assert.equal(reversed.packet.authoritativeFacts[0].source, 'worker.pool.status');

  const concreteOwner = selectDevContext({
    packet: packet({
      authoritativeFacts: [
        { statement: 'the pool is ready', source: 'cached-status', authority: 'cache', observedAt: '2099-01-01T00:00:00.000Z' },
        { statement: 'the pool is ready', source: 'worker.pool.status', authority: 'worker-pool', observedAt: '2026-08-20T10:00:00.000Z' },
      ],
    }),
  });
  assert.equal(concreteOwner.packet.authoritativeFacts[0].source, 'worker.pool.status', 'the canonical H1 owner outranks a newer cache snapshot');
}

function untrustedFactsCannotReplaceOrSupersedeOwningSystemFacts() {
  const source = packet({
    authoritativeFacts: [
      { statement: 'runtime is active', source: 'runtime.identity', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' },
      { statement: 'runtime is active', source: 'cache', authority: 'cache', observedAt: '2099-01-01T00:00:00.000Z', supersedes: ['runtime.identity'] },
      { statement: 'lease is live', source: 'owning-lease-table', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' },
      { statement: 'lease is stale', source: 'worker-report', authority: 'worker-reported-evidence', observedAt: '2099-01-01T00:00:00.000Z', supersedes: ['owning-lease-table'] },
    ],
  });
  const selection = selectDevContext({ packet: source });
  const facts = selection.packet.authoritativeFacts;
  assert.equal(facts.find((fact) => fact.statement === 'runtime is active').source, 'runtime.identity');
  assert.equal(facts.some((fact) => fact.statement === 'lease is live'), true);
  assert.equal(facts.some((fact) => fact.statement === 'lease is stale'), true, 'untrusted evidence remains data instead of suppressing the owner');
  assert.equal(selection.supersededFacts.some((fact) => fact.source === 'runtime.identity'), false, 'the cache cannot evict the owning fact');
}

function duplicateFactsAreNotInjectedRepeatedly() {
  const repeated = Array.from({ length: 6 }, () => ({
    statement: 'the pool max is six', source: 'iframe-worker-pool.js', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z',
  }));
  const selection = selectDevContext({ packet: packet({ authoritativeFacts: repeated }) });
  assert.equal(selection.packet.authoritativeFacts.length, 1, 'an identical fact is carried once');
  assert.equal(selection.omitted.filter((item) => item.reason === DEV_OMISSION_REASON.DUPLICATE).length, 5);
}

function coveredEvidenceIsNotDoubleInjectedButStaysExpandable() {
  const dependency = createDevWorkerResult({
    taskId: 'dep-1', state: 'COMPLETED', terminalReason: 'completed',
    summary: 'the suite passed; details in the covered log',
    coveredEvidenceRefs: ['reports/dep-1/full.log'],
  });
  const source = packet({
    dependencyResults: [{
      taskId: dependency.taskId, state: dependency.state, terminalReason: dependency.terminalReason,
      summary: dependency.summary, coveredEvidenceRefs: [...dependency.coveredEvidenceRefs],
    }],
    artifactRefs: [
      { ref: 'reports/dep-1/full.log', kind: 'log', excerpt: bulk(3000, 'covered') },
      { ref: 'reports/unrelated.log', kind: 'log', excerpt: 'keep me' },
    ],
  });

  const selection = selectDevContext({ packet: source });
  const refs = selection.packet.artifactRefs.map((item) => item.ref);
  assert.equal(refs.includes('reports/dep-1/full.log'), false, 'the compact summary and its covered source are not both injected');
  assert.equal(refs.includes('reports/unrelated.log'), true, 'uncovered evidence is untouched');
  assert.ok(selection.omitted.some((item) => item.ref === 'reports/dep-1/full.log' && item.reason === DEV_OMISSION_REASON.ALREADY_COVERED));
  assert.deepEqual(
    selection.packet.dependencyResults[0].coveredEvidenceRefs,
    ['reports/dep-1/full.log'],
    'the lineage survives, so the audit expansion path stays available',
  );

  // The audit path: expanding by ref when the task explicitly requires it.
  const expanded = selectDevContext({ packet: source, expandEvidenceRefs: ['reports/dep-1/full.log'] });
  const expandedRef = expanded.packet.artifactRefs.find((item) => item.ref === 'reports/dep-1/full.log');
  assert.ok(expandedRef, 'covered evidence can still be expanded when explicitly required');
  assert.equal(expandedRef.excerpt, bulk(3000, 'covered'), 'expansion returns the real excerpt, not a summary of it');

  // Coverage is only honoured when it was declared. Nothing is guessed.
  const undeclared = packet({
    dependencyResults: [{ taskId: 'dep-2', summary: 'covers everything, honest' }],
    artifactRefs: [{ ref: 'reports/dep-2/full.log', excerpt: 'kept' }],
  });
  const kept = selectDevContext({ packet: undeclared });
  assert.equal(
    kept.packet.artifactRefs.some((item) => item.ref === 'reports/dep-2/full.log'),
    true,
    'without a declared coveredEvidenceRefs, both the summary and the source are kept',
  );

  // If the compact result itself does not fit, its coverage claim cannot hide
  // the source artifact. The source must remain available rather than losing
  // both representations at once.
  const compact = packet({
    dependencyResults: [{ taskId: 'dep-3', summary: bulk(5000, 'too-large'), coveredEvidenceRefs: ['reports/dep-3/full.log'] }],
    artifactRefs: [{ ref: 'reports/dep-3/full.log', excerpt: 'small source' }],
  });
  const coreOnly = selectDevContext({ packet: packet() });
  const artifactOnly = selectDevContext({ packet: packet({ artifactRefs: [{ ref: 'reports/dep-3/full.log', excerpt: 'small source' }] }) });
  const compactDropped = selectDevContext({ packet: compact, budgetBytes: artifactOnly.bytes });
  assert.equal(compactDropped.blocker, null);
  assert.equal(compactDropped.packet.dependencyResults.length, 0, 'the oversized compact result may be omitted');
  assert.equal(compactDropped.packet.artifactRefs[0].ref, 'reports/dep-3/full.log', 'its covered source remains when the compact result is omitted');
  assert.ok(compactDropped.bytes >= coreOnly.bytes);
}

function batchedObservationsKeepTheirOwnProvenance() {
  /* Several observations gathered in one round trip. Transport is not authority:
     each must stay its own fact with its own owner and freshness, never a single
     merged claim that outranks them all. */
  const batched = [
    { statement: 'composer selector is #prompt-textarea', source: 'chatgpt.page.snapshot', authority: 'chatgpt-page', observedAt: '2026-08-20T10:00:00.000Z' },
    { statement: 'three DOM Skills are installed', source: 'chatgpt.skill.list', authority: 'dom-skill-system', observedAt: '2026-08-20T10:00:01.000Z' },
    { statement: 'the pool has six ready slots', source: 'worker.pool.status', authority: 'worker-pool', observedAt: '2026-08-20T10:00:02.000Z' },
  ];
  const selection = selectDevContext({ packet: packet({ authoritativeFacts: batched }) });
  assert.equal(selection.packet.authoritativeFacts.length, 3, 'batched observations are not merged into one synthetic fact');
  for (const [index, fact] of selection.packet.authoritativeFacts.entries()) {
    assert.equal(fact.source, batched[index].source, 'each observation keeps its own source');
    assert.equal(fact.authority, batched[index].authority, 'each observation keeps its own owner');
    assert.equal(fact.observedAt, batched[index].observedAt, 'each observation keeps its own freshness');
  }
  const authorities = new Set(selection.packet.authoritativeFacts.map((fact) => fact.authority));
  assert.equal(authorities.size, 3, 'batching grants no shared or elevated authority');
}

function unsatisfiableBudgetIsAnExplicitBlocker() {
  const source = packet();
  const needed = selectDevContext({ packet: source }).bytes;
  const selection = selectDevContext({ packet: source, budgetBytes: Math.floor(needed / 2) });
  assert.ok(selection.blocker, 'a budget that cannot hold the critical context is a blocker');
  assert.equal(selection.blocker.code, DEV_SELECTION_BLOCKER.CONTEXT_BUDGET_TOO_SMALL);
  assert.match(selection.blocker.message, /Correctness-critical context needs \d+ bytes/);

  // Even while blocked, nothing critical was deleted to pretend success.
  assert.deepEqual(selection.packet.constraints, [CONSTRAINT]);
  assert.deepEqual(selection.packet.unknowns, [UNKNOWN]);
  assert.deepEqual(selection.packet.knownFailures, [NEGATIVE]);
  assert.equal(selection.packet.objective, source.objective);

  assert.throws(() => selectDevContext({ packet: source, budgetBytes: 0 }), TypeError);
  assert.throws(() => selectDevContext({ packet: source, budgetBytes: -1 }), TypeError);
  assert.throws(() => selectDevContext({ packet: null }), TypeError);
}

function repeatedHistoryShrinksWhileTheDecisionSurvives() {
  /* The realistic win: the same facts and the same evidence observed over and
     over across a long run. */
  const repeated = [];
  for (let index = 0; index < 12; index++) {
    repeated.push({ statement: 'the pool max is six', source: 'iframe-worker-pool.js', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' });
    repeated.push({ statement: `attempt ${index} observed`, source: 'graph', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' });
  }
  const source = packet({
    authoritativeFacts: repeated,
    artifactRefs: Array.from({ length: 8 }, (_, index) => ({ ref: `reports/run-${index}.log`, excerpt: bulk(1200, `r${index}`) })),
  });
  const naive = JSON.stringify(source).length;
  const selection = selectDevContext({ packet: source, budgetBytes: 4000 });

  assert.equal(selection.blocker, null);
  assert.ok(selection.bytes < naive / 2, `selection must be materially smaller: ${selection.bytes} vs ${naive}`);
  assert.equal(selection.packet.authoritativeFacts.filter((fact) => fact.statement === 'the pool max is six').length, 1);

  // Everything the decision needs is still there.
  assert.deepEqual(selection.packet.constraints, [CONSTRAINT]);
  assert.deepEqual(selection.packet.forbiddenActions, [FORBIDDEN]);
  assert.deepEqual(selection.packet.stopConditions, [STOP]);
  assert.deepEqual(selection.packet.unknowns, [UNKNOWN]);
  assert.deepEqual(selection.packet.knownFailures, [NEGATIVE]);
  assert.equal(selection.packet.authoritativeFacts.filter((fact) => /^attempt \d+ observed$/.test(fact.statement)).length, 12, 'distinct facts are all kept');
  assert.ok(selection.bytes <= 4000);
}

function selectionMakesNoModelCallOrNetworkAccess() {
  const touched = [];
  const trap = (name) => new Proxy(() => {}, {
    get: () => { touched.push(name); return () => {}; },
    apply: () => { touched.push(name); },
  });
  const globals = ['fetch', 'localStorage', 'sessionStorage', 'indexedDB', 'XMLHttpRequest', 'WebSocket'];
  const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: trap(name) });
  try {
    selectDevContext({
      packet: packet({
        authoritativeFacts: [{ statement: 'f', source: 's', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' }],
        artifactRefs: [{ ref: 'a', excerpt: bulk(500, 'a') }],
        contextDelta: ['d'],
        dependencyResults: [{ taskId: 'dep', summary: 's', coveredEvidenceRefs: ['a'] }],
      }),
      budgetBytes: 2000,
    });
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  assert.deepEqual(touched, [], 'selection is pure host-side computation: no model call, no network, no storage');
}

function utf8BudgetCountsTransportBytes() {
  const selected = selectDevContext({ packet: packet({ objective: '日本語の目的'.repeat(80) }) });
  const json = JSON.stringify(selected.packet);
  assert.equal(selected.bytes, new TextEncoder().encode(json).byteLength, 'budget uses UTF-8 transport bytes');
  assert.ok(selected.bytes > json.length, 'multi-byte text is not counted as one UTF-16 code unit');
}

function continuationCarriesTheSelectedContextAndLineage() {
  const context = packet({ authoritativeFacts: [{ statement: 'fresh fact', source: 'owner', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' }] });
  const prompt = buildDevSupervisorPrompt({
    run: {
      runId: 'run-1', workerId: 'worker-1', goal: context.objective,
      decisionPolicy: 'normal', analysisScope: 'js/ai/dev', status: 'ACTIVE',
    },
    availableTools: ['worker.discover'],
    history: [{ kind: 'tool-result', result: 'fresh' }],
    mode: DEV_PROMPT_MODE.CONTINUATION,
    contextPacket: context,
    contextSelection: {
      schemaVersion: 'hex-dev-context-selection/v1', bytes: 123, budgetBytes: 32768,
      omitted: [{ ref: 'old.log', reason: 'over-budget', section: 'artifactRefs' }],
      supersededFacts: [{ statement: 'old fact', source: 'cache', authority: 'cache', omissionReason: 'duplicate' }],
    },
  });
  const payload = JSON.parse(prompt.match(/<HEX_DEV_DATA>\n([\s\S]*?)\n<\/HEX_DEV_DATA>/)[1]);
  assert.equal(payload.context.objective, context.objective);
  assert.equal(payload.context.authoritativeFacts[0].source, 'owner');
  assert.equal(payload.contextSelection.omitted[0].ref, 'old.log');
  assert.equal(payload.contextSelection.supersededFacts[0].source, 'cache');
}

function selectionIsDeterministic() {
  const source = packet({
    authoritativeFacts: [
      { statement: 'a', source: 'x', authority: 'cache', observedAt: '2026-08-20T09:00:00.000Z' },
      { statement: 'a', source: 'y', authority: 'owning-system', observedAt: '2026-08-20T10:00:00.000Z' },
    ],
    artifactRefs: [{ ref: 'r1', excerpt: bulk(900, 'r1') }, { ref: 'r2', excerpt: bulk(900, 'r2') }],
    contextDelta: ['d1', 'd2'],
  });
  const first = selectDevContext({ packet: source, budgetBytes: 2200 });
  for (let index = 0; index < 5; index++) {
    const again = selectDevContext({ packet: source, budgetBytes: 2200 });
    assert.deepEqual(again.packet, first.packet, 'the same input always selects the same context');
    assert.deepEqual(again.omitted, first.omitted);
    assert.equal(again.bytes, first.bytes);
  }
}

criticalContextSurvivesEveryBudgetThatIsSatisfiable();
bulkExcerptsBecomeRefsBeforeAnythingIsLost();
fresherOwningSystemFactWinsWithoutErasingTheConflict();
untrustedFactsCannotReplaceOrSupersedeOwningSystemFacts();
duplicateFactsAreNotInjectedRepeatedly();
coveredEvidenceIsNotDoubleInjectedButStaysExpandable();
batchedObservationsKeepTheirOwnProvenance();
unsatisfiableBudgetIsAnExplicitBlocker();
repeatedHistoryShrinksWhileTheDecisionSurvives();
selectionMakesNoModelCallOrNetworkAccess();
utf8BudgetCountsTransportBytes();
continuationCarriesTheSelectedContextAndLineage();
selectionIsDeterministic();
console.log('dev context selection: ok');
