from pathlib import Path


def once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    print(f'{label}: {count}')
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    p.write_text(text.replace(old, new, 1))


A = 'js/userscript/chatgpt-adapter.js'
once(A,
    '  isGenerating() { return !!this.stopButton(); }',
    '''  isGenerating() {
    const stop = this.stopButton();
    return !!stop
      && stop.isConnected !== false
      && !stop.disabled
      && stop.getAttribute?.('aria-disabled') !== 'true';
  }''',
    'adapter-generating')

once(A,
    '  constructor(adapter, { quietMs = 1500, pollMs = 120, startTimeoutMs = 10000, conversationGraceMs = 3000, submissionMismatchGraceMs = 1500 } = {}) {',
    '''  constructor(adapter, {
    quietMs = 1500,
    pollMs = 120,
    startTimeoutMs = 10000,
    conversationGraceMs = 3000,
    submissionMismatchGraceMs = 1500,
    structuredCompletionQuietMs = 1000,
  } = {}) {''',
    'adapter-constructor')

once(A,
    '    this.submissionMismatchGraceMs = submissionMismatchGraceMs;',
    '''    this.submissionMismatchGraceMs = submissionMismatchGraceMs;
    this.structuredCompletionQuietMs = structuredCompletionQuietMs;''',
    'adapter-structured-assignment')

once(A,
    '  async run(prompt, { signal, timeoutMs = 110000, expectedConversation = null, newConversation = expectedConversation === null, onConversation } = {}) {',
    '''  async run(prompt, {
    signal,
    timeoutMs = 110000,
    expectedConversation = null,
    newConversation = expectedConversation === null,
    onConversation,
    completionMode = null,
  } = {}) {''',
    'adapter-run-options')

once(A,
    "    let latest = '', latestId = null, lastChangedAt = Date.now(), sawGenerating = this.adapter.isGenerating(), observedConversation = expectedConversation;",
    '''    let latest = '', latestId = null, lastChangedAt = Date.now(), sawGenerating = this.adapter.isGenerating(), observedConversation = expectedConversation;
    let structuredPayload = null, structuredStableSince = null, structuredStopIssued = false;''',
    'adapter-structured-state')

once(A,
    '          const settledFor = Date.now() - lastChangedAt;',
    '''          // Dev Supervisor responses have a stricter contract than ordinary Chat
          // or Worker prose: exactly one JSON object. A real iPad Safari trace
          // showed the complete JSON decision become visible, then ChatGPT
          // re-lit its Stop control and appended only a renderer cursor "_" for
          // about 112 seconds. Preserve a stable parsed object across cursor-only
          // DOM churn, then stop only this verified Hex-owned generation.
          const structured = completionMode === 'single-json-object'
            ? extractSingleJsonObject(turn.text)
            : null;
          if (structured !== structuredPayload) {
            structuredPayload = structured;
            structuredStableSince = structured ? Date.now() : null;
            structuredStopIssued = false;
          }
          const structuredSettledFor = structuredPayload && structuredStableSince !== null
            ? Date.now() - structuredStableSince
            : 0;
          if (structuredPayload && structuredSettledFor >= this.structuredCompletionQuietMs) {
            if (this.adapter.isGenerating()) {
              if (!structuredStopIssued) {
                structuredStopIssued = this.stopOwnedGeneration({
                  requestUserTurn,
                  normalizedPrompt,
                  observedConversation,
                });
              }
            } else {
              if (observedConversation && !conversation) {
                await delay(this.pollMs, signal);
                continue;
              }
              const identity = conversation || observedConversation;
              if (identity || structuredSettledFor >= Math.max(this.structuredCompletionQuietMs, this.conversationGraceMs)) {
                completed = true;
                return { text: structuredPayload, conversation: identity || null, turnId: turn.id };
              }
            }
          }

          const settledFor = Date.now() - lastChangedAt;''',
    'adapter-structured-settle')

once(A,
    '\nexport function normalizeModel(label) {',
    '''
function extractSingleJsonObject(value) {
  const text = String(value || '').trimStart();
  if (!text.startsWith('{')) return null;
  const close = text.lastIndexOf('}');
  if (close <= 0) return null;
  const candidate = text.slice(0, close + 1);
  const suffix = text.slice(close + 1);
  // Only known streaming cursor/decorative glyphs are tolerated.
  // Prose, Markdown, a second object, or any other token remains in-flight.
  if (!/^[\\s_▌▍▎▏▋▊▉█▮▯▰]*$/u.test(suffix)) return null;
  let parsed;
  try { parsed = JSON.parse(candidate); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return candidate.trim();
}

export function normalizeModel(label) {''',
    'adapter-json-extractor')

B = 'js/userscript/chatgpt-bridge.js'
once(B,
    'const DEFAULT_LATE_BINDING_WAIT_MS = 2500;',
    '''const DEFAULT_LATE_BINDING_WAIT_MS = 2500;
const DEV_SUPERVISOR_PROMPT_PREFIX = 'HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1';''',
    'bridge-dev-prefix')

once(B,
    "        const result = await turns.run(String(prompt || ''), {",
    '''        const requestPrompt = String(prompt || '');
        const result = await turns.run(requestPrompt, {''',
    'bridge-request-prompt')

once(B,
    '          timeoutMs: explicitTimeout(requestOptions.timeoutMs ?? options.timeoutMs) ?? Infinity,',
    '''          // Leave timeout undefined when the caller did not set one so the
          // TurnController's 110 s bound beats the outer 120 s embed RPC.
          timeoutMs: explicitTimeout(requestOptions.timeoutMs ?? options.timeoutMs) ?? undefined,''',
    'bridge-bounded-timeout')

once(B,
    '''          newConversation: routed.isNew === true,
        });''',
    '''          newConversation: routed.isNew === true,
          completionMode: requestPrompt.startsWith(DEV_SUPERVISOR_PROMPT_PREFIX)
            ? 'single-json-object'
            : null,
        });''',
    'bridge-completion-mode')

T = 'tests/chatgpt-web-runtime.mjs'
once(T,
    '''await testTurnCompletionAndStaleProtection();
await testRolelessTurnFallback();
await testCancelTimeoutAndSingleInflight();''',
    '''await testTurnCompletionAndStaleProtection();
await testRolelessTurnFallback();
await testStructuredJsonCompletionStopsStuckGeneration();
await testOrdinaryResponseDoesNotUseStructuredEarlyCompletion();
await testDevSupervisorBridgeSelectsStructuredCompletion();
await testCancelTimeoutAndSingleInflight();''',
    'runtime-test-list')

once(T,
    '\nasync function testCancelTimeoutAndSingleInflight() {',
    r'''
async function testStructuredJsonCompletionStopsStuckGeneration() {
  const conversation = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const decision = '{"type":"tool","tool":"worker.create_chat","arguments":{},"purpose":"prepare Worker"}';
  const state = { generating: false, assistants: [], users: [], turns: [], stopCalls: 0, conversation };
  const assistant = { id: 'hex-assistant', text: '', node: plainNode('hex-assistant') };
  const adapter = turnAdapter(state, () => {
    const user = { id: 'hex-user', text: 'prompt', node: plainNode('hex-user') };
    state.users.push(user); state.turns.push(user); state.generating = true;
    setTimeout(() => {
      assistant.text = decision;
      state.assistants.push(assistant); state.turns.push(assistant);
      state.generating = false;
    }, 4);
    // Exact real-device shape: complete JSON, then cursor-only residue and a
    // re-lit Stop indicator that otherwise remains stuck until the outer RPC dies.
    setTimeout(() => { assistant.text = `${decision}_`; state.generating = true; }, 10);
  });
  const result = await new ChatGPTTurnController(adapter, {
    quietMs: 60, pollMs: 2, startTimeoutMs: 40, structuredCompletionQuietMs: 18,
  }).run('prompt', {
    timeoutMs: 180,
    expectedConversation: conversation,
    completionMode: 'single-json-object',
  });
  assert.equal(result.text, decision, 'cursor-only residue must not enter Supervisor JSON');
  assert.equal(result.turnId, 'hex-assistant');
  assert.equal(state.stopCalls, 1, 'Hex must stop exactly its own stuck Supervisor generation once');
}

async function testOrdinaryResponseDoesNotUseStructuredEarlyCompletion() {
  const conversation = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  const state = { generating: false, assistants: [], users: [], turns: [], stopCalls: 0, conversation };
  const adapter = turnAdapter(state, () => {
    const user = { id: 'hex-user', text: 'ordinary prompt', node: plainNode('hex-user') };
    const assistant = { id: 'hex-assistant', text: '{"looks":"complete"}_', node: plainNode('hex-assistant') };
    state.users.push(user); state.assistants.push(assistant); state.turns.push(user, assistant); state.generating = true;
  });
  await assert.rejects(
    new ChatGPTTurnController(adapter, { quietMs: 5, pollMs: 2, startTimeoutMs: 30, structuredCompletionQuietMs: 8 })
      .run('ordinary prompt', { timeoutMs: 35, expectedConversation: conversation }),
    (error) => error.code === 'timeout',
    'ordinary Chat/Worker output must never use structured early completion',
  );
  assert.equal(state.stopCalls, 1);
}

async function testDevSupervisorBridgeSelectsStructuredCompletion() {
  const makeBridge = (observed) => {
    delete globalThis.__HEX_CHATGPT_BRIDGE__;
    const conversation = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
    return installChatGPTWebBridge({
      adapter: {
        composer: () => ({}), currentSelection: () => ({}), isGenerating: () => false,
        conversation: () => conversation, errorState: () => null, stop() {},
      },
      router: {
        route: async () => ({ conversation, isNew: false }),
        bind: (_key, value) => value,
        binding: () => conversation,
      },
      models: { select: async () => ({}) },
      turns: {
        async run(prompt, options) {
          observed.push({ prompt, options });
          return { text: '{"type":"final","answer":"ok"}', conversation, turnId: `turn-${observed.length}` };
        },
      },
    });
  };

  const devObserved = [];
  const dev = makeBridge(devObserved);
  await dev.request('HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1\n<HEX_DEV_DATA>{}</HEX_DEV_DATA>', { sessionKey: 'dev' });
  assert.equal(devObserved[0].options.completionMode, 'single-json-object');
  assert.equal(devObserved[0].options.timeoutMs, undefined, 'inner TurnController default must stay bounded');

  const normalObserved = [];
  const normal = makeBridge(normalObserved);
  await normal.request('ordinary ChatGPT request', { sessionKey: 'normal' });
  assert.equal(normalObserved[0].options.completionMode, null);
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
}

async function testCancelTimeoutAndSingleInflight() {''',
    'runtime-new-tests')

F = 'tests/fixtures/chatgpt-production-dom.mjs'
once(F,
    '''      stream(assistant, options.chunks, () => {
        showSend();
      });''',
    '''      stream(assistant, options.chunks, () => {
        if (options.stuckGeneratingAfterComplete) {
          // Real iPad trace: complete structured JSON, then ~363 ms later
          // a cursor-only "_" and Stop reappearance with no semantic progress.
          showSend();
          setTimeout(() => {
            const body = assistantBody(assistant);
            const markdown = body.querySelector('.markdown');
            if (markdown) markdown.textContent += (options.stuckCursor || '_');
            showStop();
          }, options.stuckRestartAfterMs ?? 40);
          return;
        }
        showSend();
      });''',
    'fixture-stuck-stream')

once(F,
    '''  document.getElementById('composer-form').addEventListener('click', (event) => {
    if (event.target.closest('[data-testid="send-button"]')) onSend();
  });''',
    '''  document.getElementById('composer-form').addEventListener('click', (event) => {
    if (event.target.closest('[data-testid="send-button"]')) {
      onSend();
      return;
    }
    if (event.target.closest('[data-testid="stop-button"]')) showSend();
  });''',
    'fixture-stop-handler')

P = 'tests/chatgpt-web-production-dom.mjs'
once(P,
    "const SHORT_PROMPT = '短い質問です';",
    '''const SHORT_PROMPT = '短い質問です';
const DEV_SUPERVISOR_PROMPT = 'HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1\\n<HEX_DEV_DATA>{"history":[]}</HEX_DEV_DATA>';''',
    'browser-dev-prompt')

once(P,
    '''    await scenario(context, name, 'a submitted user turn may hydrate after its wrapper appears', {
      prompt: LONG_PROMPT, chatgpt: { userHydrationDelayMs: 120 },
    }, (result) => {''',
    '''    await scenario(context, name, 'a Dev Supervisor JSON decision survives a stuck generating indicator', {
      prompt: DEV_SUPERVISOR_PROMPT,
      chatgpt: { stuckGeneratingAfterComplete: true, stuckRestartAfterMs: 40 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: complete Dev JSON must beat a cursor-only stuck Stop indicator (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER, `${name}: cursor residue must be stripped`);
    });

    await scenario(context, name, 'a submitted user turn may hydrate after its wrapper appears', {
      prompt: LONG_PROMPT, chatgpt: { userHydrationDelayMs: 120 },
    }, (result) => {''',
    'browser-stuck-scenario')
