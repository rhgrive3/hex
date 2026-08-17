from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'expected patch anchor missing: {path}')
    p.write_text(text.replace(old, new, 1))


path = 'js/userscript/dev/worker-host/worker-chat-controller.js'
old = """    if (currentAnchors.length) this.rememberConversationAnchors(conversation, currentAnchors);\n    return conversation;\n  }\n\n  workerConversation() {\n"""
new = """    if (currentAnchors.length) this.rememberConversationAnchors(conversation, currentAnchors);\n    return conversation;\n  }\n\n  adoptCurrentConversation() {\n    const value = this.adapter.conversation?.() || null;\n    if (!value?.id || !value?.url) return null;\n    if (this.adapter.isGenerating?.()) return null;\n    if (!this.adapter.composer?.()) return null;\n    const currentAnchors = this.currentUserAnchors();\n    if (!currentAnchors.length) return null;\n\n    // worker.claim runs only after the owned Supervisor model turn has settled.\n    // On iPad/WebKit, older remembered user turns may already be virtualized by\n    // then even though the current route, composer and latest Supervisor turn\n    // are live. Re-adopt only this settled visible surface and replace stale\n    // historical hydration requirements with the anchors that are authoritative\n    // now. Ordinary navigation keeps the stricter currentConversation() policy.\n    const conversation = { id: String(value.id), url: String(value.url) };\n    this.rememberConversationAnchors(conversation, currentAnchors);\n    return conversation;\n  }\n\n  workerConversation() {\n"""
replace(path, old, new)

path = 'js/userscript/dev/single-tab/single-conversation-worker-coordinator.js'
replace(path,
    "const EVENT_QUEUE_LIMIT = 128;\nconst TERMINAL_KINDS = new Set(['completed', 'failed', 'cancelled']);\n",
    "const EVENT_QUEUE_LIMIT = 128;\nconst SUPERVISOR_CLAIM_TIMEOUT_MS = 30000;\nconst TERMINAL_KINDS = new Set(['completed', 'failed', 'cancelled']);\n")
old = """    if (this.claimed) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The single-tab Worker slot is already claimed.');\n    const supervisorConversation = await waitFor(() => this.controller.currentConversation() || null, 3000);\n    if (!supervisorConversation?.id) {\n"""
new = """    if (this.claimed) {\n      if (this.claimed.runId === normalizedRun && this.claimed.workerId === normalizedWorker) {\n        return this.withIdentity({\n          state: this.controller.observe().state,\n          claimed: true,\n          replayed: true,\n        });\n      }\n      throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY, 'The single-tab Worker slot is already claimed.');\n    }\n    const supervisorConversation = await waitFor(() => {\n      if (typeof this.controller.adoptCurrentConversation === 'function') {\n        return this.controller.adoptCurrentConversation() || null;\n      }\n      return this.controller.currentConversation() || null;\n    }, SUPERVISOR_CLAIM_TIMEOUT_MS);\n    if (!supervisorConversation?.id) {\n"""
replace(path, old, new)

replace('js/userscript/dev/parent-rpc.js',
    'export function createDevWorkerParentRpcClient({ port, timeoutMs = 20000 } = {}) {',
    'export function createDevWorkerParentRpcClient({ port, timeoutMs = 60000 } = {}) {')

path = 'js/ai/dev/supervisor/dev-supervisor-engine-v0.js'
replace(path,
    """    let workerClaimed = false;\n\n    try {\n""",
    """    let workerClaimed = false;\n    let workerClaimAttempted = false;\n\n    try {\n""")
replace(path,
    """          input.onActivity?.({ label: decision.tool, detail: decision.purpose });\n          const executed = await this.supervisor.executeToolDecision(run, decision);\n          run = executed.run;\n          if (decision.tool === DEV_WORKER_TOOL.CLAIM) workerClaimed = true;\n""",
    """          input.onActivity?.({ label: decision.tool, detail: decision.purpose });\n          if (decision.tool === DEV_WORKER_TOOL.CLAIM) workerClaimAttempted = true;\n          const executed = await this.supervisor.executeToolDecision(run, decision);\n          run = executed.run;\n          if (decision.tool === DEV_WORKER_TOOL.CLAIM) {\n            workerClaimed = true;\n            workerClaimAttempted = false;\n          }\n""")
old = """    } catch (error) {\n      if (workerClaimed) {\n        try {\n          run = await this.releaseWorker(run);\n          this.settings.setLastRun(run);\n        } catch (cleanupError) {\n          try { error.workerCleanupError = String(cleanupError?.message || cleanupError); } catch {}\n        }\n      }\n      throw error;\n    }\n"""
new = """    } catch (error) {\n      if (workerClaimed || workerClaimAttempted) {\n        try {\n          run = await this.releaseWorker(run);\n          workerClaimed = false;\n          workerClaimAttempted = false;\n        } catch (cleanupError) {\n          try { error.workerCleanupError = String(cleanupError?.message || cleanupError); } catch {}\n        }\n      }\n      const terminal = error?.name === 'AbortError' || error?.code === 'cancelled'\n        ? DEV_RUN_STATUS.CANCELLED\n        : DEV_RUN_STATUS.FAILED;\n      if (![DEV_RUN_STATUS.COMPLETED, DEV_RUN_STATUS.FAILED, DEV_RUN_STATUS.CANCELLED].includes(run.status)) {\n        try { run = transitionDevRun(run, terminal, { now: this.supervisor.now() }); } catch {}\n      }\n      this.settings.setLastRun(run);\n      throw error;\n    }\n"""
replace(path, old, new)

path = 'tests/userscript-dev-worker-runtime.mjs'
replace(path,
    'await testRealControllerDefersBlankChatAndWaitsForSupervisorHydration();\n',
    'await testRealControllerDefersBlankChatAndWaitsForSupervisorHydration();\nawait testClaimAdoptsVirtualizedSupervisorSurface();\n')
marker = "\nfunction delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }\n"
test = r'''
async function testClaimAdoptsVirtualizedSupervisorSurface() {
  const supervisor = { id: 'supervisor-virtualized', url: 'https://chatgpt.com/c/supervisor-virtualized' };
  let users = [
    { id: 'old-supervisor-a', text: 'old A' },
    { id: 'old-supervisor-b', text: 'old B' },
  ];
  const adapter = {
    document: { visibilityState: 'visible', body: null, documentElement: null },
    conversation: () => ({ ...supervisor }),
    userTurns: () => users.map((turn) => ({ ...turn })),
    conversationTurns: () => users.map((turn) => ({ ...turn })),
    assistantTurns: () => [],
    composer: () => ({}),
    isGenerating: () => false,
  };
  const controller = new WorkerChatController({ adapter, router: {}, turns: {} });
  assert.equal(controller.currentConversation()?.id, supervisor.id, 'fixture must first remember the fully hydrated Supervisor history');

  users = [{ id: 'latest-supervisor', text: 'latest Dev Supervisor request' }];
  assert.equal(controller.currentConversation(), null, 'strict passive hydration must reject a surface missing remembered historical turns');

  const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'virtualized-same-tab' });
  const claimed = await coordinator.claim({ runId: 'run-virtualized', workerId: 'worker-virtualized' });
  assert.equal(claimed.supervisorChatgptConversationId, supervisor.id, 'claim must adopt the settled current Supervisor surface despite virtualized old turns');
  assert.equal(controller.currentConversation()?.id, supervisor.id, 'adoption must replace stale historical continuity anchors with the live surface');

  const replayed = await coordinator.claim({ runId: 'run-virtualized', workerId: 'worker-virtualized' });
  assert.equal(replayed.replayed, true, 'an ambiguous/replayed identical claim must be idempotent');
  await assert.rejects(
    () => coordinator.claim({ runId: 'other-run', workerId: 'other-worker' }),
    (error) => error.code === 'worker-busy',
    'idempotency must never let another run steal a claimed Worker',
  );
  coordinator.close();
}
'''
replace(path, marker, test + marker)

path = 'tests/dev-agent/round2-single-tab-supervisor.mjs'
replace(path,
    'await testRuntimeRejectsWorkerIdentityOverride();\n',
    'await testRuntimeRejectsWorkerIdentityOverride();\nawait testAmbiguousClaimFailureCleansUpAndFailsRun();\n')
marker = '\nasync function testWaitingHumanResumesSameSupervisorRun() {'
test = r'''

async function testAmbiguousClaimFailureCleansUpAndFailsRun() {
  const ops = [];
  const client = createWorkerClient(ops);
  client.claim = async (args) => {
    ops.push({ op: 'claim', args });
    const error = new Error('Dev Worker RPC timed out: dev.worker.claim');
    error.code = 'transport-failure';
    throw error;
  };
  const supervisor = new DevSupervisorV0({
    workerClient: client,
    idFactory: (kind) => ({ run: 'ambiguous-run', worker: 'ambiguous-worker', 'supervisor-session': 'ambiguous-supervisor' }[kind] || `${kind}-id`),
    now: () => '2026-08-17T00:00:00.000Z',
  });
  const settings = devSettings();
  const bridge = {
    async request() {
      return { text: JSON.stringify({ type: 'tool', tool: 'worker.claim', arguments: {}, purpose: 'claim once' }) };
    },
  };
  const engine = new DevSupervisorEngineV0({ supervisor, settings, bridge });
  await assert.rejects(
    () => engine.run({ mode: 'agent', question: 'claim safely', conversationId: 'hex-ambiguous' }),
    /timed out/,
  );
  assert.equal(ops.filter((item) => item.op === 'claim').length, 1);
  assert.equal(ops.filter((item) => item.op === 'release').length, 1, 'ambiguous claim failure must attempt deterministic cleanup');
  assert.equal(settings.lastRun.status, DEV_RUN_STATUS.FAILED, 'failed Dev tooling must not leave a phantom ACTIVE run');
}
'''
replace(path, marker, test + marker)
