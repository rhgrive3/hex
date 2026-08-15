/* UI -> AI core bridge. Core is lazy so the workbench remains usable on failure. */
import { createHexAIContext } from './hex-context.js';
import { createLocalEngine } from './local-engine.js';
import { composePrompt } from '../prompts/compose.js';

async function loadCoreRuntime(localContext) {
  const runtimeModule = await import('../runtime.js');
  if (!runtimeModule || typeof runtimeModule.createAIRuntime !== 'function') return null;
  let provider = null;
  try {
    const providerModule = await import('../provider/index.js');
    if (providerModule && typeof providerModule.WorkerAIProvider === 'function') provider = new providerModule.WorkerAIProvider();
  } catch { /* deterministic core remains available */ }
  return runtimeModule.createAIRuntime({ context: localContext, provider });
}

export function createAiEngine(app, options = {}) {
  const localContext = createHexAIContext(app);
  exposeStableIdentityInputs(localContext, app);
  const local = createLocalEngine(app, localContext);
  const loadCore = options.loadCore || loadCoreRuntime;
  let corePromise = null, core = null, sessionId = null;

  const runtime = () => {
    if (!corePromise) corePromise = Promise.resolve().then(() => loadCore(localContext)).then((value) => { core = value || null; return core; }).catch(() => { core = null; return null; });
    return corePromise;
  };

  return {
    id: 'bridge', localContext, runtime,
    proposals: () => (core && core.proposalStore) || null,
    async run(input) {
      const { question, mode, style, scope, signal, onActivity, context } = input;
      const prompt = composePrompt({ mode, style, scope, question, context });
      const engine = await runtime();
      if (engine && typeof engine.turn === 'function') {
        try {
          const result = await engine.turn({ goal: question, mode, style, scope, sessionId, task: prompt.task }, { signal, onActivity: (event) => onActivity && onActivity(event) });
          if (result?.sessionId) sessionId = result.sessionId;
          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          onActivity?.({ type: 'error', label: 'AI core unavailable', detail: String(error?.message || error).slice(0, 120) });
        }
      }
      return local.run(input);
    },
    cancel() { if (core && typeof core.cancel === 'function') core.cancel(); },
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

export default createAiEngine;
