/*
 * UI -> AI core bridge.
 *
 * The core (js/ai/runtime.js, js/ai/provider/*) is owned by the AI Agent Core
 * work stream and is loaded lazily through a dynamic import: the workbench
 * must boot, and the assistant must still answer, even when the core is
 * mid-change, missing, or throwing. Nothing in the UI imports the core
 * statically for that reason.
 *
 * Selection order per turn:
 *   1. AI core runtime (tools, evidence store, proposals, session)
 *   2. local deterministic engine (js/ai/ui/local-engine.js)
 */
import { createHexAIContext } from './hex-context.js';
import { createLocalEngine } from './local-engine.js';
import { composePrompt } from '../prompts/compose.js';

async function loadCoreRuntime(localContext) {
  const runtimeModule = await import('../runtime.js');
  if (!runtimeModule || typeof runtimeModule.createAIRuntime !== 'function') return null;
  let provider = null;
  try {
    const providerModule = await import('../provider/index.js');
    if (providerModule && typeof providerModule.WorkerAIProvider === 'function') {
      provider = new providerModule.WorkerAIProvider();
    }
  } catch { /* no provider: the core still answers deterministically */ }
  return runtimeModule.createAIRuntime({ context: localContext, provider });
}

/**
 * @param {object} app the Hex app
 * @param {{loadCore?: function}} [options] injection point for tests
 * @returns {{run: function, runtime: function, localContext: object, id: string}}
 */
export function createAiEngine(app, options = {}) {
  const localContext = createHexAIContext(app);
  const local = createLocalEngine(app, localContext);
  const loadCore = options.loadCore || loadCoreRuntime;
  let corePromise = null;
  let core = null;
  let sessionId = null;

  const runtime = () => {
    if (!corePromise) {
      corePromise = Promise.resolve()
        .then(() => loadCore(localContext))
        .then((value) => { core = value || null; return core; })
        .catch(() => { core = null; return null; });
    }
    return corePromise;
  };

  return {
    id: 'bridge',
    localContext,
    runtime,
    /** The proposal store, once a core turn has created one. */
    proposals: () => (core && core.proposalStore) || null,

    async run(input) {
      const { question, mode, style, scope, signal, onActivity, context } = input;
      const prompt = composePrompt({ mode, style, scope, question, context });
      const engine = await runtime();
      if (engine && typeof engine.turn === 'function') {
        try {
          const result = await engine.turn({
            goal: question, mode, style, scope, sessionId,
            /* Forward-compatible: normalizeTurnRequest preserves unknown input
               fields, so a core that learns to use the composed prompt gets it
               without another round of UI changes. */
            guidance: prompt.system,
            task: prompt.task,
          }, { signal, onActivity: (event) => onActivity && onActivity(event) });
          if (result && result.sessionId) sessionId = result.sessionId;
          return result;
        } catch (error) {
          if (signal && signal.aborted) throw error;
          if (onActivity) {
            onActivity({ type: 'error', label: 'AI core unavailable', detail: String((error && error.message) || error).slice(0, 120) });
          }
        }
      }
      return local.run(input);
    },

    cancel() { if (core && typeof core.cancel === 'function') core.cancel(); },
  };
}

export default createAiEngine;
