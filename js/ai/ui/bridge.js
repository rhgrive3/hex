/* UI -> AI core bridge. Core is lazy so the workbench remains usable on failure. */
import { createHexAIContext } from './hex-context.js';
import { createLocalEngine } from './local-engine.js';
import { composePrompt } from '../prompts/compose.js';
import { createCapabilityCatalog } from '../capabilities/catalog.js';
import { createCapabilityExecutor } from '../capabilities/executor.js';
import { createProposalExecutor } from '../interaction/proposal-executor.js';

async function loadCoreRuntime(localContext) {
  const runtimeModule = await import('../runtime.js');
  if (!runtimeModule || typeof runtimeModule.createAIRuntime !== 'function') return null;
  let provider = null;
  try {
    // Standalone Web keeps the Worker provider. The userscript host injects a
    // browser-local ChatGPT bridge and owns the ChatGPT/Gemini selection.
    if (globalThis.__HEX_CHATGPT_BRIDGE__) {
      const userscriptModule = await import('../provider/chatgpt-web.js');
      if (userscriptModule && typeof userscriptModule.UserscriptAIProvider === 'function') {
        provider = new userscriptModule.UserscriptAIProvider({ bridge: globalThis.__HEX_CHATGPT_BRIDGE__ });
      }
    }
    if (!provider) {
      const providerModule = await import('../provider/index.js');
      if (providerModule && typeof providerModule.WorkerAIProvider === 'function') provider = new providerModule.WorkerAIProvider();
    }
  } catch { /* deterministic core remains available */ }
  return runtimeModule.createAIRuntime({ context: localContext, provider });
}

export function createAiEngine(app, options = {}) {
  const localContext = createHexAIContext(app);
  exposeStableIdentityInputs(localContext, app);
  exposeRuntimeSessionBinding(localContext);
  const local = createLocalEngine(app, localContext);
  const capabilityCatalog = createCapabilityCatalog();
  const capabilityExecutor = createCapabilityExecutor({ catalog: capabilityCatalog, app, binaryId: () => localContext.binaryId, runtimePlatform: () => localContext.runtime?.platform?.() });
  const loadCore = options.loadCore || loadCoreRuntime;
  let corePromise = null, core = null;
  const sessions = loadConversationBindings();
  let defaultSessionId = null;

  const runtime = () => {
    if (!corePromise) corePromise = Promise.resolve().then(() => loadCore(localContext)).then((value) => { core = value || null; return core; }).catch(() => { core = null; return null; });
    return corePromise;
  };

  return {
    id: 'bridge', localContext, runtime,
    proposals: () => (core && core.proposalStore) || null,
    capabilities: () => capabilityCatalog.list(capabilityExecutor.context()),
    capabilityExecutor,
    proposalExecutor: () => core?.proposalStore ? createProposalExecutor({ store: core.proposalStore, capabilityExecutor, app }) : null,
    async run(input) {
      const { question, mode, style, scope, signal, onActivity, context } = input;
      const conversationKey = input.conversationId == null ? null : String(input.conversationId);
      let sessionId = conversationKey ? (sessions.get(conversationKey) || null) : defaultSessionId;
      const prompt = composePrompt({ mode, style, scope, question, context });
      const engine = await runtime();
      if (engine && typeof engine.turn === 'function') {
        const runCore = () => engine.turn({
          goal: question, mode, style, scope, sessionId, task: prompt.task,
          conversationId: conversationKey, provider: input.provider || null,
          model: input.model || null, reasoning: input.reasoning || null,
        }, { signal, onActivity: (event) => onActivity && onActivity(event) });
        try {
          let result;
          try {
            result = await runCore();
          } catch (error) {
            if (!isSessionBindingMismatch(error)) throw error;
            // A new user turn after a binary/project switch must start a new
            // investigation rather than repeatedly presenting the old session.
            sessionId = null;
            if (conversationKey) { sessions.delete(conversationKey); persistConversationBindings(sessions); } else defaultSessionId = null;
            onActivity?.({ type: 'session-rebind', label: '新しい解析対象へAIセッションを切り替え' });
            result = await runCore();
          }
          if (result?.sessionId) {
            if (conversationKey) { sessions.set(conversationKey, result.sessionId); persistConversationBindings(sessions); }
            else defaultSessionId = result.sessionId;
          }
          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          // Scope/binding failures are safety boundaries. Falling through to a
          // live local engine here would re-run the same turn against a newly
          // visible function/binary and defeat TurnSnapshot semantics.
          if (isSafetyBoundaryError(error)) throw error;
          onActivity?.({ type: 'error', label: 'AI core unavailable', detail: String(error?.message || error).slice(0, 120) });
          // Never label a local/Gemini fallback as a ChatGPT answer.
          if (globalThis.__HEX_CHATGPT_BRIDGE__ && globalThis.__HEX_AI_PROVIDER__ !== 'gemini') throw error;
        }
      }
      return local.run(input);
    },
    cancel() { if (core && typeof core.cancel === 'function') core.cancel(); },
    async createAgentJob(input = {}) {
      const engine = await runtime();
      const key = input.conversationId == null ? null : String(input.conversationId);
      return engine.createJob({ ...input, sessionId: input.sessionId || (key ? sessions.get(key) : defaultSessionId) || null });
    },
    async runAgentJobSlice(jobOrId, options = {}) {
      const engine = await runtime(); const checkpoint = await engine.runJobSlice(jobOrId, options);
      bindJobSession(checkpoint, sessions, (value) => { defaultSessionId = value; }); persistConversationBindings(sessions); return checkpoint;
    },
    async resumeAgentJob(id, options = {}) {
      const engine = await runtime(); const checkpoint = await engine.resumeJob(id, options);
      bindJobSession(checkpoint, sessions, (value) => { defaultSessionId = value; }); persistConversationBindings(sessions); return checkpoint;
    },
    async aiCapabilities(options = {}) {
      const engine = await runtime();
      const provider = engine?.provider;
      return typeof provider?.capabilities === 'function' ? provider.capabilities(options) : { providers: [] };
    },
    async aiStatus() {
      const engine = await runtime();
      const provider = engine?.provider;
      return typeof provider?.status === 'function' ? provider.status() : { ready: !!engine };
    },
    getAISelection() { return core?.provider?.getSelection?.() || null; },
    async setAISelection(selection, options = {}) {
      const engine = await runtime();
      if (typeof engine?.provider?.setSelection !== 'function') throw new Error('The active AI provider does not support model selection.');
      return engine.provider.setSelection(selection, options);
    },
    forgetAIConversation(conversationId) {
      if (conversationId == null) return false;
      const removed = sessions.delete(String(conversationId)); persistConversationBindings(sessions); return removed;
    },
  };
}

function exposeStableIdentityInputs(context, app) {
  // The binary layer already owns content fingerprinting. The AI bridge only
  // consumes cached/project fingerprint output; it never scans a large binary
  // merely to start a turn on iPad.
  const define = (name, get) => {
    if (Object.prototype.hasOwnProperty.call(context, name)) return;
    try { Object.defineProperty(context, name, { enumerable: true, configurable: false, get }); } catch { /* optional */ }
  };
  define('binaryFingerprint', () => {
    const stored = app.store?.get?.('binaryFingerprint') || app.store?.get?.('contentFingerprint') || app.binaryFingerprint || null;
    if (stored?.hash) return stored;
    const projectHash = app.project?.binaryHash || app.currentProject?.binaryHash || null;
    return projectHash ? { algorithm: 'project-content-hash', hash: String(projectHash) } : null;
  });
  define('binaryHash', () => context.binaryFingerprint?.hash || null);
  define('projectId', () => app.project?.id || app.currentProject?.id || app.project?.binaryHash || null);
  define('sliceIndex', () => app.store?.get?.('sliceIndex') ?? null);
  define('architecture', () => app.store?.get?.('architecture') || app.store?.get?.('capability')?.architecture || null);
  define('fileInfo', () => app.store?.get?.('fileInfo') || null);
}

function exposeRuntimeSessionBinding(context) {
  if (!context?.runtime || typeof context.runtime !== 'object') return;
  const state = { binaryId: null, known: false, sessionId: null };
  const originalPlatform = typeof context.runtime.platform === 'function' ? context.runtime.platform.bind(context.runtime) : null;
  const originalVerify = typeof context.runtime.verifyHypothesis === 'function' ? context.runtime.verifyHypothesis.bind(context.runtime) : null;
  const currentBinaryId = () => context.binaryId == null ? null : String(context.binaryId);
  const capture = (platform) => {
    state.binaryId = currentBinaryId();
    state.known = true;
    state.sessionId = platform?.sessions?.current?.id == null ? null : String(platform.sessions.current.id);
    return platform;
  };
  const sameBinary = () => state.binaryId != null && state.binaryId === currentBinaryId();

  if (originalPlatform) {
    context.runtime.platform = async (...args) => capture(await originalPlatform(...args));
  }
  if (originalVerify && originalPlatform) {
    context.runtime.verifyHypothesis = async (...args) => {
      try { return await originalVerify(...args); }
      finally {
        // verifyHypothesis can lazily create the RuntimeAnalysisPlatform. Read
        // back the already-created platform so the next user turn can bind to
        // its concrete session ID without reaching into js/runtime internals.
        try { capture(await originalPlatform()); } catch { /* runtime remains unknown */ }
      }
    };
  }

  const define = (name, get) => {
    if (Object.prototype.hasOwnProperty.call(context, name)) return;
    try { Object.defineProperty(context, name, { enumerable: true, configurable: false, get }); } catch { /* optional */ }
  };
  define('runtimeSessionId', () => sameBinary() ? state.sessionId : null);
  define('runtimeSessionKnown', () => sameBinary() ? state.known : false);
}

function isSessionBindingMismatch(error) {
  return error?.type === 'scope_violation' && /requested AI session belongs to a different binary or project/i.test(String(error?.message || ''));
}
function isSafetyBoundaryError(error) {
  return error?.type === 'scope_violation' || error?.type === 'cancelled' || error?.type === 'context_too_large';
}

function bindJobSession(checkpoint, sessions, setDefault) {
  if (!checkpoint?.sessionId) return;
  if (checkpoint.conversationId != null) sessions.set(String(checkpoint.conversationId), checkpoint.sessionId);
  else setDefault(checkpoint.sessionId);
}

const CONVERSATION_BINDING_KEY = 'hex.ai.conversation-sessions.v1';
function loadConversationBindings() {
  const out = new Map();
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem?.(CONVERSATION_BINDING_KEY) || '{}');
    for (const [conversationId, sessionId] of Object.entries(raw || {})) if (conversationId && typeof sessionId === 'string' && sessionId) out.set(conversationId, sessionId);
  } catch { /* optional persistence */ }
  return out;
}
function persistConversationBindings(bindings) {
  try { globalThis.localStorage?.setItem?.(CONVERSATION_BINDING_KEY, JSON.stringify(Object.fromEntries(bindings))); } catch { /* private mode */ }
}

export default createAiEngine;
